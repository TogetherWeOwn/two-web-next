# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
participation-guidance slice (PR #1846): the Kit event-detail RSVP help link
adds four lines to `web/src/lib/EventDetail.svelte`. On main tip
`d9b213141` the merged tree no longer fits the 335872 ceiling. 336128 is the
next 256B step.

## Measurements

Production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds of the merged tree (main tip
`d9b213141` plus this PR head):

| Build | Gzip bytes | Gate |
|---|---:|---|
| 1 | 335892 | exit 0 at 336128, margin 236 |
| 2 | 335889 | exit 0 at 336128, margin 239 |

Worst case is 335892: the 335872 ceiling rejects it by 20B and 336128
(256 x 1313) admits it with 236B of margin. An independent reviewer
measured 335888/335890B on the same composition. Pristine main measures
about 335654B, so the feature adds about 235B.

## Shipping tests

336128 is already supported in `ci/check-kit-perf.test.mjs` (#1909). The
fragment oracle in `ci/budget-fragments.test.mjs` gains the 336128 allocation
entry and its admit test, and 336129 and 336384 join the unsupported list.
No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Exact-head CI and independent review remain mandatory. Undo: revert
only this fragment step, the oracle entry and this record.
