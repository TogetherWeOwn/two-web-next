# 2026-10-26 decision: split the bundle budget monolith into fragments

No ceiling changes. `ci/bundle-budget.json` is replaced by one fragment
per budgeted asset in `ci/budgets/bundle/` (23 files, named
`<asset file name>.json`), aggregated at CI time by
`ci/budget-fragments.mjs` for `ci/check-bundle-budget.mjs` and
`ci/minify-assets.mjs`.

Why: the monolith's single-line `$comment` carried the decision history
(15,298 of its 17,629 bytes), so every ceiling change rewrote the same
shared lines and conflicted with other open branches. A ceiling change
now edits only its asset's fragment and adds one decision file in this
directory; a new served asset gets a new fragment.

All 23 entries are identical in value to the monolith at the split,
proven by `ci/budget-fragments.test.mjs` and by deep-equality of the
aggregation against the monolith before its deletion. The full
pre-split `$comment` history is preserved verbatim in
`0000-legacy-history-through-2026-10-26.md` (sha256-pinned by the same
test). Not feature or release approval.
