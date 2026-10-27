# 2026-10-27 decision: server JS gzip ceiling 336384 -> 336640

`server.js.maxGzipBytes` rises 336384 -> 336640 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
public-api-contracts change (PR #1918), whose conditional-read OpenAPI
documentation ships in the Kit server bundle and grows it past the current
ceiling once merged with current main. One 256B step, the smallest aligned
cover for the measured worst case: 336384 rejects it by 126B.

History: first written for 335360 -> 335872 (main `ba58281d2`), re-targeted
to 336128 on main `7d5db1c21`, then to 336384 on main `227414575`; sibling
raises consumed that headroom each time. The step was then dropped entirely
when #1905 took 336384 first and the merged tree still fit with 79B of
margin. Since then main grew by #1442 (cancelled-event alternatives,
`EventGone.svelte`) and #1767 (event time-from-now, `EventDetail.svelte`),
raising pristine-main worst-case server gzip from 335837 to 336043 (+206B),
which overflows 336384 once this PR's +467B OpenAPI delta is composed.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree (plus one confirming
rebuild of the combined tree). Worst case governs.

Pristine main tip `d4d7a9da5` (ceiling 336384), built in a detached scratch
worktree:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1188727 | 336041 | exit 0, margin 343 |
| 2 | 116 | 1188729 | 336043 | exit 0, margin 341 |

Combined tree (main tip plus PR #1918, merge commit `1a3039d98`; the later
ceiling-step commit touches only `ci/` and this record, not the bundle):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336384 |
|---|---:|---:|---:|---|
| 1 | 116 | n/a (text log) | 336509 | exit 1, 125 over |
| 2 | 116 | 1190266 | 336510 | exit 1, 126 over |
| 3 | 116 | 1190266 | 336510 | exit 1, 126 over |

On the combined build, ceiling 336384 rejects (126 over); 336640 admits with
130B of margin (exit 0, every Kit asset fits). Worker (2551/1219B), client
JS (54 files, 256371/102994B) and client CSS (2 files, 2861/1019B) fit their
unchanged ceilings. The feature delta on the server total is +1537 raw /
+467 gzip bytes; main alone has 341B of headroom, so the composed +467B
cannot fit without this step, and the documented wording is pinned by the
acceptance suite after two prior condensations.

Rebuild jitter is disclosed, not signal: gzip wobbled up to 1B across
rebuilds of an identical tree (builds 2 and 3 are byte-identical).

## Shipping tests

`ci/check-kit-perf.test.mjs` gains the eighth server-gzip allocation: 336640
(interval 336510, exact 336640, one byte over 336641), with the matching
newly-allowed-interval / exact-ceiling / one-byte-over branch. In
`ci/budget-fragments.test.mjs` 336640 joins the admitted allocation list
with an admit case, while 336641 joins the rejected probes.

Revert behavior, verified by mutant (not just asserted): reverting the
ceiling 336640 -> 336384 keeps the allocation suites green (336384 remains
an admitted allocation, by design) but the real gate fails exit 1 on the
merged tree (126 over, measured above), so enforcement rests on the gate.
Widening the ceiling to an unlisted value (336896 mutant) fails the
allocation control in both suites. No claim is made that the suites alone
catch a ceiling revert.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Sibling open PRs that also edit this line were not merged at
measurement time; whichever lands second re-measures on the new main.
Startup, runtime, staging and release acceptance are not claimed; exact-head
CI and independent review remain mandatory. Undo: revert this fragment step,
the test allocation and this record.
