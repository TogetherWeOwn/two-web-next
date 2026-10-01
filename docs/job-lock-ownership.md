# Queue uniqueness lease ownership

`job_unique_locks` deduplicates dispatches, not execution. A 3600-second retry
can outlive the 300-second uniqueness TTL. Each successful acquisition now
mints a UUID `owner_token`, including expired-row takeover. The queue carries
that identity as `leaseToken`; it is separate from the bot's idempotency key
and the depth ledger's `jobId`. Transport redelivery keeps all three identities.

Terminal cleanup and failed-send compensation compare both event lock key and
token in one Postgres `DELETE`. Both cleanup paths are bounded best-effort at
two seconds; failed-send cleanup preserves the original send error even when
release rejects or hangs. An old carrier cannot delete a replacement lease,
even if its cleanup query finishes after the deadline. A rejected acquire
returns null and dispatches/releases nothing.
The current holder can release without waiting for TTL; expiry-based takeover
still uses `clock_timestamp()` rather than transaction-start time.

## Migration and in-flight compatibility

- Apply `1016_job-lock-ownership.sql` before deploying the fencing Worker. It
  adds one nullable UUID column, no default, backfill, expiry extension or data
  deletion. Existing lock/ledger rows and queue messages remain intact.
- Existing live lock rows have null ownership and still prevent acquisition
  until their original expiry. The next expired-row upsert assigns a fresh
  token atomically. No table sweep, truncation or queue purge is needed.
- Existing tokenless queue messages still process, retry and ack normally. The
  new consumer skips their lock cleanup; it never guesses ownership from
  `eventKey`, `jobId` or `idempotencyKey`. Their original lease expires normally,
  and they cannot delete a newer token-bearing lease.
- Present `leaseToken` values must be canonical UUID strings. Malformed tokens
  are discarded before handlers, ledger transitions or lock operations, with
  only a fixed warning that contains no payload or token. Tokenless carriers
  remain valid; opaque event, job and idempotency keys are not constrained.
- The additive schema is compatible with old inserts, but old Worker code's
  **key-only DELETE is not fenced**. Follow the deployment's existing gate to
  ensure prior consumer invocations have settled before relying on the new
  invariant; do not run mixed old/new consumers indefinitely. There is no
  deployment performed or claimed by this source change.
- Rollback must retain ownership-aware cleanup while token-bearing messages
  remain in flight. Do not roll back to unconditional key-only release, drop
  the column, or delete live rows/messages. Leave the additive column in place
  and use a forward fix or a fencing-capable Worker revision.

## Focused verification

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres \
  npm test -- test/jobs-lock-ownership.test.ts test/queue-envelope.test.ts \
  test/jobs-postgres.test.ts \
  test/jobs-scheduled.test.ts test/jobs.test.ts test/alerts.test.ts \
  test/review-p1-verify.test.ts
npm run typecheck
npm run db:check
bash ci/check-migration-numbers.sh
```

The dedicated ownership suite uses fake clocks for stale success/refusal/
exhausted throw, transport retry, rejected contenders, send compensation and
legacy messages. Its real Postgres cases contend with 16 acquisitions on the
same key, verify stale release leaves the replacement row unchanged, and apply
the additive migration to a preexisting lease in a transaction-local temporary
table. The guarded fixture admits only agent-testdb or the CI Postgres service
and owns a disposable schema; it never migrates or cleans shared live tables.
