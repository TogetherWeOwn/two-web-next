# 2026-11-03 decision: tighten token ceiling after the served-prose trim

## public/theme-tokens.css: 5120/2048 -> 3072/1024

- Measured with `node ci/check-bundle-budget.mjs` (node zlib default
  gzip, no filename header): 2236 raw / 788 gzip bytes.
- Old ceilings 5120 raw / 2048 gzip (set by
  `2026-11-03-living-lobby-token-ramp.md` for the 3726-byte commented
  sheet) exceed the repository rule for the trimmed sheet: measured
  x1.25 rounded up (raw 2795 -> 3072 to 512B; gzip 985 -> 1024 to
  256B). The loose ceiling would admit ~1.8 KB of unreviewed growth
  before the checker rejects it.
- New ceilings 3072 raw / 1024 gzip; margins 836B raw / 236B gzip.
- Why now: the value-mapping prose moved to `docs/home-theme.md`, so
  the served sheet is the final section-3 token layer at 2236 bytes.
  The tighter ceiling keeps the 1.25x rule honest without blocking
  later Living Lobby cards (they migrate the themed consumer sheets,
  each with its own ceiling).
- No checker, gate, or exclusion changes. `SHIPPING_BUNDLE_BUDGETS`
  in `ci/budget-fragments.test.mjs` moves with the fragment.
- Parallel branch `feat/brand-logo-icon1` raised this same fragment
  for the logo slice; whichever merges second re-derives from the
  other's ceiling under this same rule.
