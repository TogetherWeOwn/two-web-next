# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
event-share-honesty change (PR #1865), whose share block on the event detail
page grows the Kit server bundle past the current ceiling once merged with
current main. One 256B step, the smallest aligned cover for the measured
worst case: 335616 rejects it by 51B.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `cd50096f3`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185175 | 335337 | exit 0, margin 23 |
| 2 | 116 | 1185177 | 335336 | exit 0, margin 24 |

Combined tree (main tip `cd50096f3` plus PR #1865 head `6f2e668b6`, merged
without conflicts in a scratch worktree):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186311 | 335667 | exit 1, 307 over |
| 2 | 116 | 1186311 | 335667 | exit 1, 307 over |

Re-running the checker on the combined build with the ceiling set to each
candidate: 335616 rejects (51 over); 335872 admits with 205B of margin
(exit 0, every Kit asset fits). Worker (2551/1219B), client JS
(54 files, 255513/102824B) and client CSS (2 files, 2861/1019B) fit their
unchanged ceilings. The feature delta on the server total is +1134 raw /
+330 gzip bytes (combined worst minus pristine worst); main alone has only
24B of headroom, so trimming the feature cannot close the gap.

Rebuild jitter is disclosed, not signal: pristine gzip wobbles 1B across
rebuilds, combined builds were byte-equal.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 335872 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335624, exact 335872, one byte
over 335873), so that suite needs no change. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the new
ceiling, 335872 joins the admitted allocation list, and a case admits it
while 335616 and 335873 stay rejected.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Sibling open PRs that also edit this line (#1900, #1797, #1817) were
not merged at measurement time; whichever lands second re-measures on the
new main. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
