# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335872

`server.js.maxGzipBytes` rises 335360 -> 335872 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
event discovery actions feature (PR #1916): the required game-catalog read
and two links on the Kit event detail page grow the Kit server bundle past
the current ceiling. One 256B step, the smallest aligned cover for the
measured worst case.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185441 | 335349 | exit 0, margin 11 |
| 2 | 116 | 1185439 | 335348 | exit 0, margin 12 |

Combined tree (main `ba58281d2` merged with the feature head `ddd427fcc`):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1187386 | 335823 | exit 1, 463 over |
| 2 | 116 | 1187386 | 335823 | exit 1, 463 over |

CI on the feature head measured gzip 335824, 1B above the local worst and
inside rebuild jitter. Worst case overall is therefore 335824: the current
335360 ceiling rejects it by 464B, and 335872 (256 x 1312) admits it with
48B of margin. The next lower step, 335616, rejects it by 208B. Worker
(2551/1219B), client JS (54 files, 255264/102721B) and client CSS (2 files,
2861/1019B) fit their unchanged ceilings, and the combined server raw total
(1187386) and file count (116) fit theirs, so the growth is server gzip
only with no new files. Feature delta on the server total is about +1945
raw / +474 gzip bytes (combined minus pristine, first builds).

Rebuild jitter is disclosed, not signal: pristine raw/gzip wobble by
-2/-1B across rebuilds, combined builds were identical, and CI sits +1B
above the local worst. The checker itself is deterministic.

## Why not trim

Pristine main fits its ceiling with 11B of headroom, and the feature adds
only the required catalog read and two links; there is nothing to remove
without dropping behavior.

## Shipping tests

335872 already has explicit support on main in
`ci/check-kit-perf.test.mjs` (`SHIPPING_SERVER_GZIP_ALLOCATIONS` with the
fixed 335624 / 335872 / 335873 interval, exact and one-byte-over literals),
so that suite needs no change. The fragment-aggregation oracle in
`ci/budget-fragments.test.mjs` gains 335872 as an admitted allocation (its
own admission case, plus 335871 and 335873 as rejected neighbours);
without that pin the suite fails its aggregation case by design.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert only
this fragment step, the oracle pins and this record (the feature PR then
fails the server gzip gate again until it trims or a new ceiling lands).
