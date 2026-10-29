# Shared Postgres: topology, migration numbering, backups

Single database for the Cloudflare build (bot + web), per the
[TOG-9671 plan](/TOG/issues/TOG-9671#document-plan) §2. Legacy `two-web` /
`two-bot` stay on the VPS Postgres (Coolify) in maintenance mode; this
document covers only the new Cloudflare build in `two-web-next` (+ the
bot rewrite, framework ADR pending).

## Topology (target)

| Piece | Value |
|---|---|
| Staging provider / plan | PlanetScale Postgres, AWS `us-east-1` (N. Virginia), staging branch |
| Production provider / plan | PlanetScale Postgres HA, PS-10 arm, AWS `us-east-1` (N. Virginia), PG17 — per CEO region decision 2026-10-03 on [TOG-12212](/TOG/issues/TOG-12212) (supersedes [TOG-12178](/TOG/issues/TOG-12178#document-decision) rev 2 Frankfurt) |
| Staging region and Worker placement | PlanetScale staging database is `us-east-1` (N. Virginia). The staging Workers are placed `aws:us-east-1` in `web/wrangler.staging.jsonc` (Kit web) and `wrangler.jobs.jsonc` (jobs), beside the PlanetScale staging database: under the pre-repoint `aws:eu-central-1` pin (beside the retired Neon branch) each statement was a transatlantic Hyperdrive round trip (DB-bound requests against Neon: median 0.5-1.8 s, p95 3-4.6 s from US colos, 125-195 ms from CDG/AMS; live `/up` 1.32 s from the measuring host on 2026-10-15). Re-measure after the first deploy on the new placement. `env.production` sets `placement.mode = "off"`; pick its placement (likely `aws:us-east-1`) at cutover |
| Branches | PlanetScale staging branch (username suffix `4vmu64sp52p4`) + PlanetScale production branch (username suffix `mmzi498bs6m5`) |
| Web path | Workers → Hyperdrive (`DB` binding) → PlanetScale staging branch / production PlanetScale |
| Bot path | Container → direct `postgres` driver (no Hyperdrive) → PlanetScale staging / production PlanetScale `5432` direct URL |
| Migrations | direct (non-pooled) URL on port `5432`; pooled endpoints can break DDL transactionally. Staging reads `PLANETSCALE_STAGING_DATABASE_URL` (pinned staging host and branch id; retired Neon endpoints are refused); production reads `PRODUCTION_DATABASE_URL` (PlanetScale direct `<id>.pg.psdb.cloud:5432`, never `6432`) |

Repository configuration routes the Worker through the `DB`
Hyperdrive binding ([Wrangler config](../wrangler.jsonc)).
The [backup workflow](../.github/workflows/db-backup.yml) schedules nightly
staging backups using `PLANETSCALE_STAGING_DATABASE_URL`; an unset target secret skips the backup.
The [backup script](../bin/db-backup.sh) defaults to `two-web-next-backups`
with request jurisdiction `eu`. These defaults do not prove the live bucket's
jurisdiction or contents, or that a backup has succeeded.
Tests use only disposable `agent-testdb` databases or the CI Postgres service,
never staging or production ([safe-test rules](../README.md#database-and-migrations)).

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
- `1026` was never issued: the journal goes `1025_leaderboard-opt-out`
  (idx 26) straight to `1027_join-attempts-discord-id-index` (idx 27),
  no `drizzle/1026*` or `drizzle/meta/1026*` file exists, and
  `git log --all -- drizzle/1026* drizzle/meta/1026*` returns nothing.
  Do not backfill it: new migrations append above the highest reserved
  web number and numbering stays monotonic-forward (same as the older
  `1014` → `1016` gap recorded in the
  [cutover ledger](cutover-migration-ledger.md)).
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
applies transactionally and verifies zero pending migrations. The staging
`deploy.yml` runs the same script for `staging` after CI and before the Worker
deploy; live production execution always requires separate authorization and is
never part of a Worker deploy.
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

The pinned versions are Drizzle Kit `0.31.11` and ORM `0.45.4` in
`package-lock.json`. See the official [generate/custom migration options](https://orm.drizzle.team/docs/drizzle-kit-generate)
and [migrate behavior](https://orm.drizzle.team/docs/drizzle-kit-migrate). Current
upstream docs show a newer timestamp-folder layout; this repo still uses the
pinned flat SQL + `meta/_journal.json` layout, verified against the published
[Kit package](https://registry.npmjs.org/drizzle-kit/-/drizzle-kit-0.31.11.tgz)
and [ORM migrator package](https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.4.tgz).
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

## Migration runtime rights and default ACLs

New or changed SQL migrations that create runtime-visible tables, views, or
sequences must state the reviewed runtime privileges explicitly: one privilege
per `GRANT`, directly from the creating object owner, to `two_web_app`, with no
grant option. The object-by-object allowlists and static SQL parser are in
[`ci/migration-runtime-rights.mjs`](../ci/migration-runtime-rights.mjs). They
cover regular and partition tables, views (including recursive ones), explicit
sequences, and serial or identity-generated sequences under quoted and
catalog-qualified spellings alike; unlisted objects and unsupported SQL fail
closed. The lexer mirrors PostgreSQL on `E'...'` escapes (only at token starts)
and dollar quotes (including `$` after digits or non-ASCII identifier
characters), accepts non-ASCII identifier characters and dollar-quote tags,
and rejects unterminated strings, quotes, and comments rather than silently
merging statements. PostgreSQL string continuation across a newline inherits
the first literal's escape mode and is comment-sensitive (line comments
preserve it, block comments break it), so an `E'...'` literal followed by a
newline gap rejects instead of risking a hidden statement; no historical
migration uses that shape. Both scanners use PostgreSQL's whitespace classes:
CR and LF are newlines, and space, tab, form feed, and vertical tab extend the
gap. Line comments end at CR or LF, so a CR-only line ending cannot hide the
next statement.
The check applies only to added/changed migration SQL and does not rewrite or
bless historical migrations. Session configuration (`SET`, `RESET`, and
`DISCARD` in any spelling, which could change object resolution, ownership, or
string lexing) and persisted configuration defaults (`ALTER DATABASE ...
SET/RESET`, `ALTER SYSTEM`) are rejected with no allowlist, as are role
switching (including quoted `set_config` calls), role and ownership changes,
`ALTER DEFAULT PRIVILEGES`, `REVOKE`, dynamic SQL, `SELECT INTO`, temporary
objects, unlogged sequences, inherited or LIKE-copied tables, `CREATE SCHEMA`
schema elements, sequence references, `ALTER FUNCTION ... SECURITY DEFINER`,
trigger, rule, policy, extension or server DDL, and table RLS
enable/disable/force changes outside a separately reviewed policy change.

The custom migration runner also performs a read-only catalog preflight against
the active migration role's table/sequence defaults before planning or applying.
It refuses to run as the runtime role, refuses table defaults, and refuses any
sequence default outside the reviewed `public`-scoped `two_web_app`
`USAGE`/`SELECT` set. A global sequence default is not reviewed: it also fires
in the `drizzle` schema, so it would grant the runtime role the migration
ledger's own sequence, and a `drizzle`-scoped default targets that ledger
directly, so both scopes are examined and refused. The preflight, and the
apply transaction again right after ledger bootstrap, also refuse while the
ledger table or its serial sequence (found through `pg_get_serial_sequence`)
carries any `two_web_app` or `PUBLIC` right. That includes ownership even
with NULL or explicitly revoked relation ACLs, non-dropped-column grants,
and rights the runtime can reach through a role it inherits, can assume, or
administers (`pg_has_role` with `USAGE`, `SET`, or
`MEMBER WITH ADMIN OPTION`; an admin can re-grant itself `INHERIT`/`SET`).
Unrelated owners and grantees stay allowed. The runner
never revokes such a right itself, so an already-exposed ledger stays refused
until the right is removed outside the runner. The refusal names the offending
reason while other database errors stay masked. The runner also pins `standard_conforming_strings=on` per connection and
transaction, matching the guard's string lexing even under a hostile database
default. It does not change ACLs or role membership. The ledger keeps the canonical Drizzle
serial format both this runner and `drizzle-kit migrate` insert through, so the
two writers stay interchangeable. The runtime-rights guard and its selftests run
in the existing `check` job, which feeds the required `ci-ok` status. CI and
runner selftests use disposable Postgres only; this check does not authorize a
staging or production connection or any live grant, revoke, role, or
default-ACL change.

## Audit tables are append-only (deployed-role prerequisite)

`drizzle/1018_audit-immutability.sql` guards `agent_event_audits`,
`member_data_access_logs` and `activity_log` with triggers
([TOG-10289](/TOG/issues/TOG-10289)). INSERT is unrestricted. UPDATE and
TRUNCATE are refused, and so is any DELETE except of a row strictly older than
90 days by its age column (`created_at`, or `occurred_at` for access logs). That
retention exception is available to a prune job. The daily `model:prune` job
prunes `agent_event_audits` and `member_data_access_logs` after 90 days. It does
not prune `activity_log`: that table is append-only and retained. The trigger
permits deleting its rows after 90 days, but no job does so. The guard has no
bypass setting. It also refuses deleting an `agent_event_grants` row that audits
still reference, because `ON DELETE SET NULL` would rewrite them. Grants are
disabled, never deleted.

The guard binds every role that cannot alter the tables. It does not bind
their owner or a superuser: either can disable or drop the triggers. This
must hold before the web/bot roles reach staging or production data (not
yet provisioned; this PR changes no live role or credential):

- Migrations run as a separate owner role. The runtime roles (Workers via
  Hyperdrive and the bot container) do not own these tables and are not
  superusers or members of the owner role.
- On these three tables the runtime roles hold only `SELECT, INSERT, DELETE`,
  plus `USAGE` on their id sequences. They hold no `TRUNCATE`, `TRIGGER` or
  `REFERENCES`. One exception is accepted: the production PlanetScale runtime
  role inherits `pg_write_all_data`, which also grants `UPDATE`. The guard
  refuses `UPDATE` on these tables, so that role cannot update audit rows.
- The runtime roles hold `CREATE` on no schema, so they cannot plant shadow
  functions or operators. Separately, the guard function pins its own
  `search_path`, so a shadowed `clock_timestamp()` or `<` cannot reach it.
- Test fixtures own their disposable schemas, so `test/helpers/audit-rows.ts`
  can lift the TRUNCATE guard inside one transaction for teardown.
  `test/audit-immutability.test.ts` proves the guard under a throwaway non-owner
  role.

## Backups

Nightly `pg_dump -Fc` of the PlanetScale staging branch to R2 `two-web-next-backups`
(EU-jurisdiction-pinned, jurisdiction immutable after creation). Staging is
dumped nightly by the schedule; production is dumped only by manual dispatch
with `target: production`, behind the `production` Environment:

- Script: `bin/db-backup.sh` (`backup` | `promote-weekly` |
  `rotate` | `check`). Connection comes from `DATABASE_URL` env only —
  never argv, never logs. Every `wrangler r2 object` call passes
  `--jurisdiction eu` (overridable via `BACKUP_JURISDICTION`, default
  `eu`); the bucket default is `two-web-next-backups` (overridable via
  `BACKUP_BUCKET`).
- `paperclip-backups` is explicitly out of scope for member-data dumps
  (jurisdiction `default` / location `ENAM`; must never receive them).
- Schedule: `.github/workflows/db-backup.yml` — nightly `03:17Z` cron
  binds `environment: ${{ inputs.target || 'staging' }}`, so scheduled runs
  (which carry no inputs) always dump staging. A production dump is a manual
  `workflow_dispatch` with `target: production`, which binds the `production`
  Environment and waits on its required reviewers and main-only branch policy.
  Staging reads the staging-Environment secret `PLANETSCALE_STAGING_DATABASE_URL` (operator-provisioned, same secret the migrate/deploy paths use);
  the production target reads `PRODUCTION_BACKUP_DATABASE_URL` (a read-only role
  that inherits `pg_read_all_data` and no write, DDL or admin role, on the
  PlanetScale direct endpoint, same `pg_dump -Fc` path — direct `5432`, never
  the pooled `6432` port).
  Also needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Branch/target correspondence: `branch` must be empty (defaults to `target`),
  equal to `target`, or `test-*`; staging↔production swaps and other overrides
  refuse before provisioning or I/O. Local operators must declare
  `BACKUP_TARGET=staging|production` matching `DATABASE_URL` for the same check
  on all four script commands. Without that declaration, legacy local branch
  behavior remains unchanged; the guard does not inspect or attest the URL.
- Layout: `neon/<branch>-<branch>-<UTC>.dump` dailies — the `neon` R2 key
  prefix is retained deliberately so pre-rename manifests and archives stay
  addressable only until rotation prunes them (retention, below in this
  bullet); it names the key layout, not the live provider (for example
  `neon/staging-staging-<UTC>.dump`); weeklies are
  `<daily-without-.dump>-weekly-<UTC>.dump` copies; the manifest is
  `neon/<branch>-<branch>/MANIFEST.txt` (for example
  `neon/staging-staging/MANIFEST.txt`). Retention on scheduled runs
  (staging): newest 7 dailies + newest 4 weeklies (mirrors the `two-web`
  `pg-backup.sh` policy), so pre-flip Neon-era archives under the shared
  prefix rotate out within about 7 days (dailies) and 4 Sundays (weeklies);
  any Neon export needed before the Neon staging database is deleted must
  come from the live database, not from these R2 archives. Manual
  dispatches skip the promote-weekly + rotate step, so a production dispatch
  only backs up and checks — its
  archives are never promoted or pruned and need an approved manual rotate.
- Proof: every backup re-lists its key after upload; restore is proved
  by restoring into a scratch database and comparing row counts
  table-by-table (same bar as `two-web` `restore-proof`).
- Selftest: `ci/db-backup-selftest.sh` runs stubbed (no secrets, no
  network) in CI.

## Rollback

Next and legacy do not share a database. Per the [Topology](#topology-target)
table, Next staging and production use PlanetScale Postgres; legacy
`two-web` / `two-bot` data lives in the separate VPS Postgres named in the
introduction. The cutover import copied legacy data into Next one way (the
`bin/import/` importers read legacy only in read-only transactions), and
nothing in this repository copies Next writes back. Legacy VPS data is
therefore not interchangeable with Next data: it is neither a backup of Next
nor a data rollback target. Use the reviewed procedures:

- **Worker code:** [Worker rollback](runbook.md#worker-rollback) to a
  recorded known-good version ID; production uses the `rollback-production`
  workflow. It does not undo migrations, data writes, Discord side effects,
  queue messages or external-resource changes.
- **Schema and data:** the **Rollback** rules under
  [web schema migrations](runbook.md#neon-web-schema-migrations-separate-operator-action).
  Prefer a reviewed forward repair. An authorized PITR or backup restore
  follows the provider's documented procedure with writers paused; reconcile
  bot, queues and external effects separately. Archive checks and live-data
  recovery prerequisites are in
  [Backups and restore drill](runbook.md#backups-and-restore-drill).
- **DNS back to legacy:** a traffic change, not a data rollback; legacy
  serves its own database. It requires the
  [recovery map](cutover-rollback.md#staging-dns-restoration-and-import-recovery-limits),
  a validated incident procedure and the
  [standing legacy-origin precondition](runbook.md#before-the-production-flip).

This repository deploys the web app only as Cloudflare Workers, so a Coolify
redeploy is not a rollback path for it. The kept staging
[rehearsal record](cutover-rollback.md#rehearsal-record) covers Worker
rollback and DNS flip-back only; it proves neither a production recovery nor
a data restore. This section states the documented topology and procedures,
not a live check of either provider.

## Retired interim option: VPS Postgres via Tunnel

Historical and non-actionable. The
[first version of this document](https://github.com/TogetherWeOwn/two-web-next/pull/10)
offered early staging a read path to the legacy VPS Postgres through a
Cloudflare Tunnel until a Neon `staging` branch existed. Staging later ran on
Neon and now uses the pinned PlanetScale staging branch
([Topology](#topology-target)); `ci/db-migrate.mjs` refuses retired Neon
endpoints. No tracked configuration or workflow uses a tunnel to the VPS
database. Do not add one, and never point staging or production Next at the
legacy VPS database.
