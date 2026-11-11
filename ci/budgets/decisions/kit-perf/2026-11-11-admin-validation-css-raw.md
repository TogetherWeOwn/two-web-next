# 2026-11-11 decision: Kit admin validation-state client CSS raw

Measured-budget allocation for the Kit client CSS cost of the admin
validation summary and field-error contrast fix (PR #2115, WCAG 2.2 AA
on the dark canvas). Only the client CSS raw ceiling moves; gzip, file
count, and every other unit are unchanged.

## client.css: raw 3072 -> 3584 (gzip 1280 and 4 files unchanged)

- Measured on GitHub Actions (`check` job, step `Kit performance
  budgets`, `node ci/check-kit-perf.mjs`); no local build:
  - main `c7b6a48c9`, run 42981215163: CSS 2/4 files, 3032 raw /
    1174 gzip bytes (40B raw headroom left after the design-kit token
    migration, #2032).
  - PR #2115 head `b275c12a1`, run 42983341143: `client css: raw 3235B
    over 3072B` (+203 raw). Gzip and file count pass.
- The delta is the PR's unlayered rules in `web/src/app.css`: the
  validation summary surface, its link colour and focus ring, and the
  field-error treatment. Removing 163B would remove the fix itself.
- Old raw ceiling 3072; measured exceeds it by 163B.
- New raw ceiling 3584: one 512B step (349B margin), the minimum
  repository-conforming step and the default headroom target already
  named for CSS raw in `2026-11-04-route-client-closure-and-ratchet.md`.
  It is below x1.25 of measured (4044B).
- Paired pins: `INITIAL_CLIENT_BUDGET.css` in
  `ci/client-ratchet-approval.mjs` (the approved base of the lower-only
  ratchet chain) and `SHIPPING_KIT_BUDGET` in
  `ci/budget-fragments.test.mjs` move to 3584. The CSS raw cases in
  `ci/check-kit-perf.test.mjs` move to a 3235-byte newly-allowed
  interval, the exact 3584 ceiling, and 3585 one-over. A revert rejects
  the interval; a further widening fails the one-over case.

## Scope

Measured bytes only; it does not approve the feature, which merges
separately. No checker, gate, route budget or exclusion changes; the
ratchet may still lower this ceiling from future measurements. Undo:
revert this allocation.
