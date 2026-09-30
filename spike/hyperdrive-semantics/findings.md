# TOG-9680 findings (updated 2026-09-30)

## Evidence boundary

The direct-PostgreSQL results below are historical control evidence, not proof
of Hyperdrive→Neon behavior. This heartbeat uses only local tests and
agent-testdb. The current test-container-only policy prohibits staging probes;
no Neon staging test, credential access, or Cloudflare resource operation was
performed in this heartbeat.

The thread's earlier standalone GIN integration-pass assertion does not include
a complete three-check report or exact Neon branch identity in the supplied
history. It is not sufficient to certify the original acceptance. Exact Neon
branch: **not verified**.

## Current heartbeat verification (2026-09-30, board-resume re-verified)

- `vitest run test/hyperdrive-probe.test.ts`: **17/17 PASS** (DB driver mocked).
  Includes target refusal, fixed driver connection options, and generic error
  responses; it does not cover successful Worker SQL execution.
- `tsc --noEmit`: **PASS**.
- `python3 -B spike/hyperdrive-semantics/checks.py`: **3/3 PASS** against
  agent-testdb, PostgreSQL **17.11**. The second writer now retries under the
  event lock and executes the capacity-refusal decision; advisory keys are
  holder-specific and SQL/lock waits are bounded. Schema teardown completed.
- `bash spike/hyperdrive-semantics/worker-checks.sh`: **FAIL** with Wrangler
  **4.143.1**, Node **24.21.0**. The DB-free `GET /` readiness request timed out
  after 3 seconds, before `POST /spike-run` was submitted. No Worker SQL result
  was obtained. The runner stopped its local Worker in `finally`. Cause of the
  readiness timeout is not established; it is not a Neon/Hyperdrive failure.
- Runner syntax checks and `git diff --check`: **PASS**.

Safety hardening pins the local driver's host, port, database and user; uses an
explicit empty-password callback (postgres.js otherwise inherits PGPASSWORD);
and removes ambient PG settings from the local runner. Python removes ambient
libpq PG settings and disables password-file lookup. libpq warns that
`/dev/null` is not a plain password file; the test completed successfully without
reading a credential file or substituting credentials.

The full repository test suite was deliberately **not run**: its E2E suite can
consume an ambient DATABASE_URL and mutate that target. Only the selected mocked
suite and the test-container-only control were executed.

GitHub company-bot connection attention is pending interaction
`93c6fbe0-09ca-46cd-bcd6-5cf73f622635`. No commit/push/PR was performed in this
heartbeat while awaiting that connection; the source patch and this report are
registered as artifact checkpoints. Source changes are not merged or delivered.
On resumption: resolve the permitted evidence standard and connection first,
then repair local Worker readiness, checkpoint/push on the existing execution
branch, and obtain one exact-head Code Reviewer pass after green CI. No CI was
polled in this heartbeat.

## Historical control leg: direct Postgres — 3/3 PASS (2026-09-29)

`checks.py` (+ `schema.sql`) against `agent-testdb` (Postgres 17.11), throwaway
schema, torn down after the run. Rerun:
`DATABASE_URL="host=agent-testdb port=5432 user=agent_test dbname=agent_test" python3 checks.py`.
Shapes mirror two-web @ main (file:line in `schema.sql` header).

- (a) FOR UPDATE: second writer blocks on the event row (`lock_timeout` → 55P03);
  post-commit `going=1` with `capacity=1`, i.e. the `takesASeat` check refuses the loser. PASS
- (b) Advisory: `pg_advisory_xact_lock` excludes a concurrent txn; re-acquirable
  after holder commit; session `pg_advisory_lock/unlock` round-trips on direct PG. PASS
- (c) GIN: `subject_user_ids @> '[424242]'` uses
  `spike_access_logs_subject_user_ids_gin` (`jsonb_path_ops`, as in the two-web
  migration), 2001 rows / 1 hit. PASS

wrangler used for version pin: **4.143.1** (`npx wrangler --version`).

## Hyperdrive docs review (Cloudflare docs, fetched 2026-09-29)

- Pooler runs in **transaction mode**: connection returned + `RESET` after each
  transaction; `SET` does not persist; **one Worker invocation may hold multiple
  connections** (`how-hyperdrive-works`).
- Consequence: **session-scoped** `pg_advisory_lock` is NOT portable through
  Hyperdrive — the cron single-flight (W13) must use `pg_advisory_xact_lock`
  (validated above) or equivalent. Finding for W13, not a blocker.
- Named prepared statements "may have worse performance or may not be
  supported" — only `pg` (recommended, ≥8.16.3) and `postgres.js` (≥3.4.5,
  `prepare:false` = no cache + extra round-trips) are supported
  (`connect-to-postgres`, `how-hyperdrive-works`). Watch item for W3/Drizzle.
- Limits (`platform/limits`): 60 s statement cap, ~100 origin conns (Paid),
  10 min idle timeout. None threaten the three shapes.

## two-web lock inventory (ground truth for the port)

two-web uses **no `pg_advisory_*` calls** (`gh search code` 2026-09-29):
`FOR UPDATE` row locks (`EventService::rsvp/update/*ForGrant`) and DB-backed
`Cache::lock('agent-event-grant:…')` / `Cache::lock('agent-event:…')`
(`AgentEventService.php:342,474`). The "advisory lock single-flight" in this
card is the W13 re-expression of `onOneServer`/`withoutOverlapping` — this spike
proves the `pg_advisory_xact_lock` primitive it will rest on.

## Open: Hyperdrive→Neon integration — NOT VERIFIED

- (a) FOR UPDATE contention and capacity: **NOT VERIFIED through Hyperdrive**.
- (b) Advisory single-flight: **NOT VERIFIED through Hyperdrive**. Session locks
  are nonportable by documented transaction-pooling semantics; a direct-PG
  round trip does not establish session affinity. W13 must use transaction
  ownership that spans the protected work, not an autocommit lock call.
- (c) jsonb/GIN: **NOT VERIFIED as a complete reproducible integration result**.
  The earlier standalone pass assertion is retained in the issue history.

The local Worker config uses a placeholder Hyperdrive ID and a direct
agent-testdb connection. It does not exercise Hyperdrive pooling, and no exact
Neon branch can be reported for that path. `worker-probe.md` now documents the
permitted local control command, replacing the obsolete staging instructions.

The original prerequisite was [TOG-9679](/TOG/issues/TOG-9679); that is not being
reasserted as the current blocker without fresh evidence. The present blocker
is the staging-acceptance/test-policy conflict. A CTO-directed confirmation
(`b805d1d0-e1e6-4f86-bc10-a5b7d0c04e13`) is pending on
[TOG-9680](/TOG/issues/TOG-9680). No downstream W8/W9/W13 gate is approved by
these local controls. Any required integration failure finding must be routed
before those gates proceed; missing integration evidence is not a passing test.
