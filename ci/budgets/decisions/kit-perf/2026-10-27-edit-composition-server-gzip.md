# 2026-10-27 decision: edit-form composition Kit server gzip

Allocate only the measured server cost of carrying event access and joining
fields through the Kit edit form in [#1739](https://github.com/TogetherWeOwn/two-web-next/pull/1739).
The separate client allocation remains in [#1769](https://github.com/TogetherWeOwn/two-web-next/pull/1769).
This decision does not approve or ship either feature.

## Reproduction and attribution

- Main commit: `d781cb070` (the first measurement used `b0f3c94ec`; main
  moved and the allocation was re-measured on the new base).
- Frozen feature commit: `40940d50b26ba4f8c66bd832c64f52794bd9c2fa`.
- Composition tree `aaf4cbe3`: main plus the frozen feature, conflict-free.
- Node 24.22.1; fresh external installations of each tree's exact committed
  root and web lockfiles with `npm ci --include=dev --no-audit --no-fund`.
  Two production builds per tree with `npm run build --prefix web`, then the
  unchanged native `measure(root)` from `ci/check-kit-perf.mjs`.
  Gzip is the sum of default Node `gzipSync` sizes per file, not concatenated
  output or a compressor with different options.

| Tree | Builds | Server files | Server raw B | Server gzip B | Client raw/gzip B |
| --- | --- | --- | --- | --- | --- |
| Pristine main | 2 | 116 | 1185175-1185177 | 335336-335337 | not recorded |
| Composition | 2 | 116 | 1188716-1188718 | 336001-336002 | 258142 / 103355 |

Pristine main fits the 335360 ceiling by 23 B. The composition adds about
+3541 raw / +665 gzip B on the server with unchanged paths and file counts.
Identical-tree rebuilds vary by a few bytes, so matching totals do not imply
identical emitted manifests. The two-build worst case, 336002 B, sizes this
allocation.

## server.js: gzip 335360 -> 336128

- Current 335360 rejects the measured worst case by 642 B.
- The 335872 step (two aligned steps up) still rejects it by 130 B.
- The previously proposed 335616 rejects it by 386 B and is withdrawn.
- New 336128 is the smallest 256 B-aligned cover: +768 B, three steps,
  leaving 126 B margin. This explicitly uses measured steps instead of the
  initial-baseline x1.25 sizing rule; no speculative headroom is allocated.
- Client JS is 258142 raw / 103355 gzip B, above unchanged 256000 / 103168
  ceilings by 2142 / 187 B. This server-only allocation cannot make the
  composed feature green. Both prerequisites must resolve separately.

## Unchanged bounds and scope

Server raw remains 1203200 B, server files 126. All other measured
dimensions (worker, client CSS, client JS file count) fit their unchanged
ceilings in every build. Startup remains 60000 ms; this build measurement
does not claim runtime startup timing. All other fragments, application
code, checker, workflows, dependencies, exclusions and immutable histories
stay unchanged.

The paired acceptance correction (336128 shipping literals and fragment
aggregate oracle) was delivered independently and is incorporated unchanged.
The feature and this allocation still require their own exact-head CI,
independent review and squash auto-merge gates.

ACT: admit only the measured edit-composition server gzip cost.
WHY: the refreshed composition breaches the current and next aligned ceilings.
UNDO: revert this allowance and its paired acceptance correction through
review before the feature ships; preserve unrelated allocations and history.
