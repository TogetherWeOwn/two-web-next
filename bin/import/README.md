# Legacy content and funnel import

`content-funnel.mjs` imports only `featured_contents`, `join_attempts` and
`event_search_logs` from the frozen `TogetherWeOwn/two-web` Postgres schema.
It does not import audit tables, users, OAuth tokens or sessions. Shipping this
tool is not authorization to move member data: actual cutover execution remains
subject to the approved region/access gates in [db-migrations.md](../../docs/db-migrations.md).

## Invocation

Supply `LEGACY_DATABASE_URL` (source) and `DATABASE_URL` (Next destination)
through the authorized environment/secret binding. Never pass URLs as arguments
or paste them into logs. Both URLs must explicitly identify host, user and database;
passwords come only from the URLs, never inherited `PGPASSWORD`.

```sh
node bin/import/content-funnel.mjs             # default: dry-run
node bin/import/content-funnel.mjs --dry-run   # same, explicit
node bin/import/content-funnel.mjs --apply     # writes Next only
```

Apply the Next migrations, including `1011_content-funnel-import-keys`, before
either mode. Schema names default to `public`; `LEGACY_DATABASE_SCHEMA` and
`DATABASE_SCHEMA` optionally select isolated source/target schemas. The CLI
refuses the same host/port/database/schema on both sides, even with different
users. Use the intended database endpoints, not aliases of the same database.
Use a **read-only source role** with SELECT access to the three source tables
and `users(id, discord_id)`. The source pool and source snapshot are also
Postgres-enforced read-only. Dry-run makes the destination read-only too.

Apply locks the three destination tables against concurrent writes for the
whole transaction. Run during the approved cutover/maintenance window, not as
a live periodic sync. The source is read from one repeatable-read snapshot in
500-row batches; destination inserts/updates commit together. Errors exit
nonzero with a code only: no URLs, SQL parameters, member identifiers or row
payloads are printed. A lost connection around COMMIT can make the outcome
ambiguous; re-run dry-run to reconcile, using the **same source database**.

## Identity and mapping

The legacy tables have no unique title, URL, query, or request-id key.
Each Next table therefore has a nullable, unique `legacy_id`, the original
source PK as a decimal **string**. Import upserts on that source identity.
This preserves duplicate attempts/search renders and bigint keys beyond
JavaScript's safe integer range. Next allocates its own IDs normally: native
rows keep `legacy_id = NULL`, so overlapping legacy/native IDs cannot overwrite
each other. There is no sequence reset. Do not clear or manually assign import
keys; do not point this tool at a second legacy database using the same target.

- Featured: preserve title/body/URLs/alt text, publication flag, position,
  nullable UTC display windows and timestamps. `created_by` is translated from
  the legacy user PK to `users.discord_id`; it is not imported as a numeric PK.
  A null creator stays null. A null `updated_at` falls back to that row's
  original `created_at`, never to the import time.
- Join: preserve outcome/source/request-id/Discord-id and original `created_at`.
  Legacy `updated_at` has no destination equivalent and is not copied.
- Search: preserve normalized query/result count and original `occurred_at`.
  Each repeated rendered search remains its own row; no new identity data is added.
- Laravel timestamp-without-zone values are interpreted as UTC, matching the
  legacy application contract. UTC text and explicit casts preserve microseconds
  without passing through JavaScript `Date` serialization.

One anchor clock is captured per import. Join/search rows strictly older than
90 × 24 hours are skipped; **exact-cutoff rows are retained**. Featured content
is not prunable: old entries, drafts and expired display windows remain intact.
Rows without the required source clock are skipped and counted rather than
revived with a fabricated current timestamp.

A re-run updates only changed imported rows and preserves their native ID.
Unchanged rows perform no writes or sequence allocation. The frozen source is
authoritative for imported fields; a later re-run will overwrite edits to those
fields on imported Next rows. It does **not** delete destination rows absent
from the source or prune existing destination rows; the daily prune job owns that.

## Counts and verification

On success the CLI prints one JSON object per table: `total`, `eligible`,
`skipped_old`, `skipped_missing_timestamp`, `would_insert`, `would_update`,
`unchanged`, `inserted`, `updated`, `dry_run`, and the common UTC `cutoff`.
Dry-run prints predicted inserts/updates with actual `inserted/updated = 0`.
It compares projections but does not execute insert/update constraints; apply
may still fail on incompatible legacy data and rolls back the target transaction.
Resolve the reported database error without exposing its raw row/error payload.

Synthetic DDL is transcribed from legacy revision
`2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4`; migration filenames are recorded in
[test/fixtures/legacy/content-funnel.sql](../../test/fixtures/legacy/content-funnel.sql).
The fixture's users table is only an id/Discord-id stub, not a users import.
Tests instantiate uniquely named `legacy_*` and Next schemas in the allowed
test database and apply the canonical Drizzle migrations. They never use
production or staging databases and never drop shared schemas.

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  npm test -- test/import-content-funnel.test.ts
npm run check
npm run db:check
bash ci/check-migration-numbers.sh
```

CI runs the same importer suite on its disposable Postgres service. With
`DATABASE_URL` unset, only the four credential-free CLI tests run; the nine
SQL tests explicitly skip. Coverage includes cutoff ±1 microsecond, exact
boundary, null clocks/fields, old featured entries, creator mapping, native-ID
collisions, bigint identity, >500 rows, dry-run row/sequence safety, update and
idempotent replay, atomic rollback, sanitized CLI failure output, hostile
source/target DateStyles with clean replay, identity-changing URL query
refusals plus the live same-database/same-schema backstop, and the fresh
migrateJoin-bootstrap-to-viewer path before and after 1011.
