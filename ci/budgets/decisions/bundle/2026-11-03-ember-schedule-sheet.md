# Ember schedule sheet ceiling: 6144 -> 6656 raw

## Measured

- `public/schedule-theme.css`: 6144 raw bytes, 1706 gzip bytes.
- Prior size on `main`: 6142 raw bytes (ceiling 6144, gzip ceiling 1792).

## Change

- `maxRawBytes`: 6144 -> 6656 (next 512 B step; measured x1.25 would be
  7680, but the minimal step holds per the 2026-11-03-ember-token-sheet
  precedent for deterministic bytes).
- `maxGzipBytes`: unchanged at 1792 (measured 1706 still fits).

## Why the growth is justified

The Ember Hours migration to two-design-kit v0.2.0 replaces the
`Display` fallback stack on `.events-page .schedule-date` with the kit
`Mona Sans, 'Mona Sans Fallback', system-ui, sans-serif` stack
(`test/display-fallback-stacks-acceptance.test.ts` requires the local
fallback in every Mona Sans stack). That single required stack is the
entire +2 byte delta; no rules were added. The sheet stays scoped,
`@import`-free, and `@font-face`-free per `test/page-shells.test.ts`.
