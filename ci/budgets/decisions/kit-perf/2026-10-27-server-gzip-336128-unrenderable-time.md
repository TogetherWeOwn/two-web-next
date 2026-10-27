# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
moderator unrenderable-time inventory repair, whose server-side guards grow
the Kit server bundle past the current ceiling once merged onto the 335872
event-time allocation. One 256B step, the smallest aligned cover for the
measured worst case. The supported-allocation literal for 336128 already
exists in `ci/check-kit-perf.test.mjs` (`SHIPPING_SERVER_GZIP_ALLOCATIONS`),
so that suite passes unchanged.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds of the merged tree (this branch
merged with main at `7d5db1c21`). Worst case governs.

| Build | Server gzip bytes | Gate against 335872 |
|---|---:|---|
| 1 | 335922 | exit 1, 50 over |
| 2 | 335920 | exit 1, 50 over (worst 335922) |

The earlier standalone measurement of this feature on its previous base was
+258 gzip bytes over pristine (335608 vs 335350). Main's own event-time
allocation (335639 on its feature) already consumed most of the 335872 step;
the merged tree no longer fits it. Worker, client JS and client CSS fit
their unchanged ceilings (client JS 54 files, 255537/102767B).

The current 335872 ceiling rejects the combined tree by 50B; 336128
(256 x 1313) admits it with 206B of margin and passes the checker.

## Why the growth is justified

Moderators must be able to open the inventory and repair an event whose
stored time cannot be represented as a JS Date. The guards live in
`src/admin/kit-events.ts` (`renderableIso`), `src/admin/kit-event-edit.ts`,
`src/admin/pages/events-list.tsx`, `src/admin/pages/shell.tsx`,
`src/admin/store-event-writes.ts` and the Kit list placeholder in
`web/src/routes/admin/events/+page.svelte`, all shipping into the Kit
server bundle through the Hono catch-all and the Kit admin nodes. Without
them one bad row throws the whole inventory.

Several sibling allocation PRs also propose 336128 with their own
witnesses; any interval in (335872, 336128] proves this step, so whichever
lands first keeps the key and the others re-measure on the new base.

## 2026-10-27 merge addendum: sibling 336128 landed first

Main landed the Happening-now 336128 step (`5919f44c4`) before this branch
merged, so the oracle comment conflicted and was resolved as a union: both
decision records stand and the 336128 admission is shared. Re-measured on
the combined tree (this branch merged with main at `e37975a07`), locked
Node 24.22.1 / npm 11.19.1, two production builds: 336099 and 336097 gzip
bytes, worst 336099, margin 29 under the unchanged 336128 ceiling. No new
step is needed.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceiling: the 336128
allocation is added to the oracle list with an admit case; 335616 stays
unsupported. No feature, checker, dependency, workflow, mask or exclusion
changes ship here. Exact-head CI and independent review remain mandatory.
Undo: revert only this fragment step, the expectation pin and this record.
