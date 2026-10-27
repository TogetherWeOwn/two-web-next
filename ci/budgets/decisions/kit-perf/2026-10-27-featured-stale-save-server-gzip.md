# 2026-10-27 decision: server JS gzip ceiling 335360 -> 336128

`server.js.maxGzipBytes` rises 335360 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured stale-save refusal: the saved-content baseline, the in-lock
comparison and the conflict page add server-side code to the Kit server
bundle. Three 256B steps, the smallest aligned cover for the measured
worst case (two steps, 335872, rejects by 177B).

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree.

| Tree | Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---|---:|---:|---:|---|
| Pristine main tip `cb0f15736` | 1 | 116 | 1185441 | 335349 | exit 0, margin 11 |
| Pristine main tip `cb0f15736` | 2 | 116 | 1185439 | 335348 | exit 0, margin 12 |
| Feature head (main tip merged in) | 1 | 116 | 1187811 | 336049 | exit 1, 689 over |
| Feature head (main tip merged in) | 2 | 116 | 1187811 | 336049 | exit 1, 689 over |

Worst case 336049. 335360 rejects it by 689B, 335872 by 177B; 336128
(256 x 1313) admits it with 79B of margin. Feature delta on the server
total is +2370 raw / +700 gzip bytes, no new server files. Worker
(2551/1219B), client JS (54 files, raw 255013 of 256000, gzip 102658 of
103168) and client CSS (2861/1019B) fit their unchanged ceilings.

Rebuild jitter is disclosed, not signal: pristine wobbles +2/+1B across
rebuilds, the feature head was byte-identical across builds.

## Why one PR

Repo routing for budget conflicts: a feature PR carries its measured
affected fragment, this decision and the matching shipping-test
allocation entries (`ci/check-kit-perf.test.mjs`,
`ci/budget-fragments.test.mjs`, both additive; earlier allocations stay
byte-identical) rather than waiting on separate allocation PRs. The
earlier separate budget card was closed unmerged because the monolith it
targeted no longer exists on main.

Main's own margin is 11B, so any further server growth needs its own
step; this decision does not pre-spend that headroom.

Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the two allocation entries and this record.
