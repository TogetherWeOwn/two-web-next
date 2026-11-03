# 2026-11-03: theme-tokens.css carries the pinned kit token surface

## public/theme-tokens.css: 1536/512 -> 2048/768 raw/gzip

Measured (CI): 1859 raw / 701 gzip. Only the breached ceilings move, by
minimal steps: raw +1x512B (189B margin), gzip +1x256B (67B margin).
Deliberately far below x1.25 (2560/1024). Every other ceiling stays fixed
and fail-closed. No gate skipped or disabled.

Attribution: the Ember Hours migration rewrites the sheet from 6 hooked
declarations to the full pinned-kit token surface (two-design-kit v0.2.0):
7 base `--theme-*` hooks plus 6 `--theme-schedule-*` overrides, every value
a kit literal, plus the ink/paper/brand/muted/surface/line aliases,
`color-scheme: dark`, and the forced-colors `Highlight` rule. Every literal
is asserted by `ci/check-ember-token-sync.mjs` (13 Hono declarations) and
the text pairs by `test/ember-contrast.test.ts`, so the bytes carry gates,
not prose.

Lean-to-fit alternatives exhausted: `@import`-ing the 8 KB vendored kit file
instead of literals would blow this budget fivefold and bloat the inlined
leaf bundle (the homepage inlines this sheet; LCP ratchets are re-based, not
raised); splitting the sheet would break the single-token-file contract the
Hono themes share. Theme stylesheets are served as authored with no minify
step, so the margins sit on deterministic bytes with no rebuild wobble.
