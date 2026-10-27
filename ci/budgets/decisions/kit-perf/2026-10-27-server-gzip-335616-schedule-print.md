# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335616

`server.js.maxGzipBytes` rises 335360 -> 335616 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. One 256B step,
the smallest aligned cover for the schedule print scope line, which ships
a Svelte stamp in the Kit archive page and the shared `printScopeCopy`
helper into the Kit server bundle.

## Measurements

Production builds (`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, Node 24.22.1.

Pristine main `cd50096f3`: 116 server files, 1185177 raw / 335335 gzip
(exit 0, margin 25).

Feature composed on the same main, two builds (worst case governs):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186175 | 335585 | exit 1, 225 over |
| 2 | 116 | 1186177 | 335588 | exit 1, 228 over |

Worst case 335588: 335360 rejects it by 228B and 335616 (256 x 1311)
admits it with 28B of margin. Server delta is +1000 raw / +253 gzip over
pristine main with no new files. Worker (2551/1219B) is unchanged; client
JS grows 254926/102621B -> 255261/102762B (the same Svelte page ships a
structural client node) and still fits its unchanged 256000/103168B
ceilings, client CSS is unchanged.

## Shipping tests

`ci/check-kit-perf.test.mjs` gains an additive 335616 allocation (fixed
335588 / 335616 / 335617 interval, exact and one-byte-over literals; existing
entries byte-identical). `ci/budget-fragments.test.mjs` admits 335616 in
`SHIPPING_SERVER_GZIP_ALLOCATIONS`; its unsupported-allocation control moves
from 335616 to 335617 and 335872.

No feature, checker, dependency, workflow, mask or exclusion changes ship in
this decision. Exact-head CI and independent review remain mandatory. If a
sibling allocation lands first, reconcile as a union and re-measure on the
new main tip. Undo: revert this fragment step, the two test additions and
this record.
