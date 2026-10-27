# 2026-10-27 decision: server JS gzip ceiling 335360 -> 336128

`server.js.maxGzipBytes` rises 335360 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
Kit admin create-form public-details carry-through (PR #1602), whose four
new optional controls grow the Kit server bundle past the current ceiling.
Three 256B steps, the smallest aligned cover for the measured worst case:
335872 rejects it by 78B.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `ba58281d2` (both builds byte-identical):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185441 | 335352 | exit 0, margin 8 |
| 2 | 116 | 1185441 | 335352 | exit 0, margin 8 |

Combined tree: PR #1602 head `6e5b65abd` already rebased on `ba58281d2`
(mergeable, no conflicts; both lockfiles byte-identical to main, so the
same installed dependency trees served both trees):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1185550 | 335948 | exit 1, 588 over |
| 2 | 116 | 1185550 | 335948 | exit 1, 588 over |

An earlier triple on the same tip and head measured 335946-335950B, so the
worst case overall is 335950B: 335360 rejects it by 590B, 335872 rejects
it by 78B, and 336128 (256 x 1313) admits it with 178B of margin.
Re-running the checker on the combined build at 336128 exits 0 with every
Kit asset fitting, and at 335872 it exits 1. Worker (2551/1219B) and
client CSS (2 files, 2861/1019B) are byte-identical across all builds;
client JS (54 files, 255019/103034B) fits its unchanged ceilings with
981B raw / 134B gzip of margin, so the growth is server-only with no new
files. Feature delta on the server total is +109 raw / +596 gzip bytes
(paired worst minus pristine worst).

Rebuild jitter is disclosed, not signal: paired builds inside each tree
were byte-equal, and the worst case spans 335946-335950B across six
captured builds of the same head.

## Attribution

The only build-input change in the combined tree is the #1602 diff: four
optional public-details controls (access and joining details) on the Kit
admin create form. An earlier revision spread a shared attributes object
onto each control, which pulled Svelte's spread runtime into a shared
chunk (+840B server gzip); that was removed and the shipped head shares
one snippet across the four controls. Output-equivalent restylings (plain
main-style template, emptied copy, fully data-driven page) still cost
400-660B server gzip against 8B of main headroom, so no trim of the
feature closes the 590B gap; this raise admits the measured floor.

## Shipping tests

The 336128 literal in `ci/check-kit-perf.test.mjs`
(`SHIPPING_SERVER_GZIP_ALLOCATIONS` plus the fixed 335977 / 336128 /
336129 interval, exact and one-byte-over literals) rides in the
independently authored PR #1909, which is unmerged: without it this
branch's suite fails exactly the allocation control plus the three
server-gzip cases (31/35), and with its test file overlaid in a scratch
copy it passes 35/35. The fragment-aggregation pin in
`ci/budget-fragments.test.mjs` moves with the ceiling (one pinned value,
the admitted-allocation entry, one new admit case and one new reject
probe, plus these comments); without that pin the suite fails its
shipping cases by design. Fragments suite: 31/31.

Sibling open PRs that also edit this rung (#1897 at 336128; #1900 with a
336002B composition, above the 335872 step; #1905 and #1929 at 335872)
were unmerged at measurement time; whichever lands second re-measures on
the new main.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert only
this fragment step, the test pin and this record.
