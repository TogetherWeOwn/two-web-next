# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336128

`server.js.maxGzipBytes` rises 335872 -> 336128 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
"Happening now" label on schedule cards (PR #1907). The Kit schedule list
reuses the Hono card and grid code, so the shared ongoing-night logic ships
in the Kit server bundle and cannot be avoided without forking the card. One
256B step (256 x 1313), the smallest aligned cover for the measured worst
case. The supported-allocation literal for 336128 already exists in
`ci/check-kit-perf.test.mjs`, so no test change accompanies this raise
beyond the fragment oracle's admitted-allocation list.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. Worst case governs.

Pristine main tip `7d5db1c21`:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335872 |
|---|---:|---:|---:|---|
| 1 | 116 | 1186502 | 335647 | exit 0, margin 225 |
| 2 | 116 | 1186502 | 335654 | exit 0, margin 218 |

Main tip plus the #1907 head `2ddee1017` (clean merge `3519381aaadd`,
no conflicts). Four builds measured 335899, 335900, 335901 and 335898
gzip bytes; worst case 335901 governs. Build 1's output was overwritten
before its files/raw were read; the table shows the three fully-read
builds:

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335872 |
|---|---:|---:|---:|---|
| 2 | 116 | 1187810 | 335900 | exit 1, 28 over |
| 3 | 116 | 1187810 | 335901 | exit 1, 29 over |
| 4 | 116 | 1187810 | 335898 | exit 1, 26 over |

Rebuild jitter of up to 3B is disclosed, not signal (builds 1-4 of one
tree read 335899/335900/335901/335898); the checker is deterministic over
one build. A ceiling of 335897 rejects build 4 (`gzip 335898B over
335897B`, exit 1), pinning the figure exactly. With only this fragment at
336128, builds 2 and 3 exit 0 (335900/336128 and 335901/336128).

Feature delta on the server total is +1308 raw / +247 gzip bytes (worst
minus worst). Raw and file count fit their unchanged ceilings (1203200
and 126); no file is added. Worker (2551/1219B) and client CSS (2 files,
2861/1019B) are byte-identical to pristine. Client JS grows from 54
files at 255118/102664B to 54 files at 255332/102723B and still fits its
unchanged 257024/103168B ceilings, so only the server ceiling moves.

## Shipping tests

336128 already has explicit support in `ci/check-kit-perf.test.mjs`
(interval 335977, exact 336128, one-byte-over 336129), so that suite
passes unchanged with the new fragment. The fragment-aggregation oracle
in `ci/budget-fragments.test.mjs` admits the new allocation (list entry,
comment, error message, one admit test), following the landed 335872
pattern: the `SHIPPING_KIT_BUDGET` pin stays untouched and the
unsupported-value probes are unchanged, with the never-shipped 335616
remaining a sampled rejection.

## Ordering

This is measured against main `7d5db1c21` only. Open budget-only raises
at or above this step land on their own evidence; if a higher server
ceiling lands first, this proposal closes as superseded instead of
merging. Re-measure after any rebase.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert only
this fragment step, the oracle entry and this record.
