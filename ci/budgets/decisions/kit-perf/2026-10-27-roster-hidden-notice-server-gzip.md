# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335616

`server.js.maxGzipBytes` rises 335360 -> 335616 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
roster-hidden notice on a refused admin event edit (PR #1862). The Hono
admin app is bundled into the Kit server chunk `chunks/admin.js`, so the
notice markup and the two route branches ship in the Kit server bundle and
cannot be avoided without forking the admin app. One 256B step, the smallest
aligned cover for the measured worst case.

## Measurements

Production builds (`npm run build --prefix web`) measured through
`node ci/check-kit-perf.mjs`, two builds per tree, on current main tip
`ba58281d2`, Node 24.22.1 from the lockfile. Worst case governs.

Pristine main:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185441 | 335351 | exit 0, margin 9 |
| 2 | 116 | 1185439 | 335349 | exit 0, margin 11 |

Main plus the #1862 head `5c59cadf7` (clean merge, three files):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335360 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186044 | 335554 | exit 1, 194 over |
| 2 | 116 | 1186042 | 335555 | exit 1, 195 over |

Worst case is 335555 (CI on the same head measured 335554, inside rebuild
jitter). The feature delta is +603 raw / +204 gzip bytes. Raw (1203200) and
file count (126) fit their unchanged ceilings; worker (2551/1219B), client
JS (54 files, 254926/102621B) and client CSS (2 files, 2861/1019B) fit
unchanged. The current 335360 ceiling rejects the combined tree by 195B;
335616 (256 x 1311) admits it with 61B of margin.

## Attribution

The growth is server-only. The #1862 diff touches
`src/admin/pages/event-form-page.tsx`, `src/admin/routes.tsx` and one
acceptance test; the first two are bundled into `chunks/admin.js`. Trimming
the notice cannot recover 195B.

## Shipping tests

`ci/check-kit-perf.test.mjs` already supports 335616 (fixed 335504 / 335616 /
335617 literals), so it passes unchanged. In
`ci/budget-fragments.test.mjs` the shipping pin and allowed-allocation list
move with the ceiling, 335616 is now an admitted allocation (the
"unsupported" control uses 335617), and the 335872 step stays unsupported.

If another budget PR lands first and consumes the headroom, the true
composition must be re-measured on the then-current main and this step
re-chosen. No feature, checker, dependency, workflow, mask or exclusion
changes ship here. Exact-head CI and independent review remain mandatory.
Undo: revert only this fragment step, the test pins and this record.
