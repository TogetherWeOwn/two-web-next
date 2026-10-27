# 2026-10-27 decision: edit-form composition Kit server gzip

Allocate only the measured server cost of carrying event access and joining
fields through the Kit edit form in [#1739](https://github.com/TogetherWeOwn/two-web-next/pull/1739).
The separate client allocation remains in [#1769](https://github.com/TogetherWeOwn/two-web-next/pull/1769).
This decision does not approve or ship either feature.

## Reproduction and attribution

- Main commit: `b0f3c94ec807f3534fd4ff75d5bf487cb182e7a0`.
- Frozen feature commit: `40940d50b26ba4f8c66bd832c64f52794bd9c2fa`.
- `git merge-tree --write-tree` produces the conflict-free composition tree
  `f7eb901d3e5bfde27324b5168310ecdf9b17b409`.
- Node 24.22.1; fresh external installations of each tree's exact committed
  root and web lockfiles with `npm ci --include=dev --no-audit --no-fund`.
  Two production builds per tree with `npm run build --prefix web`, then the
  unchanged native `measure(root)` from `ci/check-kit-perf.mjs`.
  Gzip is the sum of default Node `gzipSync` sizes per file, not concatenated
  output or a compressor with different options.

| Tree/build | Server files | Server raw B | Server gzip B | Client raw/gzip B | Native result under main ceilings |
| --- | --- | --- | --- | --- | --- |
| Pristine 1 | 116 | 1182156 | 334739 | 254691 / 102574 | exit 0 |
| Pristine 2 | 116 | 1182156 | 334738 | 254691 / 102574 | exit 0 |
| Composition 1 | 116 | 1185695 | 335393 | 257907 / 103308 | exit 1: server and client |
| Composition 2 | 116 | 1185697 | 335395 | 257907 / 103308 | exit 1: server and client |

The composition's `server/chunks/admin.js` grows by 3541 raw / 654 gzip B
against the second pristine build. Remaining server gzip movement nets +3 B
in that comparison; server paths and file counts are unchanged. Identical-tree
rebuilds vary by a few bytes, so neither matching totals nor matching source
implies identical emitted manifests. The recorded four-build worst case,
335395 B, sizes this allocation.

## server.js: gzip 335104 -> 335616

- Old 335104 rejects the measured worst case by 291 B.
- One 256 B step, 335360, still rejects it by 35 B.
- New 335616 is the smallest 256 B-aligned cover: +512 B, two steps,
  leaving 221 B margin. This explicitly uses measured steps instead of the
  initial-baseline x1.25 sizing rule; no speculative headroom is allocated.
- Native real-output controls change only the scratch server gzip ceiling:
  335104, 335360 and measured-minus-one 335394 reject server gzip;
  measured-exact 335395 and proposed 335616 admit it. All five retain the
  independent client breach and overall exit 1.
- Client JS is 257907 raw / 103308 gzip B, above unchanged 256000 / 103168
  ceilings by 1907 / 140 B. This server-only allocation cannot make the
  composed feature green. Both prerequisites must resolve separately.

## Unchanged bounds and scope

Server raw remains 1203200 B, server files 126. Every build has worker
2551 raw / 1219 gzip B within 3584 / 1536; client CSS 2 files, 2861 raw /
1019 gzip B within 4 files, 3072 / 1024. Client JS file count remains 54
within 55. Startup remains 60000 ms; this build measurement does not claim
runtime startup timing. All other fragments, application code, checker,
workflows, dependencies, exclusions and immutable histories stay unchanged.

Independent test-owner delivery must coevolve the shipping server-gzip
literals and fragment aggregate oracle before this PR becomes reviewable.
Existing historical evidence and off-axis failure controls must remain.
The feature and this allocation still require their own exact-head CI,
independent review and squash auto-merge gates.

ACT: admit only the measured edit-composition server gzip cost.
WHY: the refreshed composition breaches two successive aligned ceilings.
UNDO: revert this allowance and its paired acceptance correction through
review before the feature ships; preserve unrelated allocations and history.
