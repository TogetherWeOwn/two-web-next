# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
event duration entry and the host-zone clock label on timed month-grid
entries, whose server-side formatting code runs in the Kit server bundle.
One 256B step, the smallest aligned cover for the measured worst case. The
supported-allocation literal for 335872 already exists in
`ci/check-kit-perf.test.mjs` (`SHIPPING_SERVER_GZIP_ALLOCATIONS`), so no test
change accompanies this raise.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `d781cb07`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185175 | 335336 | exit 0, margin 24 |
| 2 | 116 | 1185177 | 335337 | exit 0, margin 23 |

Feature merged onto the same main tip (both builds identical):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186236 | 335639 | exit 1 against 335360, 279 over |
| 2 | 116 | 1186236 | 335639 | exit 1 against 335360, 279 over |

Feature delta on the server total is +1061 raw / +302 gzip bytes (feature
worst minus pristine worst). The current 335360 ceiling rejects the
combined tree by 279B; 335872 (256 x 1312) admits it with 233B of margin
and passes the checker (exit 0). Worker, client JS and client CSS are
unchanged by this feature's measurement and fit their unchanged ceilings.

## Why the growth is justified

Members read the time commitment from a server-rendered Duration entry and
tell two host-zone clocks apart from the zone named on each timed grid
entry. Both are rendered on the server, in both the Hono and Kit twins, with
no new route, island, query or dependency. The cost is one shared formatter
and a few label fragments; the only cheaper alternative is to drop the
behaviour the change exists to deliver.
