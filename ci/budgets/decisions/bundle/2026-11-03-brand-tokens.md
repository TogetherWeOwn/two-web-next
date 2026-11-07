# Brand color tokens: retain the existing bundle ceiling

Retain the existing `public/theme-tokens.css` ceiling of 1536B raw / 512B
gzip. The stylesheet measures 1303B raw / 371B gzip with the checker's
`gzipSync` measurement, so the Logo/Icon 1 tokens fit without a budget
increase. The earlier proposed 1792B raw ceiling was unnecessary and was
removed before review. No threshold change is part of this brand swap.

The growth over the original placeholder adds the Logo/Icon 1 brand ramp
(`--color-brand-ember`, `--color-brand-magenta`, `--color-brand-violet`)
to the semantic token layer. The tokens use three Biome-formatted lines.
The bundle inlines verbatim into homepage critical CSS; rationale lives
in ci/build-leaf-css.mjs, not in the shipped CSS.

No gradient token: nothing references one, and the ramp stops already ship
baked in the logo, icon and favicon artwork. A component that needs a
gradient re-adds the token with its own budget.
