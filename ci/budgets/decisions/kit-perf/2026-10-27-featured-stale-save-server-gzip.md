# 2026-10-27 decision: server JS gzip ceiling 336640 -> 337152

`server.js.maxGzipBytes` rises 336640 -> 337152 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This re-admits the
featured stale-save refusal on the events/jobs main: main's event-detail Kit
code plus the saved-content baseline, the in-lock comparison and the conflict
page exceed the 336640 ceiling the slice previously carried. Two 256B steps,
the smallest aligned cover for the measured worst case (one step, 336896,
rejects by 53B).

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`.

| Tree | Build | Server files | Gzip bytes | Gate |
|---|---|---:|---:|---|
| Pristine main tip `4e90a8bcf` | 1 | 116 | 336248 | exit 0, margin 136 |
| Feature head (main tip merged in) | 1 | 116 | 336949 | exit 1 against 336640, 309 over |
| Feature head (main tip merged in) | 2 | 116 | 336949 | exit 1 against 336640, 309 over |

Worst case 336949, byte-identical across both local builds and equal to the
merge-queue run's measurement on the same tree. 337152 (256 x 1317) admits it
with 203B of margin. Feature delta on the server total is about +701 gzip
bytes over pristine main, no new server files. Client js fits unchanged
(54/55 files, raw 256458/257024B, gzip 103031/103168B). Rebuild jitter is
disclosed, not signal; none observed this round.

Prior step on the earlier base (`e37975a07`, pristine 335835): 336128 ->
336640 for worst case 336544, margin 96. That base is superseded; this record
covers the current tree.

## 2026-10-28 integration: 337152 -> 337408

Main `def3274b3` brings the independently reviewed unrenderable-time guards
from #1859. This PR also resolves the JSON fallback-zone review finding in
both serializers. Locked Node 24.22.1 production builds were repeated:

| Tree | Build | Server files | Gzip bytes | Gate |
|---|---|---:|---:|---|
| Pristine main `def3274b3` | 1 | 116 | 336633 | exit 0 against 336640, margin 7 |
| Combined feature and corrections | 1 | 116 | 337329 | exit 1 against 337152, 177 over |
| Combined feature and corrections | 2 | 116 | 337328 | exit 1 against 337152, 176 over |

One additional 256B step, 337408, is the smallest aligned cover for worst
case 337329, with 79B margin. The 1B rebuild variation is disclosed. Against
current pristine main, the combined server delta is +696 gzip bytes; this
is the feature plus the JSON correction, not an isolated per-change cost.
Both combined client builds are identical: 54 files, 256906 raw and 103139
gzip versus 258048/103424 ceilings. Pristine main is 256819/103102. No
client, raw, file-count, CSS, worker or startup ceiling moves. Both shipping
oracles gain the fixed 337408 allocation and exact/one-byte-over controls;
prior allocations and both parent decision histories remain.

## Why one PR

Repo routing for budget conflicts: a feature PR carries its measured
affected fragment, this decision and the matching shipping-test
allocation entries (`ci/check-kit-perf.test.mjs`,
`ci/budget-fragments.test.mjs`, both additive; earlier allocations stay
byte-identical) rather than waiting on separate allocation PRs.

Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the allocation entries and this record.
