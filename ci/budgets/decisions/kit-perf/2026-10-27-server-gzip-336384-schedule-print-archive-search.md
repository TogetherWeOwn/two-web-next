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

## Re-measure after main moved to `5919f44c4`

Main admitted the Happening-now 336128 step (budget files only, no product
or lockfile change), so the composition's bytes are unchanged by
construction. One confirmatory production build on the merged tree: 116
server files, 1188562 raw / 336129 gzip, exit 0 against 336384. Worst case
across all three builds stays 336134.

## Re-measure after main moved to `227414575` plus the zero-page copy fix

Main added the discovery HTML byte cap (shared-contracts product code) and
the stamp gained the gap/unpaged copy strings, so the composition was
re-measured twice on the merged tree: 116 server files, 1188724 raw /
336195 gzip and 1188724 raw / 336192 gzip, both exit 0 against 336384.
Worst case 336195 governs (margin 189; the earlier 336134 reading is
superseded). Client JS and worker still fit their unchanged ceilings.

## Shipping tests

`ci/budget-fragments.test.mjs` unions to six allocations
`[335104, 335360, 335616, 335872, 336128, 336384]` with a 336384 admit
test; the unsupported-allocation control probes
`[335105, 335359, 335617, 336127, 336383]`.
`ci/check-kit-perf.test.mjs` gains the 336384 literal with the landed
admin-orientation 336192 as its interval witness, plus the cap-selected
exact/over cases; this composition's 336195 worst lies in the same
(336128, 336384] interval, so it proves the same step without forking the
key. The oracle comment records both witnesses.

No feature, checker, dependency, workflow, mask or exclusion changes ship in
this decision. Exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the test additions and this record.
