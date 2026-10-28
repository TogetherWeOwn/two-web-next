# 2026-10-27 decision: dashboard native-focus Kit client CSS gzip

Measured-budget allocation for the Kit client CSS cost of the admin
dashboard native outcome-link focus selector (the independent review
finding pinned by the admin diagnostics regression test). Only the
client CSS gzip ceiling moves; raw, file count, and every other unit
are unchanged.

## client.css: gzip 1024 -> 1280 (raw 3072 and 4 files unchanged)

- Measured with locked installs (Node 24.22.1, npm 11.19.1,
  `npm run build --prefix web`, then `node ci/check-kit-perf.mjs`),
  two builds per tree, byte-identical between builds:
  - main `cd50096f3`: CSS 2 files, 2861 raw / 1019 gzip bytes.
  - main composed with the diagnostics product head `9ed9fd6c5`
    (clean `git merge-tree` of the code; only a test file conflicts):
    CSS 2 files, 2928 raw / 1042 gzip bytes (+67 raw / +23 gzip).
- The delta is the native-focus rule on the dashboard page CSS; the
  shared root stylesheet is byte-identical to main.
- Old gzip ceiling 1024; measured exceeds it by 18B.
- New gzip ceiling 1280: one 256B step (238B margin), the minimum
  repository-conforming step, far below x1.25 of measured.
- Real-artifact controls on the composed build, other ceilings raised
  only to isolate this axis: 1041 rejects (exit 1, `1042B over 1041B`);
  1042 and 1280 admit (exit 0).
- Paired pins: `SHIPPING_KIT_BUDGET` in `ci/budget-fragments.test.mjs`
  moves to 1280, and the CSS gzip cases in `ci/check-kit-perf.test.mjs`
  move to a 1029-byte newly-allowed interval, the exact 1280 ceiling,
  and 1281 one-over. A revert rejects the interval; a further widening
  fails the one-over case.

## Not admitted here

The same composition also exceeds the server gzip (335692 vs 335360)
and client JS raw/gzip (256120/103205 vs 256000/103168) ceilings on
current main. Those are separate allocations owned by the consumer of
the product branch; this decision admits the CSS dimension only.

## Scope

Measured bytes only; it does not approve the feature, which merges
separately. No checker, gate, or exclusion changes. Undo: revert this
allocation.
