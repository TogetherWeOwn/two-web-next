# Load-sensitive tests in `check`

`check` runs the full coverage suite serially. While the repo is public it runs
on GitHub-hosted Linux, because the org's self-hosted runner group refuses public
repos (TOG-12326); while private it runs on the shared self-hosted runners
(`[self-hosted, two-selfhosted]`). The slowest of those (ci-rbx1) take 17-20
minutes for a green run, about 4-5x a hosted runner, so wall-clock limits
written for a laptop fail under normal queue load (TOG-12177).

## Budgets

| Limit | Value | Where |
| --- | --- | --- |
| `check` job | 40 min | `.github/workflows/ci.yml`, pinned by `ci/a11y-policy.test.mjs` |
| Default test timeout | 30 s | `vitest.config.ts` (`testTimeout`) |
| Default hook timeout | 60 s | `vitest.config.ts` (`hookTimeout`) |

The vitest defaults detect hangs; they are not performance budgets. Prefer the
default to a per-test limit. Add a per-test limit only when the limit is the
behavior under test, and list it below.

## Remaining limits and timing asserts

Owner for all rows: Web Engineer (two-web-next). Escalation: Director of
Engineering. If one of these fails under load, raise its margin or move the
timing check to fake timers; do not retry the job until it passes.

| Test | Limit | Why it stays |
| --- | --- | --- |
| `test/up-db.test.ts` (5 tests) | 10 s per test; elapsed `< 3500`/`< 4000` ms | Asserts the up-probe's own DB deadlines |
| `test/db-ping-cli.test.mjs` | 10 s; elapsed `< 500`/`< 2500` ms | Asserts the CLI's probe and cleanup deadlines |
| `test/counts-worker.test.ts` (4 tests) | 10 s per test | Bounds the miniflare counts Worker runs |
| `test/remote-runner-isolation.test.ts:347` | 10 s; child exec 10 s | Asserts the runner's kill deadline |
| `test/session-rotation-revocation-race.test.ts:192` | 10 s | Bounds the rotation/revocation race |
| `test/agent-events-grant-admission-race.test.ts:97` | `expect.poll` 4 s | Waits for the blocked admission backend |
| `test/home-events-db.test.ts` | elapsed `< 1500` ms | Home page DB read budget |
| `test/featured.test.ts:218` | elapsed `< 2000` ms | Featured rail fail-open budget |
| `test/worker-runner.test.ts:246` | elapsed `< 5000` ms | Worker request deadline |
| `test/event-search.test.ts` | elapsed `< 1000`-`< 2000` ms | Search-log write/read deadlines (see below) |
| `test/event-ics-schema.test.ts` | 90 s; `drizzle-kit generate` 60 s | Spawns drizzle-kit, the slowest step on a loaded host |
| `test/web-db-binding.test.ts:156` | 30 s | 31 sequential PATCH requests against the DB binding |
| `test/admin-validation.property.test.ts` | hard 10 s | Seeded property suite; intentionally hard |
| `test/agent-events-shield.test.ts` "admits a fresh credential while an unrelated stale row is locked" | elapsed `< 4000` ms | Proves the shield skips a locked stale row instead of waiting on it (`lockWaitMs: 50`); a stalled wait would answer 503 or hang |
| `test/agent-events-shield.test.ts` "bounds the shield lock wait under contention" | elapsed `< 4000` ms | Proves the shield gives up on a held advisory lock with a retryable 503 (`lockWaitMs: 50`) instead of waiting for the holder |
| `test/jobs-postgres.test.ts` "flight body queries run on the reserved tx (no max:1 deadlock)" | 3 s race timer | Detects the `max: 1` pool deadlock; a passing run finishes in milliseconds |
| `test/jobs-postgres.test.ts` "overlapping cron invocations single-flight…", "different jobs do not block each other" | 200 ms / 100 ms sleeps | Give the first flight time to take its lock before the second starts; a longer pause is safe, a shorter one can let the second flight win |

## Dashboard widget deadline

The admin dashboard's optional join-funnel and missed-search reads share one
pooled connection. Each SELECT has a 400 ms DB-side lock/statement cap; the
client deadline (`FUNNEL_READ_DEADLINE_MS`, `LOG_READ_DEADLINE_MS`) is 1.5 s.
The client deadline must outlast the DB-side cap plus the other widget's
transaction. If it fires while a counted read is still pending, the
member-read boundary refuses the whole page with 503.
`test/event-search.test.ts` ("loaded host") pins this.

## Lock TTL proofs

The two `pgUniqueLock` lease tests in `test/jobs-postgres.test.ts` ("new locks
get their full TTL even in an old transaction", "takes over a lock that expired
after the transaction began") carry no wall-clock margin. Each reads the
database clock inside one transaction, after `pg_sleep(0.2)` has made it older
than its start timestamp, and compares readings. The first requires
`expires_at - transaction_timestamp() >= elapsed + ttl`; transaction-start expiry
falls short of that by `elapsed`, which is at least 0.2 s. The second inserts a
lease that expires at the midpoint of the elapsed time, so it expires after the
transaction began and before the acquire, and requires that the acquire takes
it over. Host scheduling delay moves both readings together and cannot flip
either result. Do not turn these back into `remaining > x` bounds.
