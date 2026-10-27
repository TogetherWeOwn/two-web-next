# 2026-10-26 decision: client JS raw 256000 -> 257024 for the honest event-detail roster and venue

`client.js.maxRawBytes` rises 256000 -> 257024 in `ci/budgets/kit/client-js.json`; no other ceiling changes. This covers the measured client growth of the honest event-detail roster and TBD-venue slice (feature PR #1499) composed with current main. Client gzip stays at main's 103168 (the composition measures 103008, a 160B margin, so no gzip step is needed) and file count stays 55 (measured 54).

## Frozen inputs

- Main: `ba58281d211479b934ff268f54f296d2d29adfaa`. Main moved through events-detail and calendar product commits since the earlier 256512 measurement (`4b2a8ce3f`); that proposal is superseded by this remeasurement.
- Feature: actual #1499 head `26fd963642faef083e77db37c37d458217111a6a` (branch `feat/event-detail-honest-roster-venue`, still open at end of measurement).
- `git merge-tree --write-tree --messages` yields tree `efd933e81c395300e41bc72d81660068144cdf1e` with only the two legacy-budget modify/delete conflicts (feature versions left in tree); product sources (`src/events/pages-detail.tsx`, `web/src/lib/EventDetail.svelte`) merge cleanly. The tree is materialized with `git archive`; the resolution respects main's deletion of `ci/bundle-budget.json` and `ci/kit-perf-budget.json`. This decision ships no Hono change and is not authority for one.
- Toolchain: locked Node v24.22.1 / npm 11.19.1. Root and web lockfiles are byte-identical across main and the merged tree; both build trees use the same installed dependencies.

## Repeated canonical measurements (twice per tree)

`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`. All four builds exit 0.

| Group | Pristine main (both) | Actual integration (b1 / b2) | Incoming ceilings | Result |
| --- | --- | --- | --- | --- |
| Worker raw / gzip | 2551 / 1219 | 2551 / 1219, identical | 3584 / 1536 | pass |
| Server JS raw | 1185439 / 1185441 | 1188473, identical | 1203200 | pass |
| Server JS gzip | 335351 / 335347 | 335914 / 335925 | 335360 | fail by 554 / 565 (separately owned, not this decision) |
| Server JS files | 116 | 116, identical | 126 | pass |
| Client JS raw | 254926 | 256578, identical | 256000 | fail by 578 |
| Client JS gzip | 102621 | 103008, identical | 103168 | pass (160B margin) |
| Client JS files | 54 | 54, identical | 55 | pass |
| Client CSS raw / gzip | 2861 / 1019 | 2861 / 1019, identical | 3072 / 1024 | pass |
| Client CSS files | 2 | 2, identical | 4 | pass |

Feature increment over current main: client +1652 raw / +387 gzip. Pristine checker exits 0 twice; integration checker exits 1 twice (client raw, plus the separately owned server gzip).

## Attribution: the growth is one route chunk of required UI

52 of 54 client chunks are byte-identical across the merge (same content-hashed filename and bytes). Only two chunks change: `entry/app.*.js` (5596 raw both; the rehashed import specifier) and `nodes/22.*.js`, the event-detail route (17291 -> 18943 raw). The route chunk carries the required roster states (guest sign-in nudge, members-only explainer, honest empty state) and the TBD-venue row; the feature's only web change is `web/src/lib/EventDetail.svelte`. Compiled template output has no comment or whitespace slack, and every other chunk is identical. No behavior-preserving reduction is available: cutting bytes means cutting required roster/venue/a11y behavior or editing feature-owned source outside a budget card's scope. Hence a measured allocation.

## Least-cover sizing (no broad headroom)

- Raw: one 512B step to 256512 still fails (66B short of measured 256578). Two steps to 257024 is the least 512B-aligned cover (446B margin).
- Gzip: no change; measured 103008 fits main's 103168.
- The README x1.25 default is deliberately not applied: this decision carries only the measured slice plus alignment.

## Scratch accept/reject ladder (integration build output, only the raw ceiling varied)

Raw ceiling 256000 rejects, 256512 rejects, 256577 rejects, exact 256578 accepts, shipping 257024 accepts. The `kit.client.js` group status is read from the checker JSON, so the unrelated server gzip breach is isolated from the verdict. Every smaller aligned or boundary value fails closed.

## Enforcement and coevolution

- The shipping-budget regression cases and aggregate pins coevolve with the independent test owner's delivery (raw exact/one-byte-over at 257024/257025, plus two fits cases); this decision edits no test assertion of its own. The two fits cases use 256580 raw and 103073 gzip, the earlier measurement of this same composition on the previous main; they are retained as regression inputs like the earlier 255253 and 255872 cases, still fit the ceilings (the current 256578/103008 fits too), and are not a claim about the current measurement.
- Server gzip (335914/335925 vs 335360) is owned separately and unchanged here. No worker, server, CSS, startup, file-count, gzip, Hono, feature, checker, dependency, workflow, mask or exclusion change ships. No staging, runtime or release acceptance is claimed; exact-head CI and independent review remain mandatory.

Undo: revert only this fragment's raw ceiling value and this decision file.
