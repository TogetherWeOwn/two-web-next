# Legacy audit import

`bin/import/audit.mjs` copies legacy member-data access logs, activity logs,
agent-event grants, ingress audits and retained idempotency keys into Next.
It is an operator cutover tool, not a scheduled job or a Workers endpoint.

## Safety contract

- Supply `LEGACY_DATABASE_URL` and `DATABASE_URL` through the operator's secret
  environment. Never put connection strings on the command line, in shell
  history, in this document, or in an issue comment. Use a read-only legacy
  database principal and a narrowly scoped Next import principal.
- With no flags, the script is a **dry run**. `--apply` is the only write mode.
  `--dry-run` and `--apply` together are rejected. Counts contain no row data.
  Errors expose only a static message and, when available, a SQLSTATE.
- Grants import **disabled** unless `--enable-grants` is explicitly supplied.
  Even with that flag, only demonstrably untouched grants can remain enabled:
  the source must expose `events.agent_grant_id` as a UUID, `max_events` must be
  positive, and the frozen snapshot must have no owned event, ingress audit or
  replay key for that grant. All history is checked, including replay keys too
  old to import. A missing ownership contract or any history leaves the grant
  disabled. This conservative rule avoids restoring spent quota: this tool does
  not copy ownership into Next `agent_events`. Supply a complete frozen source,
  not a filtered export, when requesting enabled grants.
  The flag preserves legacy disabled/expiry state; it never re-enables a grant
  already disabled in legacy or an existing Next grant. Enabling grants requires
  the cutover operator's normal admission/authorization review first.
- Only the legacy `verifier_hash` is read for grant authentication. It must be a
  64-character SHA-256 hex digest. The tool never reads or accepts an opaque
  bearer credential, and does not hash a raw credential as a fallback.
- Existing records are never updated or deleted. Preserved primary keys are the
  identity of historical audit evidence, not a license to overwrite Next data.
  Historical member/subject/causer references retain their legacy internal IDs
  (text where Next uses text, unchanged JSON for subject arrays). They are **not**
  remapped to Discord snowflakes or joined to Next users. The viewer's independent
  `viewer_discord_id` remains the stable identity for investigation.
- Stop live writers before applying at cutover. Review id collisions before the
  import; an existing ID is skipped, not replaced. Do not point a fixture test at
  a production or staging URL. This change ships tooling only; it does not run
  the real cutover.

## Commands

With the two database environment variables already injected securely:

```sh
node bin/import/audit.mjs                 # read-only preview
node bin/import/audit.mjs --apply         # grants remain disabled
node bin/import/audit.mjs --apply --enable-grants # only after admission review
```

The default schemas are `public`. `LEGACY_DATABASE_SCHEMA` and `DATABASE_SCHEMA`
can select separate schemas for a synthetic fixture in one test database.
Schema identifiers are validated and quoted, never interpolated as SQL text.

## Mapping, counts and retention

Apply the canonical Drizzle migrations before import. Migration
`1011_legacy-audit-evidence.sql` adds the previously omitted legacy audit fields:
activity `causer_type`, `event`, `batch_uuid`; grant `max_events` and `updated_at`;
replay `updated_at`; audit `discord_event_id` and `updated_at`. It also permits
legacy null activity `log_name`/`updated_at`. No historical values are fabricated.
`max_events` is retained as evidence only: Next ingress continues to enforce its
existing one-event quota, and this migration does not widen grant authority.

Legacy Laravel timestamps are UTC wall times (`config/app.php` at the pinned
legacy revision). The tool interprets them as UTC and transfers text to Postgres,
not JS Dates, preserving microseconds. Destination parameters bind as text before
Postgres converts them with `::text::timestamptz` or `::text::jsonb`: this avoids the
raw driver's Date truncation and JSON double encoding at the write boundary.
JSON arrays/objects remain arrays/objects; SQL null remains null. Numeric primary
keys are read as text to avoid JS rounding. Null legacy `created_at` or a log ID outside Next's current
integer range fails the destination constraint and rolls back; resolve such an
incompatible source with the migration owner rather than substituting today's
timestamp or changing an ID.

