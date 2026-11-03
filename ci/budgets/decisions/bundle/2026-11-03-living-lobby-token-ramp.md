# 2026-11-03 decision: Living Lobby token-ramp ceilings for theme-tokens.css

## public/theme-tokens.css: 1536/512 -> 5120/2048

- Measured with `node ci/check-bundle-budget.mjs` (node zlib default
  gzip, no filename header): 3726 raw / 1527 gzip bytes.
- Old ceilings 1536 raw / 512 gzip; measured exceeds raw by 2190B and
  gzip by 1015B.
- New ceilings 5120 raw / 2048 gzip: measured x1.25 rounded up (raw
  4657.5 -> 5120 to 512B; gzip 1908.75 -> 2048 to 256B), the
  repository rule. Margins 1394B raw / 521B gzip.
- Why: the Living Lobby design section 3.1 token migration lands the
  full two-ground ramp in this one shared sheet — action-ground
  ground/raised/raised-2, text-1 through text-4, ember, live, ok,
  3px focus, the records cream/ink set, font-role stacks, radius and
  band-spacing tokens, plus the per-brand override plugs the themed
  sheets consume. The old ceiling covered a single-line ramp; the
  commented, sectioned sheet is the documented mapping surface for
  the migration, not bloat.
- No checker, gate, or exclusion changes: over-ceiling fixtures still
  fail closed through the unchanged checker, and
  `SHIPPING_BUNDLE_BUDGETS` in `ci/budget-fragments.test.mjs` moves
  with the fragment. `public/theme.css` (14094/3376 against
  15360/3584) stays within its ceiling: five self-hosted role faces
  (Space Grotesk 700, Atkinson 400/700, Plex Mono 400, Source Serif 4
  italic 600). The two exact-500 statics were dropped so the inlined
  bundle keeps the LCP pin of no exact medium-weight declaration.

## Scope

This allocation carries measured bytes only for the token layer; the
themed sheets that consume the tokens migrate on later Living Lobby
cards. Parallel branch `feat/brand-logo-icon1` raised this same
fragment to 2560/768 for the logo slice; whichever merges second
re-derives from the other's ceiling under this same rule.
