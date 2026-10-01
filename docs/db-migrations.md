# Shared Postgres: Neon topology, migration numbering, backups

Single database for the Cloudflare build (bot + web), per the
[TOG-9671 plan](/TOG/issues/TOG-9671#document-plan) §2. Legacy `two-web` /
`two-bot` stay on the VPS Postgres (Coolify) in maintenance mode; this
document covers only the new Cloudflare build in `two-web-next` (+ the
bot rewrite, framework ADR pending).

## Topology (target)

| Piece | Value |
|---|---|
| Provider / plan | Neon, Launch (`$0.106`/CU-hr + `$0.35`/GB-mo, no minimum, scale-to-zero) |
| Region (proposed) | `aws-eu-central-1` (Frankfurt) — **pending CISO GDPR/region sign-off on [TOG-9679](/TOG/issues/TOG-9679); no member data moves before it** |
| Branches | `main` (prod, at cutover) + `staging` (all pre-cutover work) |
| Web path | Workers → Hyperdrive (`DB` binding) → Neon pooled URL |
| Bot path | Container → direct `postgres` driver (no Hyperdrive) → Neon pooled URL |
| Migrations | direct (non-pooled) URL; pooled endpoints can break DDL transactionally |

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

## Backups

Nightly `pg_dump -Fc` of the `staging` branch (and `main` after
cutover) to R2 `two-web-next-backups` (EU-jurisdiction-pinned,
jurisdiction immutable after creation):

- Script: `bin/neon-backup.sh` (`backup` | `promote-weekly` |
  `rotate` | `check`). Connection comes from `DATABASE_URL` env only —
  never argv, never logs. Every `wrangler r2 object` call passes
  `--jurisdiction eu` (overridable via `BACKUP_JURISDICTION`, default
  `eu`); the bucket default is `two-web-next-backups` (overridable via
  `BACKUP_BUCKET`).
- `paperclip-backups` is explicitly out of scope for member-data dumps
  (jurisdiction `default` / location `ENAM`; must never receive them).
- Schedule: `.github/workflows/neon-backup.yml` — nightly `03:17Z` cron
  + manual `workflow_dispatch`. Needs repo secrets `NEON_STAGING_DATABASE_URL`
  (operator-provisioned), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Layout: `neon-staging/neon-<UTC>.dump`; weeklies are
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
