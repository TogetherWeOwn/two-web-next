# 2026-10-27 decision: client JS raw ceiling 257024 -> 258048

`client.js.maxRawBytes` rises 257024 -> 258048 in
`ci/budgets/kit/client-js.json`. This admits the featured editorial-limits
slice, whose Kit new/edit pages ship the shared live-counter wiring to the
browser. Two 512B steps, the smallest aligned cover with at least 300B of
margin: the intermediate 257536 rejects the merged 257638 by 102B.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`, two builds per tree plus the
candidate build. Client totals did not move across rebuilds.

| Tree (main tip `e37975a07`) | Client JS raw | Gate at 257024 |
|---|---:|---|
| Pristine main | 255632 | exit 0 |
| Merged (main plus feature) | 257638 | exit 1, 614 over |

Feature delta on client JS raw: +2006. Candidate ceilings against the merged
build: 257536 rejects (102 over); 258048 admits with 410B of margin (exit 0,
every Kit group fits). File count (54/55) and client CSS (2861/1019B) fit
unchanged.

## Shipping tests

In `ci/budget-fragments.test.mjs` the client raw axis gains an allocation list
[257024, 258048]: a case admits both, and 257025, 257536, 258047, 258049 and
258560 stay rejected. The matching allocation in `ci/check-kit-perf.test.mjs`
(exact 258048, one byte over 258049) is a Reviewer-owned oracle change
delivered separately; until it lands that suite fails exactly the
`client raw one byte over` boundary case.

Sibling open PRs that propose a client raw key are not forked: the key is one
authority, and whichever lands second reconciles to this history record.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert this
fragment step, the test pin and this record.
