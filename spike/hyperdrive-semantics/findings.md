# TOG-9680 / TOG-10478 findings (updated 2026-10-01)

## Live staging attempt: pre-SQL refusal (2026-10-01)

**Acceptance remains NOT VERIFIED.** The authorized bounded command
`bash spike/hyperdrive-semantics/remote-checks.sh` ran once and exited **1**.
Its validated Worker result was:

```json
{"ok":false,"cleanup":true,"error":"remote_staging_preflight_refused"}
```

The ephemeral remote preview reached the nonce-protected execution endpoint,
but its preflight gate refused before `runFixedStagingChecks` or database-client
construction. This is a failed acceptance attempt, **not a PostgreSQL lock/GIN
failure** and not a passing integration result. No retry or gate relaxation was
performed.

### Authorization and tested inputs

- [TOG-10479](/TOG/issues/TOG-10479) resolved the earlier staging-policy conflict;
  it permits [TOG-10478](/TOG/issues/TOG-10478) staging acceptance. CI/unit/integration
  controls remain disposable-container-only; production remains off-limits.
- Tested committed revision: `ea296c10cff48f4efd8fb90cdb4980f721c9cd67`.
  The supervisor bundled immutable Git-object source from the clean execution
  worktree. No source or dependency changes preceded this attempt.
