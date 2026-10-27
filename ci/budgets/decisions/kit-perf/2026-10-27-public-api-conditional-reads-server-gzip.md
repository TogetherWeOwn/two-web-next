# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
public-API change that answers unknown `/api/public` paths in JSON and
documents conditional reads (`If-None-Match`, `ETag`, `Cache-Control`, bodyless
304) in the OpenAPI document. That document is built into the Kit server bundle,
so the added contract text grows it past the current ceiling. One 256B step,
the smallest aligned cover for the measured worst case: 335872 rejects it by
248B. (An earlier measurement against main `ba58281d2` justified 335360 ->
335872; #1803 took that step first, so this record re-measures on the new main.)

## Measurements

Locked production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `7d5db1c21`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186500 | 335653 | exit 0, margin 219 |
| 2 | 116 | 1186502 | 335652 | exit 0, margin 220 |

Combined tree (main tip `7d5db1c21` plus the feature diff, merged in the
worktree): gzip 336120 and 336119, exit 1 at 335872 (248 over). Re-running the
checker with the ceiling set to each candidate: 335872 rejects (248 over);
336128 admits with 8B of margin. The feature delta on the server total is +467
gzip bytes after the contract text was condensed twice (the first draft
measured +665); main alone has 219B of headroom, so trimming further cannot
close the gap. Almost all of it is the OpenAPI description text and shared
definitions in `chunks/src.js`; the unknown-path handler adds about 115B in
`chunks/admin.js`.

Rebuild jitter is disclosed, not signal: gzip wobbles 1B across rebuilds, and CI
has measured up to 3B above a local build.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 336128 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335977, exact 336128, one byte
over 336129), so that suite needs no change. In `ci/budget-fragments.test.mjs`
336128 joins the admitted allocation list and a case admits it while 335616,
336129 and 336384 stay rejected.

Sibling open budget PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main and
reconciles the line. No feature, checker, dependency, workflow, mask or
exclusion changes ship here. Startup, runtime, staging and release acceptance
are not claimed; exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test entry and this record.
