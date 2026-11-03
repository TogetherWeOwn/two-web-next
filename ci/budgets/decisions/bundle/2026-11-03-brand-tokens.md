# 2026-11-03 decision: brand color tokens in theme-tokens.css

Set the `public/theme-tokens.css` ceiling to 1792B raw / 512B gzip. The
stylesheet measures 1292B raw / 369B gzip with the checker's default
`gzipSync` measurement; the ceilings follow measured size x1.25 rounded up
(raw to 512B, gzip to 256B).

The growth over main adds the Logo/Icon 1 brand ramp (`--color-brand-ember`,
`--color-brand-magenta`, `--color-brand-violet`) to the semantic token layer.
The tokens ship as one spaceless, comment-free line: the bundle inlines
verbatim into the homepage critical CSS under a 24.8 kB ratchet
(test/homepage-mobile-lcp-acceptance.test.ts), so every byte ships on first
paint. Rationale lives in ci/build-leaf-css.mjs, not in the shipped CSS.

No gradient token: nothing references one, and the ramp stops already ship
baked in the logo, icon and favicon artwork. A component that needs a
gradient re-adds the token with its own budget.
