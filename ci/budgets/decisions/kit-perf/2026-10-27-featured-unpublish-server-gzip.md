# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335616

`server.js.maxGzipBytes` rises 335360 -> 335616 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured-list unpublish action (PR #1869), whose Hono route, store write and
Kit list action grow the Kit server bundle past the current ceiling once
merged with current main. One 256B step, the smallest aligned cover for the
measured worst case: 335360 rejects it by 147B.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. Worst case governs.

Pristine main tip `cb0f15736`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185439 | 335350 | exit 0, margin 10 |

Combined tree (main tip `cb0f15736` plus PR #1869 head `1cb4b91a6`, merged
without conflicts in a scratch worktree):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | n/a | 335505 | exit 1, 145 over |
| 2 | 116 | n/a | 335507 | exit 1, 147 over |
| 3 | 116 | 1187161 | 335506 | exit 1, 146 over |

Re-running the checker on the third combined build with the ceiling set to
335616 admits it with 110B of margin (exit 0, every Kit asset fits); the
worst build leaves 109B. Worker (2551/1219B), client JS (54 files,
255209/102711B) and client CSS (2 files, 2861/1019B) fit their unchanged
ceilings. The feature delta on the server total is +1722 raw / +157 gzip bytes
(combined worst minus pristine). Main alone has 10B of headroom, so trimming
the feature cannot close the gap.

Rebuild jitter is disclosed, not signal: the three combined builds differ by
2B gzip.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 335616 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335504, exact 335616, one byte
over 335617), so that suite needs no change. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the new
ceiling, 335616 joins the admitted allocation list, and a case admits it
while 335617 stays rejected.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Open sibling PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main and
reconciles. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
