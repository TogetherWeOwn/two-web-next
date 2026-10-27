# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335616

`server.js.maxGzipBytes` rises 335360 -> 335616 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the RSS
feed change (PR #1917: schedule game scope, a game category and a refresh
interval). `src/events/feeds.ts` is shared with the Kit server bundle and gains
the category lines, the refresh constant and the shared
`collectionFeedUrl`/`rssUrl(appUrl, game)` helper, which the Kit calendar
controls now call. One 256B step, the smallest aligned cover for the measured
worst case: 335360 rejects it by 159B.

## Measurements

Locked production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs --format json`. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1185439 | 335350 | exit 0, margin 10 |
| 2 | 116 | 1185439 | 335350 | exit 0, margin 10 |

Combined tree (main tip `ba58281d2` plus PR #1917 head `ad19a5e1f`, merged
without conflicts in a scratch worktree):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186082 | 335519 | exit 1, 159 over |
| 2 | 116 | 1186084 | 335519 | exit 1, 159 over |

The feature delta on the server total is +645 raw / +169 gzip bytes. Main alone
has 10B of headroom, so trimming the feature cannot close the gap. Rebuild
jitter is disclosed, not signal: raw differs by 2B, gzip not at all.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 335616 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335504, exact 335616, one byte
over 335617), so that suite needs no change. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the new
ceiling, 335616 joins the admitted allocation list, and a case admits it while
335617 stays rejected.

## Sibling contention

Other open PRs also raise this line to 335616 or 335872 (for example #1914,
#1923, #1905, #1929); none had merged at measurement time. Each admits a
different feature and the ceilings do not stack: if one lands first, this PR
re-measures on the new main and moves to the next 256B step the merged tree
needs, or reconciles to history-only if a landed ceiling already admits it.

No feature, checker, dependency, workflow, mask or exclusion changes ship here.
Startup, runtime, staging and release acceptance are not claimed; exact-head CI
and independent review remain mandatory. Undo: revert this fragment step, the
test pin and this record.
