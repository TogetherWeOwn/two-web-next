# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other server ceiling changes. This admits
the featured editorial-limits slice (moderator featured new/edit forms show
live per-field limits and the conditional image-description state), whose Kit
server routes grow the bundle past the current ceiling once merged with
current main. One 256B step, the smallest aligned cover: 335872 rejects the
worst measured build by 86B.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`, two builds per tree. Worst case
governs.

Pristine main tip `7d5db1c21`:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335872 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186502 | 335654 | exit 0, margin 218 |
| 2 | 116 | 1186500 | 335652 | exit 0, margin 220 |

Merged tree (main tip `7d5db1c21` plus the feature branch):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335872 |
|---|---:|---:|---:|---|
| 1 | 116 | 1189153 | 335958 | exit 1, 86 over |
| 2 | 116 | 1189153 | 335958 | exit 1, 86 over |

Re-running the checker on the merged build with the ceiling set to the
candidate: 335872 rejects (kit.server.js fails, 86 over); 336128 admits with
170B of margin (exit 0, every Kit group fits). The feature delta on the server
total is +2653 raw / +304 gzip bytes (merged worst minus pristine worst); main
alone has only 218B of headroom, so trimming the feature cannot close the gap.
The 170B margin is under the usual 200B target; the next step 336384 would
leave 426B but is not needed for this tree and is contended by sibling
allocations, so the smallest cover is taken and any later sibling re-measures.

Rebuild jitter is disclosed, not signal: server gzip wobbles up to 3B across
rebuilds of an identical tree (pristine 335652-335654, merged identical
across both builds).

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 336128 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 335977, exact 336128, one byte
over 336129), and the merged measurement 335958 lies inside the supported
range, so that suite needs no change for this axis. In
`ci/budget-fragments.test.mjs` the `SHIPPING_KIT_BUDGET` pin moves to the new
ceiling, 336128 joins the admitted allocation list, and a case admits it while
336129 stays rejected.

Sibling open PRs that propose the same 336128 key with their own feature
measurements are not forked: the key is one authority, and whichever lands
second reconciles to this history record. Any other open PR editing this line
re-measures on the new main.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
