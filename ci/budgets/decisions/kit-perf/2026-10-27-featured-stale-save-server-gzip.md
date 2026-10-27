# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336384

`server.js.maxGzipBytes` rises 335872 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured stale-save refusal: the saved-content baseline, the in-lock
comparison and the conflict page add server-side code to the Kit server
bundle. Two 256B steps, the smallest aligned cover for the measured worst
case (one step, 336128, rejects by 231B).

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree.

| Tree | Build | Server files | Gzip bytes | Gate |
|---|---|---:|---:|---|
| Pristine main tip `d9b213141` | 1 | 116 | 335652 | exit 0, margin 220 |
| Pristine main tip `d9b213141` | 2 | 116 | 335652 | exit 0, margin 220 |
| Feature head (main tip merged in) | 1 | 116 | 336358 | exit 1, 230 over 336128 |
| Feature head (main tip merged in) | 2 | 116 | 336359 | exit 1, 231 over 336128 |

Worst case 336359. 335872 rejects it by 487B, 336128 by 231B; 336384
(256 x 1314) admits it with 25B of margin. Feature delta on the server
total is about +706 gzip bytes, no new server files. Worker (2551/1219B),
client JS (54 files, raw 255205 of 257024, gzip 102701 of 103168) and
client CSS (2861/1019B) fit their unchanged ceilings.

Rebuild jitter (+-1B between identical-tree builds) is disclosed, not
signal.

## Why one PR

Repo routing for budget conflicts: a feature PR carries its measured
affected fragment, this decision and the matching shipping-test
allocation entries (`ci/check-kit-perf.test.mjs`,
`ci/budget-fragments.test.mjs`, both additive; earlier allocations stay
byte-identical) rather than waiting on separate allocation PRs. Main's
own margin is 220B, so this decision does not pre-spend headroom beyond
the feature's measured delta.

Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the allocation entries and this record.
