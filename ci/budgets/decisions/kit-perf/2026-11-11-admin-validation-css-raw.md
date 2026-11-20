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

## Route CSS raw: 3072 -> 3584 on the 24 pages (gzip 1280 and file caps unchanged)

- The root layout imports `web/src/app.css` on every Kit page, so the
  same +203 raw lands in every page's route closure. The step
  `Kit route performance budgets` was skipped in run 42983341143
  because the aggregate step failed first; it would breach next.
- `2026-11-04-route-client-closure-and-ratchet.md` sets each page's CSS
  raw ceiling to min(ceil(measured x1.25 / 512) x 512, aggregate
  ceiling). Its measured 2784B (2861B for `/admin`) gives a 3584 target
  that it clipped to the 3072 aggregate. With the aggregate at 3584, the
  same rule gives 3584 for every page.
- Paired pins: every page's `css.maxRawBytes` in `ci/budgets/kit-routes.json`
  and in that decision's `Initial approved route plan` snapshot (the
  ratchet replay anchor, with a dated amendment note), and the
  snapshot's pinned digest in `ci/kit-client-ratchet.test.mjs`. The two
  endpoint-only routes stay at zero.

## Scope

Measured bytes only; it does not approve the feature, which merges
separately. No checker, gate, route inventory, file cap or exclusion
changes; the ratchet may still lower these ceilings from future
measurements. Undo: revert this allocation.
