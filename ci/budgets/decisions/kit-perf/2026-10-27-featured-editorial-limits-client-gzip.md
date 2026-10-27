# 2026-10-27 decision: client JS gzip ceiling 103168 -> 103680

`client.js.maxGzipBytes` rises 103168 -> 103680 in
`ci/budgets/kit/client-js.json`. The featured editorial-limits slice adds
+433 gzip bytes of client JS; on the current main (pristine 102846, 322B of
headroom) the merged tree measures 103279, 111B over. One 512B step, the
smallest aligned cover with at least 300B of margin: 103296 would leave 17B.

## Measurements

Locked Node 24.22.1 production builds, `node ci/check-kit-perf.mjs`, two
builds per tree plus the candidate build. Client totals did not move.

| Tree (main tip `e37975a07`) | Client JS gzip | Gate at 103168 |
|---|---:|---|
| Pristine main | 102846 | exit 0, margin 322 |
| Merged (main plus feature) | 103279 | exit 1, 111 over |

Candidate 103680 admits with 401B of margin (exit 0).

## Shipping tests

In `ci/budget-fragments.test.mjs` the client gzip axis gains an allocation
list [103168, 103680]; 103169, 103296, 103679, 103681 and 104192 stay
rejected. The 103680 allocation in `ci/check-kit-perf.test.mjs` is the
admin-orientation oracle change that is already reviewed and delivered
separately; this PR does not edit that file.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Exact-head CI and independent review remain mandatory. Undo: revert
this fragment step, the test pin and this record.
