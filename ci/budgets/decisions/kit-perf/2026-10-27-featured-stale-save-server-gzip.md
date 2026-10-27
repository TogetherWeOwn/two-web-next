# 2026-10-27 decision: server JS gzip ceiling 336128 -> 336640

`server.js.maxGzipBytes` rises 336128 -> 336640 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured stale-save refusal: the saved-content baseline, the in-lock
comparison and the conflict page add server-side code to the Kit server
bundle. Two 256B steps, the smallest aligned cover for the measured worst
case (one step, 336384, rejects by 160B).

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`.

| Tree | Build | Server files | Gzip bytes | Gate |
|---|---|---:|---:|---|
| Pristine main tip `e37975a07` | 1 | 116 | 335835 | exit 0, margin 293 |
| Feature head (main tip merged in) | 1 | 116 | 336544 | exit 1 against 336384, 160 over |
| Feature head (main tip merged in) | 2 | 116 | 336541 | exit 1 against 336384, 157 over |

Worst case 336544. 336640 (256 x 1315) admits it with 96B of margin.
Feature delta on the server total is about +706 gzip bytes, no new server
files. Rebuild jitter (+-3B between identical-tree builds) is disclosed,
not signal.

## Why one PR

Repo routing for budget conflicts: a feature PR carries its measured
affected fragment, this decision and the matching shipping-test
allocation entries (`ci/check-kit-perf.test.mjs`,
`ci/budget-fragments.test.mjs`, both additive; earlier allocations stay
byte-identical) rather than waiting on separate allocation PRs.

Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the allocation entries and this record.
