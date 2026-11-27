# Cutover migration ledger (web, offline)

Offline ledger of every web migration in `drizzle/` that the cutover
must run against production, read from the migration SQL and
`drizzle/meta/_journal.json`. It was pinned at 22 journal entries
(idx 0–21) on `origin/main` (`7e92b7a3`); it is now reconciled to
25 entries (idx 0–24), with the production apply outcome recorded
below. No database connection was used and no
migration was run to build this document. Numbering and topology live
in [db-migrations.md](db-migrations.md); the bot migration set is a
different ledger and is out of scope here.

Two facts govern every row below. First, all 25 migrations are
**up-only**: Drizzle ships no down files, and the applier
(`ci/db-migrate.mjs`) moves the `drizzle.__drizzle_migrations` ledger
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
| 22 | `1021_discord-event-snapshots` | up-only | discord_event_snapshots | backout-script | `DROP TABLE discord_event_snapshots`; display cache only, no canonical rows lost. |
| 23 | `1022_web-sessions-oauth-journeys` | up-only | web_sessions, web_oauth_journeys (columns + indexes) | re-runnable | `CREATE TABLE/INDEX IF NOT EXISTS` throughout plus `ADD COLUMN IF NOT EXISTS` and an `UPDATE` that only fills NULL `status_hash`; re-apply is safe. Live databases already carry these tables from the retired runtime backstop, so no backout applies there — do not `DROP` them (the runtime no longer holds CREATE, dropped sessions and journeys would not rebuild, and the migrate ledger would still report 1022 applied). |
| 24 | `1023_agent-event-audits-prune-idx` | up-only | agent_event_audits (index only) | backout-script | `DROP INDEX agent_event_audits_created_at_idx`; no row data. |

## Production apply outcome

The cutover flipped production to the Next Worker at 2026-10-10
00:52Z: production `/up` reported healthy with `db ok` and **0 pending
migrations**, covering the pinned 22 plus `1021_discord-event-snapshots`
(merged 2026-10-07, in the flipped `15423dc9` release). Zero pending
held through the 2h watch close at 02:52Z, the origin re-run at
03:03Z, the tail samples including 21:47Z, and the 48h close at
2026-10-12 00:57Z. The early-watch auth P0 (session/join 500s) was
host role grants, not pending migrations: `/up` stayed 0 pending
throughout and the funnel recovered per the 01:27Z receipt.
Of rows 22–24, only `1021` was in the flipped release (noted
above); `1022` and `1023` merged afterwards, are recorded here, and
reach production through the normal `db-migrate` path, not through
this outcome.
Nothing here was probed: every production fact is cited from the
production health receipts recorded through the cutover close.

## Gated apply path

The sanctioned live apply path is the `db-migrate` workflow
(`.github/workflows/db-migrate.yml`), never a local migrate command:

- Dispatch is `workflow_dispatch` with a `staging`/`production` choice
  (default `staging`), or `workflow_call` from an authorized caller.
- Gates run before any install or database access: the ref must be
  `refs/heads/main`, staging requires `STAGING_MIGRATION_HOLD` exactly
  `false`, and `production` requires the `PRODUCTION_DEPLOY_ENABLED`
  variable to be true and the run SHA to match `PRODUCTION_MIGRATION_APPROVED_SHA`.
- Secrets come from the matching GitHub Environment only
  (`PLANETSCALE_STAGING_DATABASE_URL` or `PRODUCTION_DATABASE_URL`); the
  unselected target is never exposed and no fallback URL exists.
