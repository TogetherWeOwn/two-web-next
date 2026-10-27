# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. One 256B step,
the smallest aligned cover for the composition of the schedule print scope
line with the event-time duration entry and host-zone clock labels, both
independently justified, on current main.

## Measurements

Locked Node v24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Main tip `c067ea49` (npm-minor-patch group bump) with feature head
`cc110765b` merged, both builds exit 0 against 336128:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336128 |
|---|---:|---:|---:|---|
| 1 | 116 | 1187666 | 335949 | exit 0, margin 179 |
| 2 | 116 | 1187666 | 335951 | exit 0, margin 177 |

Worst case 335951: 336128 (256 x 1313) admits it with 177B of margin.
The same build output against 335872 exits 1 (rejects by 79B); the ceiling
was restored md5-verified afterwards. An earlier merge onto `7d5db1c21`
measured 335952/335954; main then moved by the dependency bump, so the
merge was redone onto the tip and re-measured rather than trusted.

Worker (2551/1219B) and client CSS (2861/1019B) are unchanged. Client JS
measures 255488 raw / 102830 gzip (54 files) and fits its unchanged
257024/103168 ceilings with 1536/338B of margin.

## Why the growth is justified

Both composed features carry their own landed justifications: the schedule
print scope line (335616 decision) ships a Svelte stamp in the Kit archive
page plus the shared `printScopeCopy` helper, and the event-time slice
(335872 decision) ships server-rendered duration and clock labels. This
decision adds no new growth beyond their union: 335954 worst on the stale
merge moved to 335951 on the tip, inside rebuild jitter plus the dependency
bump. The only cheaper alternative is to drop one of the two behaviors.

## Shipping tests

`ci/check-kit-perf.test.mjs` already carries the 336128 allocation on main
(interval 335977, landed separately); this change keeps that single key
rather than forking it. This composition's measurement, 335951, lies in the
same (335872, 336128] interval, so it proves the same step.
`ci/budget-fragments.test.mjs` unions to
`SHIPPING_SERVER_GZIP_ALLOCATIONS = [335104, 335360, 335616, 335872, 336128]`:
the 335616 and 335872 admit tests are kept byte-identical from each side, a
336128 admit test is added, and the unsupported-allocation control probes
`[335105, 335359, 335617, 336127]`.

No feature, checker, dependency, workflow, mask or exclusion changes ship in
this decision. Exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test additions and this record.