- [PR #101](https://github.com/TogetherWeOwn/two-web-next/pull/101) had exact-head
  independent security and correctness APPROVE verdicts and green required
  `check`, `a11y`, `gitleaks`, and `pr-lint` checks before activation. The review
  lane squash-merged it at `2026-10-01T11:08:49Z` as
  `244551a43c2e949c977f7d8ac6ac8cff0ac04293`. Harness and package inputs at the
  tested revision were verified identical to that merge commit; the execution
  branch was not switched or repointed.
- Wrangler: **4.143.1**. Installed/lockfile-pinned Postgres.js: **3.4.9**.
  PostgreSQL server version: **NOT OBSERVED**; database connection never started.
- Executor: Automation Engineer `ed85a5ea-b0ff-4992-bb31-acf7872531b2`.
  Paperclip run: `f8453ef6-5611-490b-ae1d-7deedb55b86d`.

### Actual fresh binding/origin provenance

The assigned Cloudflare token successfully read current resource metadata. The
sanitized receipt was observed at `2026-10-01T11:15:10.902Z`:

- Account: `209cf7dd678adfb683947dd7874d05af`.
- Source application Worker: `two-web-next`, `APP_URL=https://next.togetherweown.com`.
  Current deployed source version: `d4c935f6-abd9-48cd-a966-26b3c5262923`.
  This identifies the source deployment, **not the executed preview version**.
- Unique `DB` Hyperdrive binding: `1d48a54abd3444009b7067c03c63ff9f`,
  name `two-web-next-staging`.
- Origin: `ep-raspy-math-b1m3quxu-pooler.c-5.eu-central-1.aws.neon.tech:5432`;
  database `two`; role `two_app`.
- Caching was enabled (`cachingDisabled:false`); no configuration mutation.
- Neon project **`two-web-next`**, branch **`staging`**: operator-derived mapping
  from [TOG-9836](/TOG/issues/TOG-9836#comment-8f2a94fd-5663-4a0a-9087-42bfe94fae43),
  corroborated by the exact current Cloudflare binding/origin match. No
  independent Neon API project/branch-ID read was performed; those IDs are not
  claimed.

### Per-check and teardown results

| Criterion | Actual result | Evidence boundary |
| --- | --- | --- |
| (a) FOR UPDATE contention and RSVP capacity refusal | NOT ATTEMPTED / NOT VERIFIED | Worker preflight refused before SQL |
| (b) Transaction advisory single-flight and reacquisition | NOT ATTEMPTED / NOT VERIFIED | Worker preflight refused before SQL |
| (c) Native jsonb containment and unforced GIN selection | NOT ATTEMPTED / NOT VERIFIED | Worker preflight refused before SQL |

The result's `cleanup:true` is the supported **pre-SQL refusal state**, not a
successful DROP assertion. No owned-schema identity or `W1_SCHEMA` marker was
produced; this gate precedes schema creation. The independent supervisor exited
normally with the failure status after process-group teardown/reaping. A
post-run `/proc` check found no process referencing the run-owned preview path.
Local process teardown is not database cleanup proof.

The combined refusal does not identify which receipt/runtime-binding predicate
failed. Its cause remains **UNDETERMINED**; the successful Cloudflare metadata
match does not prove the runtime binding satisfies the Worker gate. Diagnose
with offline contract inspection and fixed, non-secret evidence only. Any
harness change requires exact-head security/correctness review, green required
CI and non-author merge before a later authorized attempt. Do not substitute
credentials, relax the target gate, deploy a persistent Worker, or infer PASS.
This failed attempt is a blocking finding for W8/W9/W13 acceptance.

### Durable evidence

Only the two sanitized runner deliverables were uploaded; no config, nonce,
private Wrangler/build logs, credentials, or source snapshot was published.

- [Live preflight receipt](/api/attachments/c91fa946-bf2f-49a2-8d60-fd82942996f2/content)
  — SHA-256 `318ee563dc1071f7eaa7af749d44d324baae04667efcf292d8c6482fdeac3eb0`.
- [Live failure result](/api/attachments/73595805-6702-4147-9077-60061d478636/content)
  — SHA-256 `72a38a55225b80cb8b5d6552d95a6f40a5c7c068751065d1d2ea7a16b525c719`.

## Historical evidence (through 2026-09-30)

The sections below retain their original control results, failures and policy
statements as historical evidence. Their earlier blanket staging ban and
pending-policy/PR descriptions are **not the current disposition**; the dated
live attempt above supersedes them. No historical failure is relabeled PASS.

### Historical evidence boundary

The direct-PostgreSQL results below are historical control evidence, not proof
of Hyperdrive→Neon behavior. This heartbeat uses only local tests and
agent-testdb. The current test-container-only policy prohibits staging probes;
no Neon staging test, credential access, or Cloudflare resource operation was
performed in this heartbeat.

The thread's earlier standalone GIN integration-pass assertion does not include
a complete three-check report or exact Neon branch identity in the supplied
history. It is not sufficient to certify the original acceptance. Exact Neon
branch: **not verified**.

## Current heartbeat verification (2026-09-30, review-fix leg)

- `npm test` (full repo suite): **194 passed / 41 skipped, 17 files PASS**, 2
  files skipped. Includes `test/hyperdrive-probe.test.ts` 17/17 (DB mocked)
  and new `test/worker-runner.test.ts` 9/9 (offline config-boundary +
  startup-bound + wrapper-teardown regressions).
- `tsc --noEmit`: **PASS**.
- `python3 -B spike/hyperdrive-semantics/checks.py`: **3/3 PASS** against
  agent-testdb, PostgreSQL **17.11** (re-verified this leg). The second writer
  retries under the event lock and executes the capacity-refusal decision;
  advisory keys are holder-specific and SQL/lock waits are bounded. Schema
  teardown completed.
- `bash spike/hyperdrive-semantics/worker-checks.sh`: **NOT RERUN** this leg
  (prior FAIL stands: DB-free `GET /` readiness timed out with Wrangler
  **4.143.1**, Node **24.21.0**, before `POST /spike-run`; cause not
  established, not a Neon/Hyperdrive failure). The runner was reworked since:
  `unstable_dev` startup is now under a 180 s budget (exit 2) via
  `runWithWorker`, and the shell wrapper owns the process group, TERM/KILLing
  survivors on any runner exit (status preserved), on interruption (143), and
  on a 600 s expiry. Startup-bound behavior was verified offline (never-ready
  startup -> exit 2 in ~300 ms at 300 ms budget; nonzero-exit child reaping
  and SIGTERM-interruption teardown confirmed via `test/worker-runner.test.ts`
  with inert fakes; old-wrapper leak reproduced as negative control). No live
  Worker SQL result obtained; no staging/prod probe.
- Runner syntax (`node --check`, `bash -n`) and `git diff --check`: **PASS**.

Safety hardening pins the local driver's host, port, database and user; uses an
explicit empty-password callback (postgres.js otherwise inherits PGPASSWORD);
and removes ambient PG settings from the local runner. Python removes ambient
libpq PG settings and disables password-file lookup. libpq warns that
`/dev/null` is not a plain password file; the test completed successfully without
reading a credential file or substituting credentials.

## Review-fix leg: [TOG-10342](/TOG/issues/TOG-10342) CHANGES addressed (2026-09-30)

Reviewer verdict on `53984c8`: CHANGES with two findings. Both fixed on the
same branch; PR #44 left open, not merged.

- **P1** (`wrangler.probe.jsonc`): removed the `hyperdrive` binding with its
  passwordless `localConnectionString` (deterministically rejected by
  Miniflare's `HyperdriveSchema`/`V4WorkerOptionsSchema` — reproduced before
  the fix). The Worker now receives the same pinned test-container target as a
  plain `vars` string (`TEST_DB_CONNECTION_STRING`), which wrangler's file
  validator accepts and which Miniflare passes through without a password
  gate. No credential introduced or substituted. `probe-worker.ts` reads
  `TEST_DB_CONNECTION_STRING` first, `DB.connectionString` as fallback; the
  `isTestDatabase` refusal gate is unchanged. `worker-probe.md` realigned to
  the vars path.
- **P2** (`worker-checks.mjs`): startup (`unstable_dev`) moved inside a 180 s
  wall-clock budget in new `spike/hyperdrive-semantics/runner.ts`
  (`runWithWorker`/`withStartupTimeout`); never-ready startup exits 2 without
  reaching readiness/cleanup, check failure exits 1 after `worker.stop()`,
  success exits 0 after `worker.stop()`. The shell wrapper owns the runner's
  process group (`set -m`) and reaps survivors on any runner exit (exit status
  preserved), on interruption (exit 143), and on a 600 s expiry — the mechanism
  that actually terminates a hung startup, since a `Promise.race` alone cannot.
- **Offline regressions** (`test/worker-runner.test.ts`, 9 tests, no
  Worker/DB/network): config uses `vars` not `hyperdrive`, pins the exact
  test-container URL with empty password, passes the real boundary validators
  (wrangler `validateVars` semantics + live `HyperdriveSchema` negative
  control), the runner settles exit 2 on never-ready startup with `stop()`
  verified on success and check failure, and the shell wrapper reaps group
  children on nonzero runner exit and on interruption (exit 143) with inert
  fakes (old-wrapper leak reproduced as negative control).
- Verified this leg: full `npm test` 194 pass / 41 skip; `tsc --noEmit` PASS;
  direct-Postgres control 3/3 PASS (PG 17.11); `node --check` + `bash -n` +
  `git diff --check` PASS; process-group teardown on nonzero runner exit and
  on interruption confirmed (old-wrapper leak reproduced as negative control).
  Live Worker leg NOT RERUN (prior pre-SQL readiness FAIL stands; cause
  unknown, not a Neon failure). Hyperdrive→Neon (a)/(b)/(c) remain NOT
  VERIFIED; no Neon branch invented; no staging/prod probes; no CI polling.

The full repository test suite was run this leg (`npm test`: 194 passed,
41 skipped) after confirming no ambient `DATABASE_URL` mutation risk in the
selected suites; the E2E skips are the suite's own. Python/Node runners strip
ambient `PG*` settings and pin test-container-only targets.

GitHub company-bot connection attention is pending interaction
`93c6fbe0-09ca-46cd-bcd6-5cf73f622635`. Source changes are not merged or
delivered. Next: commit/push this branch, then reopen [TOG-10342](/TOG/issues/TOG-10342)
for the same-card exact-head re-check after green CI (reviewer squash-merges
on approval). No CI was polled in this heartbeat.

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

## Live Hyperdrive → Neon staging result (2026-10-01)

Executed `remote-checks.sh` once at revision `5b82b59af58149734316695e14238042ca4c22f8`
(Wrangler 4.143.1, ephemeral remote preview, not a deployed Worker) through staging Hyperdrive
`1d48a54abd3444009b7067c03c63ff9f` (`two-web-next-staging`) to the pooled Neon origin, database `two`
(operator-mapped project `two-web-next` / branch `staging`; not an independent Neon API branch-ID read).
Server: PostgreSQL 17.11. Earlier attempts were refused pre-SQL by the preflight (the binding
database/user were compared with origin values; a Hyperdrive binding exposes proxy-issued ones, fixed in #234).

| Check | Result | Detail |
| --- | --- | --- |
| (a) SELECT … FOR UPDATE contention | PASS | blocked_55P03=true second_seat_refused=true going=1 |
| (b) `pg_advisory_xact_lock` single-flight | PASS | concurrent_refused=true reacquired=true |
| (c) jsonb + GIN | PASS | uses_gin=true rows=2001 hits=1 |

3/3 passed; cleanup true, `teardownFailures: []` (synthetic schema `w1_staging_75546283…` dropped).
No production target. This clears the W1 integration-leg blocker for W8/W9/W13.