- Endpoint rules are enforced in code: direct port `5432`, no pooler;
  staging must be the pinned PlanetScale staging branch and host (retired
  Neon endpoints are refused; the production identity is refused),
  production must likewise use the pinned direct host and branch with TLS.
  The production runner checks the actual database and both role identities
  against the [approved fingerprint](runbook.md#neon-web-schema-migrations-separate-operator-action),
  including inside the apply transaction. Production plan and locked apply
  also require the exact next contiguous tags pinned on the protected Environment;
  see the [operator runbook](runbook.md#neon-web-schema-migrations-separate-operator-action).
- Steps: numbering guard, read-only `plan` (journal/ledger diff, no
  DDL), `apply` under a Postgres transaction advisory lock with the
  pre-apply PITR timestamp recorded, then a read-only post-check. Staging
  `verify` proves zero pending web migrations. Production `verify-scope`
  proves the exact approved ledger end and lists deferred tags; it does not
  replace full-release verification.
- Applies never cancel each other: the concurrency group is
  `web-migrate-<target>` with `cancel-in-progress: false`.
- Staging Worker deploys apply the same script for `staging` inside the
  deploy job; live production execution always needs its own
  authorization and is never part of a Worker deploy.

## Current runbook for Web ledger isolation

Use the [production release gate](../CONTRIBUTING.md#production-release-gate)
for each operation. The release thread records the observed ledger, serving
version, approvals and watch results.

1. **Finish the migrator permissions repair at `1033`.** Use the protected
   [executor and repair workflows](runbook.md#repair-production-migrator-permissions-at-the-1033-prefix)
   with their approved source, separate scoped credentials and exact plan
   digests in the `production` Environment. Confirm the repaired catalog,
   unchanged 34-entry canonical ledger and retained Web, Jobs and Bot access.
   Keep the original executor edge and inverse pins through the 30-minute
   repair watch and recovery window. Then verify the protected executor
   `revoke` and cleanup before handing off to ledger isolation.
2. **Put the readiness bridge in service before revoking serving access.**
   Install the [projection](db-migrations.md#install-or-remove-the-readiness-projection)
   while direct ledger access still works. Qualify the compatible Hono build
   and its exact fallback, then use the [protected Worker release](kit-cutover-release.md#protected-release-and-recovery)
   for `cutover_mode: hono` with the approved `sha` and `cutover_pin` and both
   undo inputs empty. When preparing Hono as Ember's rollback, use the
   Ember-profile packet's `sha` and `cutover_pin` for this Hono dispatch.
   Confirm the approved Hono UUID, source and
   manifest at 100% traffic. Verify a fresh, healthy `/up` response reports
   the exact canonical `1033` timestamp set through the projection. Even a
   healthy response with stale or missing timestamps blocks the revoke.
   Verify the actual Web and Jobs bindings and the separate Bot read scopes.
3. **Isolate at `1033`, then advance the schema to `1037`.** Rehearse the exact
   catalog delta and inverse with the approved executor's grantor authority in
   both directions. Dispatch [`db-serving-ledger-isolation`](../.github/workflows/db-serving-ledger-isolation.yml)
   on protected `main` with `operation: forward` and
   `ledger: 1033_session-roles-checked-at`. The `production` Environment holds
   `PRODUCTION_DB_ISOLATION_APPROVED_SHA`, `PRODUCTION_DB_ISOLATION_DATABASE_URL`,
   `PRODUCTION_DB_ISOLATION_PLAN` and `PRODUCTION_DB_ISOLATION_PLAN_SHA256`.
   Forward also uses `PRODUCTION_DB_ISOLATION_CF_ACCOUNT_ID` and
   `PRODUCTION_DB_ISOLATION_CF_READ_TOKEN`. Verify direct ledger denial,
   projected readiness and retained Web, Jobs and Bot access, then finish the
   isolation watch. Under separate approval and verified schema recovery,
   dispatch `db-migrate` with `target: production` and `readback_only: false`.
   Pin the exact dispatch SHA and migrator identity in the
   [migration Environment](runbook.md#neon-web-schema-migrations-separate-operator-action).
   Pin `1034_event-echoes`, `1035_bot-reconciliation-intents`,
   `1036_event-sync-claim-started` and `1037_waitlist-offers` in that order.
   Record the `verify-scope` result for the 38-entry canonical ledger and
   keep `1038_announcement-send-claims` deferred for this cutover. Finish the
   migration watch.
4. **Keep recovery tied to the observed prefix.** For the schema advance, use
   a fresh PlanetScale backup restored to an isolated temporary branch. Verify
   the ordered ledger and affected objects at the real access levels, rehearse
   the approved recovery with outbound activity disabled, and verify same-day
   branch and credential cleanup. Retain only redacted results. For an
   uncertain isolation result, use `readback` against the actual canonical end
   and resolve any unclassified state before retrying. A failed step that says
   the isolation or inverse committed confirms the database acknowledged the
   mutation before connection cleanup failed. Use `readback` to verify the
   expected state and investigate cleanup before continuing. For a grant
   regression, run the protected `undo` with the same plan and authority and
   select the actual end, `1033_session-roles-checked-at` or
   `1037_waitlist-offers`. `readback` and `undo` can use the approved `main`
   ancestor while the dispatcher and its selector are unchanged. Pin the
   revised dispatcher when approving the forward change so the same pin
   remains usable for recovery. Verify that undo restored the exact pre-isolation
   grants and direct ledger access while preserving the permissions repair and
   the observed ledger. If required,
   use [`rollback-production`](../.github/workflows/rollback-production.yml)
   with `environment: production`, the recorded direct-ledger Hono UUID as
   `version_id`, and the serving UUID as `expected_current_version_id`.
   Verify the fallback serves all traffic and `/up` reads the ledger directly
   before running the separate projection inverse. Use the
   [migration recovery procedure](runbook.md#migration-rollback-and-recovery)
   for uncertain schema commits or schema regression. The grant inverse leaves
   the applied schema in place. After undo at `1037`, re-isolation requires a
   separately reviewed operation because `forward` only admits `1033`.
5. **Hand off explicitly to the Ember release.** After the repair, isolation
   and migration watches pass, pass along the observed `1037` ledger and `1038`
   deferral, healthy `/up`, effective access results, database recovery receipts,
   and the serving Hono commit, UUID and manifest binding. For a bridge prepared
   with an all-off packet, prepare the paired Hono version from the Ember
   packet in the Ember release before switching. Verify the live Hono rollback
   UUID matches the Ember packet's source and manifest digest. Under separate
   Ember release approval, dispatch `cutover_mode: ember` with the same `sha`
   and `cutover_pin` used to prepare that Hono and its UUID as
   `cutover_undo_version`. Leave
   `cutover_undo_digest` empty and `migrations_applied` off for Ember. Follow the
   [Kit cutover and recovery runbook](kit-cutover-release.md#protected-release-and-recovery).

The [grant runner](https://github.com/TogetherWeOwn/two-web-next/pull/2753) and
[protected dispatcher](https://github.com/TogetherWeOwn/two-web-next/pull/2757)
define the isolation operations. Hosted fixtures exercise cross-version grant
undo and stale or absent readiness timestamps
([#2782](https://github.com/TogetherWeOwn/two-web-next/pull/2782)), and refusal
when `/up` shows `1037` but omits the required `1033` timestamp
([#2790](https://github.com/TogetherWeOwn/two-web-next/pull/2790)). The
[PostgreSQL 18 restore replay](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45618685153/job/139220728278)
in [#2816](https://github.com/TogetherWeOwn/two-web-next/pull/2816) exercises
repair, isolation, expansion and grant undo on one synthetic restore. It
verifies repaired ownership and grants survive undo with the exact `1037`
ledger intact and `1038` absent.
