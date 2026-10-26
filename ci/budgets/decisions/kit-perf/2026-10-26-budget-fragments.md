# 2026-10-26 decision: split the Kit budget monolith into fragments

No ceiling changes. `ci/kit-perf-budget.json` is replaced by one
fragment per atomic unit in `ci/budgets/kit/` (`worker.json`,
`server-js.json`, `client-js.json`, `client-css.json`, `startup.json`),
aggregated at CI time by `ci/budget-fragments.mjs`.

Why: the monolith's single-line `$comment` carried the entire decision
history (623,430 of its 624,014 bytes), so every ceiling change rewrote
the same line and conflicted with every other open branch. A ceiling
change now edits only its own fragment and adds one decision file in
this directory.

Ceilings are byte-identical in value to the monolith at the split
(worker 3584/1536; server js 1203200/335104, 126 files; client js
254976/102912, 55 files; client css 3072/1024, 4 files; startup
60000ms), proven by `ci/budget-fragments.test.mjs` and by deep-equality
of the aggregation against the monolith before its deletion. The full
pre-split `$comment` history is preserved verbatim in
`0000-legacy-history-through-2026-10-26.md` (sha256-pinned by the same
test). Not feature or release approval.
