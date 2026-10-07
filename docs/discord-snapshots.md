# Discord calendar snapshots

The calendar merges Discord-native scheduled/active events as **display-only** rows.
The existing PostgreSQL/Hyperdrive `DB` holds completed display snapshots in
`discord_event_snapshots` (additive migration `1021_discord-event-snapshots`).
These expiring cache bytes are not canonical `events`, reconciliation input, feed
publication, RSVP targets or write-back input. Calendar error/search-miss precedence
is unchanged.

## Read and refresh contract

- Keys contain the display payload version, trusted configured `APP_URL` origin,
  and `DISCORD_GUILD_ID`. Never use request Host, query, member identity or token.
- A successful `[]` is a populated snapshot; SQL `NULL` means no completed success.
- Fresh: less than 60 seconds from the last completed success, with no Discord call.
  Usable stale: less than 600 seconds **total** from that success, not 60 + 600.
- Database-clock admission grants one UUID-owned five-second refresh lease. Other
  requests return valid stale data immediately; an in-flight/held cold cache is
  an honest failure. No transaction or row lock survives into the HTTP read.
- Only the matching, unexpired owner may publish success or failure. An expired
  owner cannot clear a replacement lease, overwrite its success or install a hold.
- Failure retains the successful timestamp and imposes at least ten seconds of
  shared retry delay, or a longer valid numeric 429 `Retry-After`. A retry hold
  never extends the snapshot's 600-second maximum age. Unrepresentable/invalid
  metadata uses the default hold. Failure metadata is passed internally, not
  reparsed from logs.
- Every request reconstructs independent arrays, objects and Dates. Never share a
  Promise, response, stream, transaction or SQL client between requests.
- Store/corruption failure returns unavailable, not an unadmitted live Discord call.

## Bounds and database authority

The HTTP deadline remains 1,000 ms across headers **and the full body**, including
abort and body cancellation. The body and stored display payload are bounded to
256 KiB and 100 rows; display fields have finite length limits. Snapshot admission
reserves the separator whitespace in PostgreSQL's `jsonb::text` size, not just
compact JSON bytes. NUL/unpaired-surrogate and overlong live fields drop that row
alone, preserving healthy siblings; stored corruption still rejects the whole
snapshot. Storage operations
have a 1,500 ms deadline, force-close their own client and set transaction-scoped
350 ms lock / 400 ms statement timeouts. `prepare:false` is retained.

Fresh reads include volatile `clock_timestamp()` so Hyperdrive cannot return a
cached authoritative view. Refresh grants come only from conditional current-row
`UPDATE` or `INSERT … ON CONFLICT … RETURNING`, never from a SELECT. Completion
acquires the row lock first, then checks both token and database-clock lease expiry,
so waiting on an unchanged locked tuple cannot authorize an expired completion.
All transactional queries use
the reserved transaction client, not its outer single-connection pool.

New-key admission is nonblocking and serialized by a transaction advisory lock,
with a 128-key application capacity limit. It rechecks the target under that lock
before treating it as a new insertion, so a concurrent completed snapshot remains
usable even when it took the last slot. It prunes at most 16 expired cache rows
per new-key claim, skipping locked rows and retaining live leases/retry holds.
Existing-key refreshes do not insert a replacement if cleanup removed that key,
so they cannot race around the capacity fence. There is no request-path DDL,
generic cache framework or scheduler.

Sources: [PostgreSQL atomic upsert](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT),
[Postgres.js scoped transactions](https://github.com/porsager/postgres/tree/v3.4.9#transactions),
[PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS),
[jsonb Unicode and serialization](https://www.postgresql.org/docs/17/datatype-json.html),
and [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

## Delivery and rollback

The unchanged gated staging workflow applies and verifies web migrations **before**
deploying the Worker. A binding/migration credential does not prove runtime
SELECT/INSERT/UPDATE/DELETE access to the new table. If the existing runtime role
cannot access it, stop rollout and record the exact capability failure; do not
change grants, credentials or storage, and do not seed invented successful data.
Normal migration and deployment gates remain mandatory. `/up` schema readiness
alone does not certify a successful Discord snapshot read.

After merge, verify that gated staging migration/deployment succeeded on the repair
SHA and that telemetry identifies the served version. Staging acceptance must then
prove repeated search-miss results and real browser navigation on that version;
ordinary workflow success is not that acceptance. No production rollout is implied.

Containment rollback uses the existing approved Worker release procedure to the
actual pre-repair version recorded by deployment. Leave the additive table and
migration history intact and unused. This restores the previous cache's known
limitations; it is not evidence that those limitations are repaired.

Local SQL proofs use only disposable test databases/schemas. No manual migrations
or database probes against staging or production are part of this change.
