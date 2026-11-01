# MCP truncation notice restacked on merged main 3a8ebf6d

PR #1976 restacked on main `3a8ebf6d` (the squash-merge of PR #1975).
The restack merge had real conflicts in `ci/budget-fragments.test.mjs`,
`ci/budgets/kit/server-js.json`, `ci/check-kit-perf.test.mjs`,
`docs/machine-interface.md`, `src/mcp/server.ts`,
`src/public-data/routes.ts` and `test/mcp-event-result-budget.test.ts`;
each was resolved by keeping the #1976 side (the notice-aware superset)
over the merged #1975 content. This builds on the merged result-budget
step ([2026-11-01-mcp-result-budget-rebase.md](2026-11-01-mcp-result-budget-rebase.md)).

## Measurements

Canonical builds are a clean `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0 with the committed root
and web lockfiles. The restacked tree was built twice.

| Metric | Restacked build 1 / 2 | Result-budget ceiling | Kept ceiling |
| --- | ---: | ---: | ---: |
| Server JS raw | 1210838 / 1210840 | 1209856 | 1211392 |
| Server JS gzip | 338588 / 338590 | 338432 | 338688 |

No ceiling change: the restacked build fits the existing step with
margins of 554/552 raw bytes and 100/98 gzip bytes. The result-budget
ceilings reject it by 982/984 raw and 156/158 gzip bytes, so the step
is still required. Each kept raise stays under the 0.5% per-feature
limit from the original step decision. No gate, coverage floor,
file-count cap or user-facing performance target is changed or
bypassed.

## Enforcement

Unchanged: both shipping oracles keep every earlier allocation
including server raw 1211392 and server gzip 338688. Exact-head CI
remeasures composition with later features.

Undo: revert PR #1976, including its fragment change and oracle controls.
