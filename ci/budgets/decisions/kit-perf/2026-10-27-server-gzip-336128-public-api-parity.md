# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

Ceiling: 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
public-api MCP parity change (PR #1860): the shared `parsePublicApiGame` and
canonical-key code in `src/public-data/contracts.ts` is now bundled into the
Kit server. One 256B step, the smallest aligned cover for the measured worst
case.

This record supersedes the unmerged 335616 allocation drafted earlier today:
main has since shipped 335872 (PR #1803, commit `61b4a77da`), and the
composition of the current main tip plus PR #1860 measures over 335872, so
the step is re-chosen from a fresh pristine-plus-combined measurement below.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs --format json`, two builds per
tree. Worst case governs.

Pristine main tip `c067ea495`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186500 | 335651 | exit 0, margin 221 |
| 2 | 116 | 1186502 | 335652 | exit 0, margin 220 |

Combined tree, PR #1860 head `c6453b4c7` merged onto main `c067ea495`
(clean merge, no conflicts):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187690 | 335886 | exit 1, 14 over |
| 2 | 116 | 1187690 | 335888 | exit 1, 16 over |

Worst case overall is 335888: the current 335872 ceiling rejects it by 16B,
and 336128 (256 x 1313) admits it with 240B of margin. Worker (2551/1219B),
client JS (54/55 files, 255118/102664B) and client CSS (2/4 files,
2861/1019B) are byte-identical in both trees and pass their unchanged
ceilings. Feature delta on the server total is +1190 raw / +236 gzip bytes
(combined worst minus pristine worst).

Rebuild jitter is disclosed, not signal: raw wobbles by 2B and gzip by 2B
across identical-tree rebuilds, an order of magnitude below the 16B
overage. A same-day pair on the previous main tip measured 335888/335886
for the same composition, confirming stability across the dependency bump.

## Attribution

The growth belongs to the feature diff, not to main: pristine main fits
unchanged and the combined tree adds only the PR #1860 source. No new server
files appear (116 on both).

## Ladder

Open sibling budget PRs (#1932, #1933) also admit 336128 for their own
growth; both are conflicting drafts. This record carries the measured
composition of main plus PR #1860 only. If a sibling lands 336128 first,
this change reconciles to history only; if main grows meanwhile, re-measure
pristine and merged on the then-current tip before choosing the step.

## Shipping tests

336128 already has explicit support in `ci/check-kit-perf.test.mjs`
(`SHIPPING_SERVER_GZIP_ALLOCATIONS` plus the fixed 335977 / 336128 / 336129
interval, exact and one-byte-over literals), so that suite passes unchanged.
`ci/budget-fragments.test.mjs` moves with the ceiling: the
admitted-allocation list gains 336128 with an admit case, following the
merged PR #1803 shape (reject controls and the off-axis drift check stay
as they are).

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the test pins and this record.
