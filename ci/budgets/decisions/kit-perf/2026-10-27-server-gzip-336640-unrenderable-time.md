# 2026-10-27 decision: server JS gzip ceiling 336384 -> 336640

`server.js.maxGzipBytes` rises 336384 -> 336640 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
unrenderable-time guards (PR #1859): the Kit list serializer and edit page
refuse to format a nonfinite stored instant. One 256B step, the smallest
aligned cover for the measured worst case: 336384 rejects it by 130B.

History: this PR previously fit under 336384 (336096 on `b69eea7d`). Main
then landed #1866 and #1767, which consumed that headroom, so the combined
tree was re-measured on `e1d999500` and moved one step.

## Measurements

Locked Node 24.22.1 production builds (`npm run build --prefix web`),
measured through `node ci/check-kit-perf.mjs`, two builds of the combined
tree (main `4e90a8bcf` plus this PR head).

| Build | Gzip bytes | Gate at 336384 | Gate at 336640 |
|---|---:|---|---|
| 1 | 336514 | exit 1, 130 over | exit 0, margin 126 |
| 2 | 336514 | exit 1, 130 over | exit 0, margin 126 |

Main alone at `4e90a8bcf` built at 336246 (138B headroom); the feature added
about 266B gzip. Worker, client JS and client CSS fit their unchanged ceilings.

After merging main `d6e9491c2` to resolve the shipping-oracle conflict, two
production builds measured 336511 and 336515 server gzip bytes (worst margin
125B under the unchanged 336640 ceiling). The next lower 336384 ceiling
rejects that worst case by 131B. Both complete Kit budget checks exited 0.
The conflict resolution preserves main's independent 336896 allocation and
its literal boundary cases alongside this PR's 336640 allocation; it does
not change any ceiling.

## Shipping tests

`ci/check-kit-perf.test.mjs` gains the 336640 allocation (interval 336514,
exact 336640, one byte over 336641) and `ci/budget-fragments.test.mjs`
admits 336640 while 336641 stays rejected.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Sibling PRs that also edit this line re-measure on the new main.
Undo: revert this fragment step, the test allocations and this record.
