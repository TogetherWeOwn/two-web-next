# 2026-11-03 decision: brand gradient tokens in theme-tokens.css

Raise the `public/theme-tokens.css` ceiling from 1536B raw / 512B gzip to
2560B raw / 768B gzip. The stylesheet measures 1670B raw / 568B gzip with the
checker's default `gzipSync` measurement; the new ceilings follow measured
size x1.25 rounded up (raw to 512B, gzip to 256B).

The growth adds the Logo/Icon 1 brand ramp (`--color-brand-ember`,
`--color-brand-magenta`, `--color-brand-violet`) and `--brand-gradient` to
the semantic token layer, replacing the temporary wordmark's lime accent
context with the owner's approved gradient. Components reference the tokens;
the same stops ship baked in the logo, icon and favicon artwork.
