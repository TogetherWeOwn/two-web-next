# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
participation-guidance slice (PR #1846): the Kit event-detail RSVP help link
adds four lines to `web/src/lib/EventDetail.svelte`, and on the current main
tip the merged tree no longer fits the 335360 ceiling that an earlier raise
set for the same bundle. 335872 is the next supported 256B step.

## Measurements

Production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds of the merged tree (main tip
`ba58281d2` plus this PR head), after the ladder merge:

| Build | Gzip bytes | Gate |
|---|---:|---|
| 1 | 335586 | exit 1, 226 over 335360 |
| 2 | 335587 | exit 1, 227 over 335360 |

Worst case is 335587: the current 335360 ceiling rejects it by 227B,
and 335872 (256 x 1312) admits it with 285B of margin. The intermediate
step 335616 would also admit it (29B margin) but is not a supported
allocation in the shipping oracle, so this PR does not use it.

## Shipping tests

335872 already has explicit support in `ci/check-kit-perf.test.mjs`
(`SHIPPING_SERVER_GZIP_ALLOCATIONS` and the fixed 335624 interval, exact
and one-byte-over literals), so that suite passes unchanged. The
fragment-aggregation oracle in `ci/budget-fragments.test.mjs` moves with the
ceiling (one pinned value, one allocation entry and its admit test, plus
335873 in the unsupported list). A sibling budget PR may propose the same
335872 key; whichever lands first carries it and the other reduces to its
measurement record.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Exact-head CI and independent review remain mandatory. Undo: revert
only this fragment step, the oracle pins and this record.
