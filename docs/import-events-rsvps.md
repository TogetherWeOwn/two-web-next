# Legacy events and RSVPs import

`bin/import/events-rsvps.mjs` copies the frozen Laravel events and RSVPs into the
migrated Next database. It does not call Discord, enqueue sync jobs, import users,
copy sessions, or create agent grants. Import users first: member and creator
references are resolved from legacy `users.discord_id` to Next `users.id`
(the Discord snowflake), never by legacy numeric IDs.

## Operator use

Supply `LEGACY_DATABASE_URL` and `DATABASE_URL` through the operator's approved
environment/secret injection. Do not put connection strings on the command line,
in shell history, or in reports. The source connection must select the legacy
schema through its search path; the destination must select the migrated Next
schema. The script never changes either search path. Host, username, database,
password and port come from each URL, not inherited `PG*` defaults. IPv6 brackets
are removed before handing the hostname to the driver. An omitted URL port is
pinned to 5432; an explicit nonzero URL port is honored.

```sh
node bin/import/events-rsvps.mjs             # default: read-only dry run
node bin/import/events-rsvps.mjs --dry-run   # explicit read-only dry run
node bin/import/events-rsvps.mjs --apply     # explicit transactional writes
```

Run the dry run, inspect its per-table counts, resolve rejected rows, and only
then run an approved cutover apply. Stop legacy writes during the final cutover.
The source is read in one repeatable-read, read-only transaction. Apply uses one
destination transaction, so a validation or database error rolls back the whole
batch. Dry-run performs no writes (including no sequence allocations).

Events upsert on `event_key` in parent-first order. RSVPs upsert on the resolved
`(event_id, user_id)` pair. Migration `1010_rsvp-legacy-order` adds nullable bigint
`rsvps.legacy_id`: every imported pair retains its exact legacy ID, including
existing pairs and rows recovered after an orphan was skipped. Native answers
leave it null. A different already-stored legacy ID on a matching pair is a
validation error, not a reason to overwrite source identity.

Waitlist ordering consumers must use `ORDER BY created_at, COALESCE(legacy_id, id), id`,
not destination ID alone. This preserves the source equal-time FIFO relation;
mixed native/imported ties are deterministic but do not represent historical
ordering between independent ID namespaces. Next's waitlist ranking, row locks
and automatic promotion use that same ordering key. The importer itself never
promotes answers or sends Discord sync jobs.

Imported content and timestamps replace the same fields on matching rows;
unchanged rows are not rewritten. Re-runs preserve destination row IDs. No rows
are deleted, including destination rows absent from the source.

Migration `1013_event-ics-sequence` must be applied before import. The importer
checks the source relation for `ics_sequence`: when present, it retains that
bigint without JavaScript number rounding; older sources backfill from the
nonnegative, floored UTC `updated_at` epoch (falling back to `created_at`). The
imported revision is never below the source revision, timestamp backfill, or an
existing destination revision. Changed content advances beyond the destination
revision even when source timestamps/counters are stale. Identical re-runs do
not advance the counter.

### Calendar wire range and exhaustion

Storage/import retain exact bigint revisions, but RFC 5545 §§3.3.8 and 3.8.7.4
limit the `SEQUENCE` wire value to **0–2147483647**. Both ICS exports reject an
out-of-range revision and return **503**, with no ETag or cacheable calendar.
The collection fails as a whole rather than silently omitting an event. There
is no clamping, modulo, reset, or automatic UID change: any of those could make
subscribers retain stale content or create duplicate events.

At 2147483647 the last valid revision remains exportable; the next real edit
continues the database counter and suspends ICS export. Native event edits and
legacy import remain available and do not lose the stored revision. An imported
oversized counter has the same export policy. Recovery requires an explicitly
approved calendar-identity migration (new UID and subscriber transition), not
lowering the counter on the existing UID. No such migration or cutover is
authorized by this document. Epoch-based compatibility also reaches this limit
in January 2038; plan the identity transition before that boundary.

Ordinary application inserts/updates cannot choose a revision: the database
trigger `events_ics_sequence` owns it. Restoring legacy counters is a separate
cutover operation requiring the **destination table-owner principal**, not a new
grant to the Worker. Apply locks `events` in ACCESS EXCLUSIVE mode, temporarily
disables only that named trigger in the destination transaction, and re-enables
it before commit. The lock prevents concurrent writes during restoration; a
failed import rolls back both data and trigger state. Other triggers, constraints
and replication settings are untouched. Dry-run neither locks nor disables the
trigger and cannot prove table-owner permissions. A permission failure is a
blocker: stop and report it; do not substitute credentials or grant ownership to
the application. This document does not authorize a real cutover apply.

Event start/end instants retain their UTC meaning alongside the IANA timezone;
Laravel's timestamp-without-time-zone bookkeeping is explicitly interpreted as
UTC. Comparisons and writes preserve all six PostgreSQL fractional digits, without
passing timestamps through JavaScript `Date` (see [PostgreSQL formatting](https://www.postgresql.org/docs/17/functions-formatting.html)).
Recurrence end dates remain dates, not instants: both projections use explicit
`YYYY-MM-DD` formatting and writes cast text to date to timezone-free midnight,
independent of source/destination `DateStyle`. Cancelled/past states,
closed RSVPs, waitlisted answers, Discord mirror IDs, terminal failure stamps,
and RSVP sync stamps are retained.

Agent attribution is unsupported: a non-null `agent_grant_id` or `proof_marker`,
or nonzero `agent_version`, rejects the **entire batch before any destination writes**
in both modes, with exit 1 and an aggregate rejected-event count. This includes
proof attribution surviving a deleted source grant. Do not strip these fields
to make a row appear human-owned; arrange a separately authorized machine-event
migration. This tool never creates grants or flattens machine-owned series/RSVPs
into ordinary events.

The JSON report contains counts only, not connection strings, event content,
member identifiers, or raw database errors. Orphan RSVPs are counted by reason
and skipped, never silently dropped. Missing creators are reported and mapped
to null, matching the nullable creator FK. Exit 2 means the report contains
orphans/missing creators (valid rows are still committed with `--apply`); exit 1
means validation/connection/database failure. Transactional failures roll back;
a lost commit acknowledgement has an unconfirmed outcome, so inspect the
destination before retrying. Exit 0
means a complete import/dry-run without unresolved references. Correct the user
import and re-run to recover missing members.

A successful dry-run verifies mapping and comparisons, **not apply feasibility**:
it does not exercise destination write constraints (for example, a Discord mirror
ID already held by a different event key) or permissions. Apply still fails and
rolls back on such conflicts; do not bypass them.

This tool assumes a quiescent destination during cutover; it is not a live
bidirectional sync or a replacement for a database backup. Do not clear terminal
Discord failure stamps or trigger a re-sync as part of this import.

## Fixture verification

The fixture `test/fixtures/legacy/events-rsvps.sql` transcribes the named legacy
migrations at `2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4` and contains synthetic rows
only. Integration tests use isolated schemas in the `two_web_next` database on
`agent-testdb` (or a loopback CI PostgreSQL service). Tests never read either
operator import URL or production/staging databases.
