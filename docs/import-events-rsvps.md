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
schema. The script never changes either search path.

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
`(event_id, user_id)` pair, in legacy ID order to preserve the waitlist tie-break.
Imported content and timestamps replace the same fields on matching rows;
unchanged rows are not rewritten. Re-runs preserve destination row IDs. No rows
are deleted, including destination rows absent from the source.

Event start/end instants retain their UTC meaning alongside the IANA timezone;
Laravel's timestamp-without-time-zone bookkeeping is explicitly interpreted as
UTC. Recurrence end dates remain dates, not instants. Cancelled/past states,
closed RSVPs, waitlisted answers, Discord mirror IDs, terminal failure stamps,
and RSVP sync stamps are retained.

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

This tool assumes a quiescent destination during cutover; it is not a live
bidirectional sync or a replacement for a database backup. Do not clear terminal
Discord failure stamps or trigger a re-sync as part of this import.

## Fixture verification

The fixture `test/fixtures/legacy/events-rsvps.sql` transcribes the named legacy
migrations at `2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4` and contains synthetic rows
only. Integration tests use isolated schemas in the `two_web_next` database on
`agent-testdb` (or a loopback CI PostgreSQL service). Tests never read either
operator import URL or production/staging databases.
