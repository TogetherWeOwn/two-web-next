# 2026-10-27 decision: server JS gzip ceiling 336128 -> 336384

`server.js.maxGzipBytes` rises 336128 -> 336384 in
`ci/budgets/kit/server-js.json`; no other server ceiling changes. This admits
the featured editorial-limits slice (moderator featured new/edit forms show
live per-field limits and the conditional image-description state), whose Kit
server routes grow the bundle past the current ceiling once merged with
current main. One 256B step, the smallest aligned cover: 336128 rejects the
worst measured build by 12B.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`. Worst case governs.

Pristine main tip `e37975a07` (two builds):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336128 |
|---|---:|---:|---:|---|
| 1 | 116 | 1187398 | 335838 | exit 0, margin 290 |
| 2 | 116 | 1187400 | 335837 | exit 0, margin 291 |

Merged tree (main tip `e37975a07` plus the feature branch), three builds:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336128 |
|---|---:|---:|---:|---|
| 1 | 116 | 1190051 | 336140 | exit 1, 12 over |
| 2 | 116 | 1190051 | 336139 | exit 1, 11 over |
| 3 (at 336384) | 116 | 1190051 | 336138 | exit 0, margin 246 |

Candidate ceilings against the merged worst case 336140: 336128 rejects (12
over); 336384 admits with 244B of margin (exit 0, every Kit group fits). The
feature delta on the server total is +2651 raw / +302 gzip bytes (merged
worst minus pristine worst); main alone has 290B of headroom, so trimming the
feature cannot close the gap.

Rebuild jitter is disclosed, not signal: server gzip wobbles up to 3B across
rebuilds of an identical tree (merged 336138-336140).

## Shipping tests

In `ci/budget-fragments.test.mjs`, 336384 joins the admitted server gzip
allocations, a case admits it, and 336385 stays rejected. The supported
allocation for 336384 in `ci/check-kit-perf.test.mjs` is delivered by the
independent shipping-oracle change that admits the 336384 key; this PR adds
no change there for the server axis.

Sibling open PRs that propose the same 336384 key with their own feature
measurements are not forked: the key is one authority, and whichever lands
second reconciles to this history record. Any other open PR editing this line
re-measures on the new main.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
