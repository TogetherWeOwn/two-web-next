# 2026-10-27 decision: server JS gzip ceiling 336128 -> 336384

Ceiling: server.js.maxGzipBytes = 336384 (previous 336128)

`server.js.maxGzipBytes` rises 336128 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
event-share-honesty change (PR #1865), whose share block on the event detail
page grows the Kit server bundle past the current ceiling once merged with
current main. One 256B step, the smallest aligned cover for the measured
worst case: 336128 rejects it by 40B.

History: first written for 335360 -> 335872 (main `cd50096f3`), re-targeted
to 336128 on main `7d5db1c21`; sibling raises (event-time to 335872, then
Happening-now to 336128, #1923) consumed that headroom each time, so the
composition was re-measured on main `227414575` and moved one more step.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `227414575` (ceiling 336128):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187398 | 335837 | exit 0, margin 291 |
| 2 | 116 | 1187400 | 335837 | exit 0, margin 291 |

Combined tree (main tip plus PR #1865 head `6f2e668b6`, merged in a scratch
worktree; the only conflicts were visual-baseline PNGs, which do not affect
the bundle):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336128 |
|---|---:|---:|---:|---|
| 1 | 116 | 1188536 | 336165 | exit 1, 37 over |
| 2 | 116 | 1188536 | 336168 | exit 1, 40 over |

On the combined build, ceiling 336128 rejects (40 over); 336384 admits with
216B of margin (exit 0, every Kit asset fits). Worker (2551/1219B), client
JS (54 files, 256219/103045B) and client CSS (2 files, 2861/1019B) fit their
unchanged ceilings. The feature delta on the server total is +1138 raw /
+331 gzip bytes; main alone has 291B of headroom, so trimming the feature
cannot close the gap.

Rebuild jitter is disclosed, not signal: gzip wobbled up to 3B across
rebuilds of an identical tree.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries 336384 in its
`SHIPPING_SERVER_GZIP_ALLOCATIONS` (interval 336192, exact 336384, one byte
over 336385), so that suite needs no change. In
`ci/budget-fragments.test.mjs` 336384 joins the admitted allocation list and a
case admits it, while 336385 stays rejected.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Sibling open PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main.
Startup, runtime, staging and release acceptance are not claimed; exact-head
CI and independent review remain mandatory. Undo: revert this fragment step,
the test allocation and this record.
