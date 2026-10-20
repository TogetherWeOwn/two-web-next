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
behavior under test, and list it below. `ci/check-test-timeout-ledger.mjs`
enforces the list in `npm run check` and the always-selected CI `docs-links`
job (`npm run ledger:timeouts:selftest && npm run ledger:timeouts`):

- Scope: every Vitest config (`vitest.config.*`, `vitest.<name>.config.*`, a
  `vite.config.*` with a `test` block, and any `vitest --config` target in the
  `package.json` scripts). Today that is `vitest.config.ts` (`test/` plus
  `ci/audit-lifecycle.test.mjs`) and `tier0/vitest.config.ts` (`tier0/`). The
  gate scans every file an `include` glob matches, even excluded or opt-in
  cases, each literal `test.setupFiles` path (a string or string array resolved
  from the config's package root), and every source module they load through a
  relative static import, literal dynamic import, literal CommonJS `require`,
  or literal call through a `createRequire` binding. Non-literal dynamic import,
  `require`, and `createRequire` specifiers fail closed, except `pathToFileURL(...).href`
  imports whose path is statically derived from `mkdtempSync(join(tmpdir(), ...))`
  (temporary generated bundles are not traversed), `data:text/javascript;base64,`
  template-literal specifiers, and a `createRequire` call inside a `__require` wrapper that throws
  unless its single argument is included in a literal array of Node built-ins.
  Statically resolved source paths assigned from `fileURLToPath(new URL(...,
  import.meta.url).href)` to a local and passed through `pathToFileURL(...).href`
  remain in the relative import walk. Non-relative imports
  must be Node built-ins, `vitest`, or packages declared by a package manifest
  or present in the corresponding npm lockfile; package-import aliases and packages absent
  from both fail closed because they could hide test APIs or helpers. Calls
  from declared or lockfile-resolved packages are treated as test APIs only
  when the resolved imported/member name exactly matches `it`, `test`,
  `describe`, `suite`, or `setConfig`; an arbitrary custom runner API in a
  dependency is not inferred. Non-code relative resources (for example `?raw`
  SQL imports) are not traversed.
  In configs with a `test` block,
  the gate fails closed on
  non-literal or duplicate `setupFiles`, duplicate `include` or `testTimeout`
  keys, object spreads, dynamic computed keys, non-package roots, any assignment,
  update, or deletion, and calls or constructors other than statically
  imported `defineConfig`, `resolve`/`dirname` from `node:path`/`path`, and
  `fileURLToPath` from `node:url`. This rejects third-party merge
  helpers and helper-method calls too (even unrelated calls such as `map.set`).
  `test.dir` and `test.includeSource` are unsupported; each `test.projects`
  entry must be an inline object with a literal `test` block. Package scripts
  using `vitest` may not override scope/defaults with `--root`/`-r`, `--dir`,
  `--project`/`-p`, `--workspace`, `--include`, `--testTimeout`, or
  `--test-timeout`. An explicitly
  selected Vite config without a `test` block also fails closed; auto-discovered
  plain Vite configs without a `test` block are not treated as test scopes.
  Each `testTimeout` remains exactly `30_000`.
- Limits: a per-test timeout literal below the 30 s default (`0`, which turns
  the limit off, counts too) that Vitest reads as a timeout: the third
  argument, or a direct `timeout` option in the second, of `it`, `test`,
  `describe` or `suite` (a suite limit binds every test inside it). That
  includes their chains (`.each`, `.for`, `.skipIf`, `.runIf`, `.skip`,
  `.concurrent`), `globalThis`/`global` Vitest APIs, literal timeout options in
  inline objects or statically resolved local `const` object references, and
  aliases (`const t = test.extend(...)`, destructuring, object and array
  literals, Vitest imports and namespaces including `await import("vitest")`,
  literal CommonJS `require` calls, and fixtures re-exported from a helper
  module), plus `vi.setConfig({ testTimeout })` under any alias. Dynamic computed
  member access through a Vitest global, API, or imported namespace fails closed.
  Mutable,
  imported, member, or otherwise non-static options references fail closed, as
  do non-literal timeout values, getters, and dynamic computed keys. Callbacks
  in the options/timeout argument positions must be inline functions or local
  function/const aliases; member-expression callbacks fail closed. Hook limits
  (`beforeEach`/`afterEach` and friends) and function-return/parameter API
  aliases are out of scope.
- Rows: each file holding such a limit carries one row naming the file with an
  `(N× <limit>)` pin immediately after its path in the Test cell, plus a "why
  it stays" justification. Mixed limits use `(N× 2 s, M× 20 s)`. Counts are
  timeout locations, not generated tests. A pin must match the file by count
  and by limit, and a pin on a file without such a literal fails.

## Remaining limits and timing asserts

Owner for all rows: Web Engineer (two-web-next). Escalation: Director of
Engineering. If one of these fails under load, raise its margin or move the
timing check to fake timers; do not retry the job until it passes.

| Test | Limit | Why it stays |
| --- | --- | --- |
| `test/up-db.test.ts` (5× 10 s) | 10 s per test; elapsed `< 3500`/`< 4000` ms | Asserts the up-probe's own DB deadlines |
| `test/db-ping-cli.test.mjs` (1× 10 s) | 10 s; elapsed `< 500`/`< 2500` ms | Asserts the CLI's probe and cleanup deadlines |
| `test/counts-worker.test.ts` (4× 10 s) | 10 s per test | Bounds the miniflare counts Worker runs |
| `test/remote-runner-isolation.test.ts:547` (1× 10 s) | 10 s; child exec 10 s | Asserts the runner's kill deadline |
| `test/session-rotation-revocation-race.test.ts:220` (1× 10 s) | 10 s | Bounds the rotation/revocation race |
| `test/agent-events-grant-admission-race.test.ts:142` | `expect.poll` 4 s | Waits for the blocked admission backend |
| `test/home-events-db.test.ts` | elapsed `< 1500` ms | Home page DB read budget |
| `test/featured.test.ts:296` | elapsed `< 2000` ms | Featured rail fail-open budget |
| `test/worker-runner.test.ts:720` | elapsed `< 5000` ms | Worker request deadline |
| `test/event-search.test.ts` | elapsed `< 1000`-`< 2000` ms | Search-log write/read deadlines (see below) |
| `test/event-ics-schema.test.ts` | 90 s; `drizzle-kit generate` 60 s | Spawns drizzle-kit, the slowest step on a loaded host |
| `test/web-db-binding.test.ts:213` | 30 s | 31 sequential PATCH requests against the DB binding |
| `test/admin-validation.property.test.ts` | hard 10 s | Seeded property suite; intentionally hard |
| `test/agent-events-shield.test.ts` "admits a fresh credential while an unrelated stale row is locked" | elapsed `< 4000` ms | Proves the shield skips a locked stale row instead of waiting on it (`lockWaitMs: 50`); a stalled wait would answer 503 or hang |
| `test/agent-events-shield.test.ts` "bounds the shield lock wait under contention" | elapsed `< 4000` ms | Proves the shield gives up on a held advisory lock with a retryable 503 (`lockWaitMs: 50`) instead of waiting for the holder |
| `test/jobs-postgres.test.ts` "flight body queries run on the reserved tx (no max:1 deadlock)" | 3 s race timer | Detects the `max: 1` pool deadlock; a passing run finishes in milliseconds |
| `test/jobs-postgres.test.ts` "overlapping cron invocations single-flight…", "different jobs do not block each other" | 200 ms / 100 ms sleeps | Give the first flight time to take its lock before the second starts; a longer pause is safe, a shorter one can let the second flight win |
| `test/rsvp-lock-busy.test.ts` (queued control) | `expect.poll` 4 s | Waits for the waiter backend to queue on the member advisory lock before releasing, proving the wait-then-judge path rather than a race past the holder |
| `test/human-throttle-concurrency.test.ts` "uses post-lock time for expiry…" | 1.1 s held lock vs 2 s `WEB_THROTTLE_LOCK_TIMEOUT_MS` | The admission must acquire the held lock before the 2 s timeout so the post-lock expiry read still charges; a much slower host would refuse with no hit and break the row-count asserts |
| `test/alert-probe-disposal-acceptance.test.ts` (5× 3 s) | 3 s per test (`it.each` trailing literal) | The disposal probes assert the probe's own 2 s `timeoutMs` budget with exactly-once disposal per mode; 3 s bounds the five disposal-mode `it.each` blocks without tripping the 30 s default on a loaded host |
| `test/admin-editor-expiry-departure.test.ts` (4× 20 s) | 20 s per test | Browser-driven expiry/departure flows (reloads with 5 s Playwright caps, session-expired veto, recovery landing); 20 s bounds the Chromium round-trips |
| `test/jobs-worker-lifetime.test.ts` (3× 20 s) | 20 s per test | Successor-compensation and lease tests with pool shutdown, cron recovery and trigger-held INSERTs; 20 s bounds the database-held lock waits (the two 15 s `beforeEach`/`afterEach` hook limits are out of scope and uncounted) |
| `test/import-audit-datestyle-db.test.ts` (1× 20 s) | 20 s per test | Full legacy-fixture replay (preview, apply, replay over two stamps) with the pooled-session `SET LOCAL` datestyle matrix; 20 s bounds the multi-pass replay |
| `test/admin-keyed-mounted.test.ts` (1× 15 s) | 15 s per test | Forced-overlap roster/join rendezvous behind gated sensitive reads; 15 s bounds the two-gate handshake |
| `test/keyed-member-reads.test.ts` (1× 15 s) | 15 s per test | Forced-overlap reads rendezvous after distinct sensitive reads; 15 s bounds the gate handshake |
| `test/agent-events-shared.test.ts` (1× 15 s) | 15 s per test | A queued human publish serialized behind a real agent cancellation; 15 s bounds the cross-flight gate handshake |
| `test/agent-events-event-key-control-bytes.test.ts` (3× 15 s) | 15 s per test | Advisory-lock equivalence and wait proofs (same null-key lock, owned-lock wait, lock-name hygiene); 15 s bounds the lock-wait handshakes |
| `test/jobs-isolation.test.ts` (3× 15 s) | 15 s per test | PR68 single-flight tests with blocking-holder handshakes; 15 s bounds the holder/release rendezvous (the 15 s `beforeEach`/`afterEach` hook limits are out of scope and uncounted) |
| `test/session-revocation-rotation.test.ts` (2× 15 s) | 15 s per test | Rotation/revocation race windows with `pg_sleep`-backed expiry; 15 s bounds the race settlement |
| `test/queue-settlement-released-acceptance.test.ts` (1× 15 s) | 15 s per test | The hung released-stamp case must stay bounded yet fail open to retry; 15 s bounds the hung clock |
| `ci/audit-lifecycle.test.mjs` (1× 20 s, 2× 2 s) | 20 s browser signal cleanup; 2 s child shutdown | The browser proof waits through 1.2 s disposal after a real signal before recording evidence; the two child-process probes bound shutdown for already-exited and running children |
| `test/tail-build-attribution-acceptance.test.ts` (1× 15 s) | 15 s per test (options form) | A healthy response whose body stalls must still let a failing synthetic check page without attribution; 15 s bounds settlement of the Tail worker's independent body-read deadline |

The lock-busy busy verdicts (`test/web-throttle-lock-busy.test.ts`,
`test/agent-events-inner-lock-busy.test.ts`, and the busy cases in
`test/rsvp-lock-busy.test.ts`) carry no JavaScript timing assert and need no
row here: the holder handshake plus a direct await proves the configured
database-side lock timeout fired, with the vitest test timeout as the
backstop for an unbounded wait. Magnitude is pinned deterministically: the
containment suites pin `WEB_THROTTLE_LOCK_TIMEOUT_MS = 2000` and
`RSVP_LOCK_TIMEOUT_MS = 5000`, and every busy case holds its lock on a
database-side self-release schedule (`pg_sleep` inside the holder
transaction, then ROLLBACK — 5s web-throttle, 7s rsvp, 1s inner at
`lockWaitMs: 50`). A wait ignoring its bound would still be blocked at that
release and be admitted instead of refused, failing the verdict assert. Only
the rsvp queued control keeps a coordination poll (row above).

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
