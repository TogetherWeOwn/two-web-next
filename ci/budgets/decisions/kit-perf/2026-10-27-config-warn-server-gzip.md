# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
once-per-isolate invalid-operator-config warning (`src/config-warn.ts`,
called from `src/image-policy.ts`, `src/events/routes-shared.ts`,
`src/agent-events/route.ts` and `src/csp-reports.ts`), whose helper and
four call sites ship into the Kit server bundle. One 256B step, the
smallest supported cover: the next lower step 335616 is not an approved
allocation in `ci/check-kit-perf.test.mjs` and would leave 1B of margin.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree, same installed
dependencies. Worst case governs.

Pristine main `4cd035fd8`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185441 | 335349 | exit 0, margin 11 |
| 2 | 116 | 1185439 | 335349 | exit 0, margin 11 |

Feature merged with main (this head):

| Build | Server gzip | Gate |
|---|---:|---|
| 1 | 335613 | exit 1, 253 over |
| 2 | 335615 | exit 1, 255 over |

Worst case 335615: the current 335360 ceiling rejects it by 255B and
335872 admits it with 257B of margin. Feature delta on server gzip is
+264B (local worst minus pristine worst). Client JS (54/55 files) is
255153/256000 raw and 102751/103168 gzip against 254926/102621 on main,
a +227/+130 delta that fits its unchanged ceilings; worker and client CSS
are byte-identical to main and fit. Rebuild jitter of 1-2B is disclosed,
not signal.

## Scope

The earlier append-only history of this branch's Kit budget notes lived in
the retired monolith `ci/kit-perf-budget.json`. Every numeric ceiling in
it already equalled main's, so nothing is ported: this record carries the
only ceiling change. No feature, checker, dependency, workflow, mask or
exclusion changes ship here. `ci/budget-fragments.test.mjs` gains the
335872 allocation as an additive entry. Startup, runtime, staging and
release acceptance are not claimed; exact-head CI and independent review
remain mandatory. Undo: revert this fragment step, the test entry and
this record.
