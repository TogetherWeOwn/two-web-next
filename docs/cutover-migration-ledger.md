# Cutover migration ledger (web, offline)

Offline ledger of every web migration in `drizzle/` that the cutover
must run against production, read from the migration SQL and
`drizzle/meta/_journal.json` on `origin/main` (`7e92b7a3`,
22 journal entries, idx 0–21). No database connection was used and no
migration was run to build this document. Numbering and topology live
in [db-migrations.md](db-migrations.md); the bot migration set is a
different ledger and is out of scope here.

Two facts govern every row below. First, all 22 migrations are
**up-only**: Drizzle ships no down files, and the applier
(`ci/neon-migrate.mjs`) moves the `drizzle.__drizzle_migrations` ledger
forward only, refusing any history that is not an exact prefix of the
release. Reversal always means a new compensating migration, never a
built-in down. Second, tag `1015` is absent (the journal goes
`1014` → `1016`); numbers are never reused, so the gap stays empty.

Rollback classes: **re-runnable** (safe to apply again; backout is
trivial or unnecessary), **backout-script** (needs a new compensating
migration; rows written after apply are lost), **unmeasurable** (the
prior state cannot be restored by SQL alone; needs backup/PITR).

| # | Migration | Direction | Tables touched | Rollback class | Backout note |
|---|---|---|---|---|---|
| 0 | `0000_init-users` | up-only | users | backout-script | `DROP TABLE users`; loses member rows written after apply. |
| 1 | `0001_agent-events` | up-only | agent_event_audits, agent_event_grants, agent_event_hits, agent_event_idempotency_keys, agent_events | backout-script | `DROP TABLE` × 5; FKs and indexes drop with the tables. |
| 2 | `1000_join-attempts-throttle` | up-only | join_attempts, web_throttle_hits | backout-script | `DROP TABLE` × 2; throttle telemetry only. |
| 3 | `1001_admin-slice` | up-only | activity_log, events, featured_contents, member_data_access_logs | backout-script | `DROP TABLE` × 4; loses all content and event base rows. |
| 4 | `1002_rsvps` | up-only | rsvps | backout-script | `DROP TABLE rsvps`; loses RSVP rows. |
| 5 | `1003_profiles` | up-only | profiles | backout-script | `DROP TABLE profiles`; loses profile rows. |
| 6 | `1004_job-unique-locks` | up-only | job_unique_locks | backout-script | `DROP TABLE job_unique_locks`; transient locks only. |
| 7 | `1005_event-search-logs` | up-only | event_search_logs | backout-script | `DROP TABLE event_search_logs`; search telemetry only. |
| 8 | `1006_rsvp-synced-at` | up-only | rsvps (nullable `synced_to_discord_at`) | backout-script | `DROP COLUMN synced_to_discord_at`; loses sync timestamps. |
| 9 | `1007_queue-ledger` | up-only | queue_failed_jobs, queue_jobs | backout-script | `DROP TABLE` × 2; loses queued and failed work, so drain queues first. |
| 10 | `1008_agent-event-idempotency-prune-idx` | up-only | agent_event_idempotency_keys (index only) | backout-script | `DROP INDEX agent_event_idempotency_created_at_idx`; no row data. |
| 11 | `1009_event-sync-failure` | up-only | events (two nullable columns) | backout-script | `DROP COLUMN discord_sync_failed_at, discord_sync_failure_code`; loses failure markers. |
| 12 | `1010_rsvp-legacy-order` | up-only | rsvps (nullable `legacy_id`) | backout-script | `DROP COLUMN legacy_id`; loses import keys. |
| 13 | `1011_legacy-audit-evidence` | up-only | activity_log, agent_event_audits, agent_event_grants, agent_event_idempotency_keys | backout-script | `DROP COLUMN` × 8 for the added columns; restoring the two dropped `NOT NULL`s needs a NULL backfill first. |
| 14 | `1012_content-funnel-import-keys` | up-only | join_attempts, event_search_logs, featured_contents | backout-script | Drop the three `UNIQUE` constraints, then the three `legacy_id` columns; loses import keys. |
| 15 | `1013_hot-path-indexes` | up-only | rsvps, events, join_attempts (indexes only) | re-runnable | `CREATE INDEX IF NOT EXISTS` × 5; re-apply is safe, backout is `DROP INDEX IF EXISTS` × 5. |
| 16 | `1014_event-ics-sequence` | up-only | events + `advance_event_ics_sequence()` trigger | backout-script | Drop the trigger, drop the function, drop `ics_sequence`; ICS consumers fall back to `updated_at` ordering. |
| 17 | `1016_job-lock-ownership` | up-only | job_unique_locks (nullable `owner_token`) | backout-script | `DROP COLUMN owner_token`; loses lock ownership, locks expire by timeout. |
| 18 | `1017_queue_failed_job_identity` | up-only | queue_failed_jobs (deletes duplicates, adds unique) | unmeasurable | The `DELETE` permanently removes duplicate ledger rows; backout drops the constraint but only backup/PITR restores them. |
| 19 | `1018_audit-immutability` | up-only | agent_event_audits, member_data_access_logs, activity_log + `audit_rows_append_only()` | backout-script | Drop the six guard triggers and the function; audit tables stay writable until re-guarded. |
| 20 | `1019_shared-agent-events` | up-only | events (columns + copied rows), `agent_events` dropped | unmeasurable | `DROP TABLE agent_events` destroys the wall-clock source table; copied rows survive in `events` but the separate table returns only from backup/PITR. |
| 21 | `1020_event-sync-revisions` | up-only | event_sync_attempts (new), events (two revision columns) + two revision triggers | backout-script | Drop both triggers/functions, drop the attempts table and the two columns; mirrors restart from revision zero. |

## Gated apply path

The sanctioned live apply path is the `db-migrate` workflow
(`.github/workflows/db-migrate.yml`), never a local migrate command:

- Dispatch is `workflow_dispatch` with a `staging`/`production` choice
  (default `staging`), or `workflow_call` from an authorized caller.
- Gates run before any install or database access: the ref must be
  `refs/heads/main`, and `production` requires the
  `PRODUCTION_DEPLOY_ENABLED` variable to be true.
- Secrets come from the matching GitHub Environment only
  (`NEON_STAGING_DATABASE_URL` or `PRODUCTION_DATABASE_URL`); the
  unselected target is never exposed and no fallback URL exists.
- Endpoint rules are enforced in code: direct port `5432`, no pooler;
  staging must be the pinned PlanetScale staging branch and host (direct Neon
  endpoints still accepted during the transition; the production identity is
  refused), production must be a direct PlanetScale endpoint
  (`<id>.pg.psdb.cloud`) with TLS.
- Steps: numbering guard, read-only `plan` (journal/ledger diff, no
  DDL), `apply` under a Postgres transaction advisory lock with the
  pre-apply PITR timestamp recorded, then `verify` proves zero pending
  web migrations.
- Applies never cancel each other: the concurrency group is
  `neon-web-migrate-<target>` with `cancel-in-progress: false`.
- Staging Worker deploys apply the same script for `staging` inside the
  deploy job; live production execution always needs its own
  authorization and is never part of a Worker deploy.
