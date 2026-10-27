# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other server ceiling changes. This admits
the featured editorial-limits slice (moderator featured new/edit forms show
live per-field limits and the conditional image-description state), whose Kit
server routes grow the bundle past the current ceiling once merged with
current main. Two 256B steps, the smallest aligned cover with margin: 335616
rejects the worst measured build by 37B.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, three builds per tree. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---|
| 1 | 1185439 | 335351 | exit 0, margin 9 |
| 2 | 1185439 | 335348 | exit 0, margin 12 |
| 3 | 1185441 | 335351 | exit 0, margin 9 |

Merged tree (main tip `ba58281d2` plus the feature branch, which already
contains that tip):

| Build | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---|
| 1 | 1188094 | 335653 | exit 1, 293 over |
| 2 | 1188092 | 335652 | exit 1, 292 over |
| 3 | 1188092 | 335652 | exit 1, 292 over |

Re-running the checker on the merged build with the ceiling set to each
candidate: 335616 rejects (kit.server.js fails, 37 over); 335872 admits with
219B of margin (exit 0, every Kit group fits). The feature delta on the
server total is +2653 raw / +305 gzip bytes (merged worst minus pristine
worst); main alone has only 9B of headroom, so trimming the feature cannot
close the gap.

Rebuild jitter is disclosed, not signal: server gzip wobbles up to 3B across
rebuilds of an identical tree (pristine 335348-335351, merged 335652-335653).

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 335872 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335624, exact 335872, one byte
over 335873), and the merged measurement 335653 lies inside that interval
(335616, 335872], so that suite needs no change for this axis. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the new
ceiling, 335872 joins the admitted allocation list, and a case admits it
while 335616 and 335873 stay rejected.

Sibling open PRs that propose the same 335872 key with their own feature
measurements (for example the event-share-honesty change) are not forked:
the key is one authority, and whichever lands second reconciles to this
history record. Any other open PR editing this line re-measures on the new
main.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
