# 2026-10-27 decision: server JS gzip ceiling 336128 -> 336384

`server.js.maxGzipBytes` rises 336128 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. One 256B step
(256 x 1314), the smallest aligned cover for the schedule print scope line
composed with the archive GET search form and pager position that landed on
main after the 336128 union was measured.

## Measurements

Locked Node v24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Main tip `f1dfd3eb` (archive search form) with the print scope line merged,
both builds exit 1 against the previous 336128 ceiling:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 336128 |
|---|---:|---:|---:|---|
| 1 | 116 | 1188564 | 336134 | exit 1, 6 over |
| 2 | 116 | 1188562 | 336130 | exit 1, 2 over |

Worst case 336134: 336384 admits it with 250B of margin, and 336128
rejects it by 6B, so 336384 is the least 256B-aligned cover. The two
builds differ by 4B, inside normal rebuild jitter; the worst governs
regardless.

Worker (2551/1219B) and client CSS (2861/1019B) are unchanged. Client JS
measures 256002 raw / 103012 gzip (54 files) and fits its unchanged
257024/103168 ceilings.

## Why the growth is justified

Both composed additions are independently justified: the archive search
form and pager position landed on main with their own feature acceptance,
and the scope line carries the 335616 decision in this PR. This decision
adds no new growth beyond their union. The only cheaper alternative is to
drop one of the two behaviors; shortening the pinned scope copy to claw
back 6B is explicitly rejected (the acceptance suite pins the exact
strings, and byte-golfing user-facing copy to fit a ceiling is not a
reduction).

## Shipping tests

`ci/budget-fragments.test.mjs` unions to six allocations
`[335104, 335360, 335616, 335872, 336128, 336384]` with a 336384 admit
test; the unsupported-allocation control probes
`[335105, 335359, 335617, 336127, 336383]`.
`ci/check-kit-perf.test.mjs` gains the 336384 literal with this
composition's 336134 as its interval witness, plus the cap-selected
exact/over cases. Sibling branches propose the same 336384 key with their
own witnesses; any interval in (336128, 336384] proves the step, so the
first landing keeps the key without forking.

No feature, checker, dependency, workflow, mask or exclusion changes ship in
this decision. Exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test additions and this record.
