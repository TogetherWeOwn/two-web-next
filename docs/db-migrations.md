# Shared Postgres: topology, migration numbering, backups

Single database for the Cloudflare build (bot + web), per the
[TOG-9671 plan](/TOG/issues/TOG-9671#document-plan) §2. Legacy `two-web` /
`two-bot` stay on the VPS Postgres (Coolify) in maintenance mode; this
document covers only the new Cloudflare build in `two-web-next` (+ the
bot rewrite, framework ADR pending).

## Topology (target)

| Piece | Value |
|---|---|
| Staging provider / plan | Neon, Launch (`$0.106`/CU-hr + `$0.35`/GB-mo, no minimum, scale-to-zero) |
| Production provider / plan | PlanetScale Postgres HA, PS-10 arm, Frankfurt (`aws-eu-central-1`), PG17 — per [TOG-12178](/TOG/issues/TOG-12178#document-decision) rev 2 |
| Branches | Neon `staging` (all pre-cutover work) + PlanetScale `two-production` (prod, at cutover) |
| Web path | Workers → Hyperdrive (`DB` binding) → staging Neon pooled URL / production PlanetScale `6432` (PgBouncer) URL |
| Bot path | Container → direct `postgres` driver (no Hyperdrive) → staging Neon pooled URL / production PlanetScale `5432` direct URL |
| Migrations | direct (non-pooled) URL on port `5432`; pooled endpoints can break DDL transactionally. Staging reads `NEON_STAGING_DATABASE_URL`; production reads `PRODUCTION_DATABASE_URL` (PlanetScale direct `<id>.pg.psdb.cloud:5432`, never `6432`) |

Status 2026-09-29: Neon **not yet provisioned** (host step:
`Operator:` card under [TOG-9679](/TOG/issues/TOG-9679)). R2 bucket
`two-web-next-backups` **exists, EU-jurisdiction-pinned** (jurisdiction
`eu` / location `EEUR`, verified 2026-09-29 on the host track
[TOG-9836](/TOG/issues/TOG-9836); empty, no data uploaded). The legacy
`paperclip-backups` bucket (jurisdiction `default` / location `ENAM`)
is explicitly out of scope for member-data dumps per the CISO condition
[TOG-9837](/TOG/issues/TOG-9837). Until Neon lands, all DB tests run
against `agent-testdb` — never prod or staging databases.

## Migration numbering (reserved)

One reserved filename sequence, two owners. The web runner uses Drizzle's
actual default ledger, `drizzle.__drizzle_migrations` (`hash`, `created_at`),
not a `schema_migrations` name ledger. The tracked `drizzle/meta/_journal.json`
provides tags and timestamps. Bot migrations are outside this runner's scope;
never insert bot records into the web Drizzle ledger or infer web history from
another owner's ledger.

| Range | Owner | Lives in | Status |
|---|---|---|---|
| `0001–0999` | bot | bot rewrite repo (Rust; ADR pending) | reserved, unused |
| `1000–1999` | web | `two-web-next`, Drizzle | reserved; new migrations from S1 on |

Rules:

- File names follow the Drizzle convention: `NNNN_tag.sql` (e.g.
  `1000_sessions.sql`). Numbers are never reused, even if the migration
  is reverted — revert with a new migration in your own range.
- Two grandfathered exceptions predate S1 (pinned by imports in
  `test/agent-events.test.ts`): `drizzle/0000_init-users.sql` (W3) and
  `drizzle/0001_agent-events.sql` (W14). They stay; everything new is
  `1000+`. Enforced by `ci/check-migration-numbers.sh` in CI.
- `migrations.lock` records every existing SQL path and SHA-256 byte hash as
  sorted `{ "path", "sha256" }` entries, including both grandfathered files.
  Separate fields distinguish a slug containing `keys` from a credential
  assignment without secret-scan exclusions. It is a source-history reservation,
  **not evidence that a migration has been applied to any database**. Do not edit,
  remove or rename historical migrations, move them between directories, or
  reuse their numbers. New migrations append above the highest reserved web
  number (the last web entry in `migrations.lock` on fetched main) within `1000–1999`; gaps are not reusable slots.
- Web migrations must keep the C1 zero-replatform constraints: `jsonb`
  operators, the GIN index on `member_data_access_logs`, and
  `SELECT … FOR UPDATE` row locks stay working through Hyperdrive
  (spike: [TOG-9680](/TOG/issues/TOG-9680)).
- The frozen contracts move with the data: `web_v1` read-only views and
  the HMAC `POST /internal/actions` signer (byte-for-byte; existing hex
  vectors pin it).

## Apply web migrations

The separately dispatched [db-migrate workflow](../.github/workflows/db-migrate.yml)
is the sanctioned live web apply path, not `npm run db:migrate` from an agent
workspace. Follow the [operator procedure and recovery gates](runbook.md#neon-web-schema-migrations-separate-operator-action).
It loads the selected GitHub Environment secret, rejects disabled production,
plans from the SQL journal/Drizzle ledger, records a pre-apply PITR timestamp,
applies transactionally and verifies zero pending migrations. Live execution
requires separate authorization; the default Worker deploy stays migration-free.
`npm run db:migrate:selftest` exercises only disposable local/CI databases.

### Adding a migration and running the offline gate

The guard inventories SQL in `drizzle/`, `db/migrations/` and `migrations/` to
protect reserved names/bytes across all three roots. **That is not an apply
manifest:** this repo's `drizzle.config.ts` sets `out: "./drizzle"`, and the pinned
Drizzle migrator reads SQL named by `drizzle/meta/_journal.json` entries. SQL in
the other two roots, or unregistered SQL in `drizzle/`, is not applied by the
current `npm run db:migrate` runner even if the offline guard passes. Nested SQL
and symlinked files/directories are rejected; `meta/` JSON is not SQL and is not
hashed by this guard.

1. Fetch current main (`git fetch origin`). Pick an unused number above its
   highest web number and reconcile any pending migration PRs.
2. For schema changes, update the configured schemas in `src/db/` and run
   `npm run db:generate -- --name=tag`. For hand-written SQL, run
   `npm run db:generate -- --custom --name=tag` and edit **only the new** SQL
   file. Generation writes the new SQL, snapshot and journal entry to
   `drizzle/`; copying an SQL file there alone does not register it.
3. Before committing the new migration, replace its generated ordinal with the
   chosen web number: for example, rename **new** `drizzle/0017_tag.sql` to
   `drizzle/1015_tag.sql`, change **only the new** journal entry's `tag` to
   `1015_tag` (without `.sql`), and rename its **new**
   `drizzle/meta/0017_snapshot.json` to `drizzle/meta/1015_snapshot.json` to match
   this repo's snapshot naming. Preserve the generated journal `idx`, `when`,
   `version` and `breakpoints`, and the snapshot `id`/`prevId` chain. Do not
   renumber/edit any historical SQL or rewrite existing journal entries or
   snapshots. The example number is illustrative; use the next number above the highest reserved one;
   recompute it from fetched main. Commit the new SQL and matching metadata
   together, reviewing SQL and `--> statement-breakpoint` boundaries.
4. Run `node ci/check-migration-history.mjs --write-lock`. This deterministically
   regenerates the **candidate** lock from local bytes; it does not authorize a
   historical change. Review the lock diff: only the new path/hash should be
   added. Run `npm run db:check` to validate Drizzle metadata separately; the
   history guard does not prove journal completeness or SQL execution.
5. Run `bash ci/check-migration-numbers.sh`. The existing CI invocation checks
   numbering, current lock completeness, historical names/bytes, and runs the
   hermetic selftests. It requires Node and Git, no database, secrets or SQL
   execution. Local validation uses fetched `origin/main` as the base. Applying
   SQL is a separate gated operation; these authoring commands do not authorize
   a database connection or deployment.

The pinned versions are Drizzle Kit `0.31.11` and ORM `0.45.3` in
`package-lock.json`. See the official [generate/custom migration options](https://orm.drizzle.team/docs/drizzle-kit-generate)
and [migrate behavior](https://orm.drizzle.team/docs/drizzle-kit-migrate). Current
upstream docs show a newer timestamp-folder layout; this repo still uses the
pinned flat SQL + `meta/_journal.json` layout, verified against the published
[Kit package](https://registry.npmjs.org/drizzle-kit/-/drizzle-kit-0.31.11.tgz)
and [ORM migrator package](https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.3.tgz).
Do not convert historical migrations to the newer layout in a numbering PR.

CI obtains its base from GitHub's event: `pull_request.base.sha` for PRs, `before`
for main pushes, or freshly fetched main for `workflow_dispatch`. A shallow
checkout fetches the missing base SHA from origin. Failure to read that commit,
its adopted lock, or the candidate lock fails closed. On initial adoption only,
a base without the guard/lock is allowed, but **all base SQL is still protected**.
See [GitHub event payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)
and [Git fetch](https://git-scm.com/docs/git-fetch).

The candidate lock and base lock must match their respective SQL inventories.
Independently, the guard reads historical SQL directly from Git objects, so
rewriting a lock alongside an edit, deletion or same-number rename/reuse cannot
bless it. Main's reserved paths/hashes must remain intact when new migrations
land; an appended migration is not a claim of deployment.

**Exception policy:** there is no in-band override, exception flag or automatic
historical repair. Revert/correct with a new web-range migration. Any genuinely
necessary change to this policy or the guard itself must be a separate explicit
policy-change PR with a rationale and independent Code Reviewer approval under
the same exact-head green-CI merge gate; lock regeneration alone is never an
exception. Normal migration PRs review the append-only SQL and lock diff together.

## Audit tables are append-only (deployed-role prerequisite)

`drizzle/1018_audit-immutability.sql` guards `agent_event_audits`,
`member_data_access_logs` and `activity_log` with triggers
([TOG-10289](/TOG/issues/TOG-10289)). INSERT is unrestricted. UPDATE and
TRUNCATE are refused, and so is any DELETE except of a row strictly older than
90 days by its age column (`created_at`, or `occurred_at` for access logs). That
retention exception is what `model:prune` uses. The guard has no bypass
setting. It also refuses deleting an `agent_event_grants` row that audits still
reference, because `ON DELETE SET NULL` would rewrite them. Grants are disabled,
never deleted.

The guard binds every role that cannot alter the tables. It does not bind
their owner or a superuser: either can disable or drop the triggers. This
must hold before the web/bot roles reach staging or production data (not
yet provisioned; this PR changes no live role or credential):

- Migrations run as a separate owner role. The runtime roles (Workers via
  Hyperdrive and the bot container) do not own these tables and are not
  superusers or members of the owner role.
- On these three tables the runtime roles hold only `SELECT, INSERT, DELETE`,
  plus `USAGE` on their id sequences. They hold no `UPDATE`, `TRUNCATE`,
  `TRIGGER` or `REFERENCES`.
- The runtime roles hold `CREATE` on no schema, so they cannot plant shadow
  functions or operators. Separately, the guard function pins its own
  `search_path`, so a shadowed `clock_timestamp()` or `<` cannot reach it.
- Test fixtures own their disposable schemas, so `test/helpers/audit-rows.ts`
  can lift the TRUNCATE guard inside one transaction for teardown.
  `test/audit-immutability.test.ts` proves the guard under a throwaway non-owner
  role.

## Backups

Nightly `pg_dump -Fc` of the Neon `staging` branch (and the PlanetScale
`two-production` branch after cutover) to R2 `two-web-next-backups`
(EU-jurisdiction-pinned, jurisdiction immutable after creation):

- Script: `bin/neon-backup.sh` (`backup` | `promote-weekly` |
  `rotate` | `check`). Connection comes from `DATABASE_URL` env only —
  never argv, never logs. Every `wrangler r2 object` call passes
  `--jurisdiction eu` (overridable via `BACKUP_JURISDICTION`, default
  `eu`); the bucket default is `two-web-next-backups` (overridable via
  `BACKUP_BUCKET`).
- `paperclip-backups` is explicitly out of scope for member-data dumps
  (jurisdiction `default` / location `ENAM`; must never receive them).
- Schedule: `.github/workflows/neon-backup.yml` — nightly `03:17Z` cron
  + manual `workflow_dispatch`. Staging reads repo secret
  `NEON_STAGING_DATABASE_URL` (operator-provisioned); the production target
  reads `PRODUCTION_DATABASE_URL` (PlanetScale direct endpoint, same
  `pg_dump -Fc` path — direct `5432`, never the pooled `6432` port).
  Also needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Layout: `neon-staging/neon-<UTC>.dump` (staging) and
  `neon-production/neon-<UTC>.dump` (production after cutover); weeklies are
  `neon-<UTC>-weekly-<UTC>.dump` copies. Retention: newest 7 dailies +
  newest 4 weeklies (mirrors the `two-web` `pg-backup.sh` policy).
- Proof: every backup re-lists its key after upload; restore is proved
  by restoring into a scratch database and comparing row counts
  table-by-table (same bar as `two-web` `restore-proof`).
- Selftest: `ci/neon-backup-selftest.sh` runs stubbed (no secrets, no
  network) in CI.

## Interim option: VPS Postgres via Tunnel

Before Neon is provisioned, early staging may read the existing VPS
Postgres through the Cloudflare Tunnel (zero-change, plan P2 option 1).
Constraints: staging only, read paths first, move to the Neon `staging`
branch before the parallel run. If the tunnel leg is needed, it is an
operator step (tunnel route + secret), not a repo change.

## Rollback

Same Postgres on both sides of the cutover, so there is no data to
un-migrate: rollback is DNS flip-back + Workers rollback, with a
Coolify redeploy of the recorded prior SHA as backstop (rehearsed on
staging in W16).
