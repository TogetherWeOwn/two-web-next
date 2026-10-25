# Kit error correlation: combined server gzip allocation

## Decision

Raise only `server.js.maxGzipBytes` in `ci/kit-perf-budget.json` from **333568**
to **333824 bytes**: one 256-byte step, the smallest aligned ceiling fitting both
repeated combined builds. Keep every other byte ceiling, file cap, startup bound,
and the complete main `$comment` history unchanged. The checker, required inventory,
constraints, workflows, dependencies, application, and tests are unchanged.

This allocation accounts for the measured server cost of
[request correlation on Kit errors](https://github.com/TogetherWeOwn/two-web-next/pull/1475).
It is not feature acceptance, a reserved allocation, staging evidence, or release
approval. The feature owner must remeasure the actual integrated head and pass
exact-head CI and independent review. No gate is skipped or weakened.

## Pinned inputs

- Pristine main: `853f954bdf7b2c851b14185d58157b217e4454d7`.
- Combined feature: `b5f461665bf6ec1c638d5e2ad812bfcbd5ed2249`.
- Main is an ancestor of the combined feature; no speculative source resolution is
  needed. Only the measurement copy's budget is restored to pristine main.
- Node `24.22.1`, npm `11.19.1`; locked root and web installs with
  `npm ci --include=dev --no-audit --no-fund`.
- Root lock SHA-256: `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`.
- Web lock SHA-256: `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both package manifests, both lockfiles, `web/vite.config.ts`,
  `ci/check-kit-perf.mjs`, and `ci/bundle-inventory.mjs` are byte-identical between
  the two source trees.

Both trees are built sequentially at the same scratch path with the same installed
dependencies, outside synced worktrees. Database-URL and Postgres/DB binding
environment keys are removed. No database, staging, production, probe, migration,
or deployment is part of this experiment.

## Repeat builds and negative control

Run twice per tree:

```sh
NODE_ENV=production npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four production builds exit `0`. Gzip figures use the unchanged canonical
Node checker, which sums each JavaScript file's `gzipSync` size; these are not a
concatenated archive size or a different compressor.

| Server JavaScript | Files / cap | Raw bytes / ceiling | Gzip bytes | Checker at 333568 |
| --- | ---: | ---: | ---: | --- |
| Pristine main, build 1 | 115 / 126 | 1174980 / 1203200 | 332939 | exit 0 |
| Pristine main, build 2 | 115 / 126 | 1174982 / 1203200 | 332940 | exit 0 |
| Combined feature, build 1 | 116 / 126 | 1177885 / 1203200 | 333758 | exit 1, +190 bytes |
| Combined feature, build 2 | 116 / 126 | 1177885 / 1203200 | 333755 | exit 1, +187 bytes |

On each combined build's unchanged artifacts, change **only** the server gzip
ceiling and rerun the canonical checker:

| Server gzip ceiling | Combined build 1 | Combined build 2 |
| --- | --- | --- |
| 333568: one step less / unchanged main | exit 1; server gzip only | exit 1; server gzip only |
| 333824: proposed | exit 0; margin 66 bytes | exit 0; margin 69 bytes |

`ceil(max(333758, 333755) / 256) * 256 = 333824`. The observed maximum exceeds
one step less by 190 bytes. A smaller aligned ceiling cannot fit. The step is not
a blanket 25% allowance, and the small remaining margin is not promised to any
other feature.

Both combined builds fit every unaffected group at main's unchanged ceilings:

| Group | Files / cap | Raw bytes / ceiling | Gzip bytes / ceiling |
| --- | ---: | ---: | ---: |
| Worker entry | one canonical entry | 2551 / 3584 | 1219 / 1536 |
| Client JavaScript | 54 / 55 | 254310 / 254464 | 102553 / 102912 |
| Client CSS | 2 / 4 | 2861 / 3072 | 1019 / 1024 |

Pristine client JavaScript is 54 files, 253330 raw / 102135 gzip bytes; pristine
CSS is 2 files, 2833 raw / 1006 gzip bytes. The worker is unchanged. The startup
bound remains `60000ms`; startup latency was not measured.

## Attribution and repeat identity

The combined server costs 2903–2905 more raw bytes and 815–819 more gzip bytes
than the repeated pristine measurements, with one added server file. Comparing
second builds, 32 server paths have a different hash or are added; none are
removed. The sole added path is `entries/pages/_layout.server.ts.js` (192 raw /
166 gzip bytes). These paths are relative to `web/.svelte-kit/output/server`.

Largest raw increases in that comparison:

| Server path | Raw delta | Gzip delta |
| --- | ---: | ---: |
| `chunks/events.js` | +689 | +195 |
| `chunks/admin-errors.js` | +576 | +73 |
| `entries/hooks.server.js` | +563 | +127 |
| `chunks/site-shell.js` | +284 | +59 |
| `entries/pages/_layout.server.ts.js` | +192 | +166 |

Within each tree, all 54 client JavaScript paths, raw sizes, gzip sizes, and
SHA-256 hashes are identical across rebuilds. Both CSS files and the worker are
also identical. Server output is **not** byte-identical: `chunks/instance.js` and
`chunks/internal.js` vary in both pairs. All other server paths are identical
within each pair (113/115 pristine, 114/116 combined). The measured 1-byte pristine
and 3-byte combined gzip ranges are retained rather than selecting the smaller
run. Both combined builds still fail main's ceiling and pass the single-step
allocation. No asset, file-count check, or test is hidden to obtain the result.

## Historical records and limits

Main's entire existing `$comment` remains byte-for-byte unchanged (SHA-256
`c3a2077bb7197a068f733986453f505c42ff6a53fdb1965cd5937af39eabde25`).
The [frozen feature budget history](https://github.com/TogetherWeOwn/two-web-next/blob/b5f461665bf6ec1c638d5e2ad812bfcbd5ed2249/ci/kit-perf-budget.json)
is also preserved at its pinned head (comment SHA-256
`383e406fe38b1fdf6e8442492fed7103adbefb11386a9a4cac0c846b53fee5b7`).
Its 22 branch-only historical segments are retained verbatim in the
[historical appendix](kit-error-correlation-budget-history.md), rather than
re-appending them to the shared single-line `$comment`.

The original feature acceptance file is unchanged on the frozen feature head:
`test/kit-error-request-correlation.test.ts`, SHA-256
`7f90959f02d315a31b348041185bde8885a5547681d7c61e0ae81571e5d6ecb9`.
No feature source or acceptance test ships in this budget-only PR. Feature
behavior, database cases, browser journeys, accessibility, live pages, startup,
and a full `npm run check` were not established by this build experiment.

ACT: add one measured server-gzip step and retain the two histories. WHY: pristine
main fits, but the composed feature reproducibly exceeds main's server-gzip
ceiling; both candidate controls pass with all other limits unchanged. UNDO:
revert this allocation and its notes if the measured feature composition is
abandoned, after remeasuring any intervening main growth. The feature owner owns
reintegration and must not treat these measurements as approval of a later head.
