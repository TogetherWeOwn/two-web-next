# Load-sensitive tests in `check`

`check` runs the full coverage suite serially on shared self-hosted runners
(`[self-hosted, two-selfhosted]`). The slowest runners (ci-rbx1) take 17-20
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

## Dashboard widget deadline

The admin dashboard's optional join-funnel and missed-search reads share one
pooled connection. Each SELECT has a 400 ms DB-side lock/statement cap; the
client deadline (`FUNNEL_READ_DEADLINE_MS`, `LOG_READ_DEADLINE_MS`) is 1.5 s.
The client deadline must outlast the DB-side cap plus the other widget's
transaction. If it fires while a counted read is still pending, the
member-read boundary refuses the whole page with 503.
`test/event-search.test.ts` ("loaded host") pins this.
