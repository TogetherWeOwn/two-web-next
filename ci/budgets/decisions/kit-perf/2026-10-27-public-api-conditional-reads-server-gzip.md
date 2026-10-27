# 2026-10-27 decision: server JS gzip ceiling 336128 -> 336384

`server.js.maxGzipBytes` rises 336128 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
public-API change that answers unknown `/api/public` paths in JSON and
documents conditional reads (`If-None-Match`, `ETag`, `Cache-Control`, bodyless
304) in the OpenAPI document. That document is built into the Kit server bundle,
so the added contract text grows it past the current ceiling. One 256B step,
the smallest aligned cover for the measured worst case: 336128 rejects it by
176B. (Earlier measurements justified 335360 -> 335872 against main
`ba58281d2` and 335872 -> 336128 against main `7d5db1c21`; #1803 took the
first step and #1923 the second, so this record re-measures on the new main.)

## Measurements

Locked production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `227414575`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187400 | 335837 | exit 0, margin 291 |
| 2 | 116 | 1187398 | 335835 | exit 0, margin 293 |

Combined tree (main tip `227414575` plus the feature diff, merged in the
worktree): gzip 336304 and 336303, exit 1 at 336128 (176 over). Re-running the
checker with the ceiling set to each candidate: 336128 rejects (176 over);
336384 admits with 80B of margin. The feature delta on the server total is +467
gzip bytes after the contract text was condensed twice (the first draft
measured +665); main alone has 291B of headroom, so trimming further cannot
close the gap. Almost all of it is the OpenAPI description text and shared
definitions in `chunks/src.js`; the unknown-path handler adds about 115B in
`chunks/admin.js`.

Rebuild jitter is disclosed, not signal: gzip wobbles 1B across rebuilds, and CI
has measured up to 3B above a local build.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 336384 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 336192, exact 336384, one byte
over 336385), so that suite needs no change. In `ci/budget-fragments.test.mjs`
336384 joins the admitted allocation list and a case admits it while 335616,
336129, 336385 and 336640 stay rejected.

Sibling open budget PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main and
reconciles the line. No feature, checker, dependency, workflow, mask or
exclusion changes ship here. Startup, runtime, staging and release acceptance
are not claimed; exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test entry and this record.
