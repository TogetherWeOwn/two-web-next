# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
public-API change that answers unknown `/api/public` paths in JSON and
documents conditional reads (`If-None-Match`, `ETag`, `Cache-Control`, bodyless
304) in the OpenAPI document. That document is built into the Kit server bundle,
so the added contract text grows it past the current ceiling. One 256B step,
the smallest aligned cover for the measured worst case: 335616 rejects it by
247B.

## Measurements

Locked production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185439 | 335350 | exit 0, margin 10 |
| 2 | 116 | 1185441 | 335350 | exit 0, margin 10 |

Combined tree (main tip `ba58281d2` plus the feature diff, applied in a scratch
worktree): gzip 335863 and 335862, exit 1 at 335360 (503 over). Re-running the
checker with the ceiling set to each candidate: 335616 rejects (247 over);
335872 admits with 9B of margin. The feature delta on the server total is +513
gzip bytes after the contract text was condensed (the first draft measured
+665); main alone has 10B of headroom, so trimming further cannot close the gap.
Almost all of it is the OpenAPI description text and shared definitions in
`chunks/src.js`; the unknown-path handler adds about 115B in `chunks/admin.js`.

Rebuild jitter is disclosed, not signal: gzip wobbles 1B across rebuilds, and CI
has measured up to 3B above a local build.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 335872 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335624, exact 335872, one byte
over 335873), so that suite needs no change. In `ci/budget-fragments.test.mjs`
the `SHIPPING_KIT_BUDGET` pin moves to the new ceiling, 335872 joins the
admitted allocation list, and a case admits it while 335616 and 335873 stay
rejected.

Sibling open budget PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main and
reconciles the line. No feature, checker, dependency, workflow, mask or
exclusion changes ship here. Startup, runtime, staging and release acceptance
are not claimed; exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test pin and this record.