Counts are emitted once, only after a successful snapshot/transaction: `read`,
`inserted`, `would_insert`, `existing`, `expired`, `updated` (always zero), for each
table. Historical IDs identify append-only rows. Replay entries additionally
skip an existing `(grant_id, key)` natural key. Other uniqueness/FK errors abort
and roll back the full destination import; no errors are swallowed.

Only replay keys at or after `now - 90 days` are eligible, matching
`src/jobs/constants.ts` and the current prune comparison (`created_at < cutoff`).
The exact boundary is included. PostgreSQL compares timestamps at microsecond
precision, rather than truncating through JS Dates. Null and non-finite creation
times (`-infinity`/`infinity`) cannot establish a bounded retention window and are
counted as expired. See [PostgreSQL `isfinite(timestamp)`](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-TABLE).
No retention rules are changed for any table.
Older audit evidence is retained; the normal retention job remains responsible
for its policy. Re-running with `--enable-grants` never changes an already-imported
grant, so choose the intended admission policy before the first apply.

Apply holds destination writer locks for the import transaction; pause writers
and budget downtime for the volume. After inserts, the tool advances owned serial
sequences to at least the existing maximum without lowering them. The principal
needs SELECT/INSERT, table-lock permissions and the corresponding sequence
SELECT/UPDATE privileges. Sequence advancement is not transactional in Postgres;
a failed commit can leave an ID gap, never rewritten audit rows. Dry run uses
read-only transactions and does not insert-then-rollback or touch sequences.

## Fixture verification

```sh
# Explicit test-only URL: never use an inherited DATABASE_URL for this suite.
AUDIT_IMPORT_TEST_DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \\
  npm exec vitest run test/import-audit.test.ts test/import-audit-db.test.ts
npm run check
```

The DB suite rejects all hosts except agent-testdb (empty-password `agent_test`,
database `two_web_next`) and the GitHub Actions Postgres service defined in
`.github/workflows/ci.yml`. It migrates a disposable Next schema and creates a
unique `legacy_audit_*` schema from the fixture's `legacy` DDL, so parallel agent
runs cannot truncate another card's tables. Cleanup drops only those schemas.
Without the explicit test URL, DB tests skip and credential-free CLI tests run.
CI supplies the disposable service URL explicitly and runs the fixture suite.
The importer uses raw postgres.js source/destination clients, not the Drizzle
fixture client's overridden serializers. A subprocess regression runs the actual
CLI in preview/apply/rerun modes, checks JSON types and complete values, and compares
every imported timestamp column in Postgres at full precision, including nulls.
It sets a non-UTC process timezone; direct-client tests also use non-UTC sessions.

## Append-only triggers

The immutability work in TOG-10289 can land before or after this importer.
The import uses `INSERT ... ON CONFLICT ... DO NOTHING`, never `DO UPDATE`,
`UPDATE`, `DELETE`, `TRUNCATE`, or trigger disabling. Therefore a trigger rejecting
updates/deletes on the audit tables is compatible. No retention bypass or trigger
exception is required. Dry run performs no writes, including sequence writes.

## Legacy fixture provenance

`test/fixtures/legacy/audit.sql` transcribes the Postgres DDL generated by the
following Laravel migrations at legacy commit
`2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4`:

- `2026_08_25_000050_create_member_data_access_logs_table.php`
- `2026_09_03_190137_create_activity_log_table.php`
- `2026_09_03_190138_add_event_column_to_activity_log_table.php`
- `2026_09_03_190139_add_batch_uuid_column_to_activity_log_table.php`
- `2026_09_27_000001_create_agent_event_grant_tables.php`

All fixture identities, text, digests and timestamps are synthetic. The fixture
has no production member data or usable bearer credentials.
