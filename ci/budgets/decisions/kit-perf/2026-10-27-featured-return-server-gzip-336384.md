# 2026-10-27 decision: server JS gzip ceiling 335872 -> 336384

`server.js.maxGzipBytes` rises 335872 -> 336384 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
featured inventory return (PR #1805), whose shared codec and two featured
loaders grow the Kit server bundle past the current ceiling. Two 256B steps
above the current ceiling, the smallest aligned cover for the measured worst
case: 336128 rejects it by 124B. This supersedes the unmerged 336128 proposal
for the same feature: main has since landed the event-time server growth
(#1803, 335360 -> 335872) and dependency updates, adding about 300B under
the feature, so the earlier combined number no longer governs.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `d9b213141`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186500 | 335655 | exit 0, margin 217 |
| 2 | 116 | 1186502 | 335651 | exit 0, margin 221 |

Combined tree: main `d9b213141` merged with PR #1805 head `20c492bdc`
(scratch merge `71a71b63`):

| Build | Server files | Raw bytes | Gzip bytes | Gate at 335872 |
|---|---:|---:|---:|---|
| 2 | 116 | 1188559 | 336252 | exit 1, 380 over |
| 3 | 116 | 1188561 | 336250 | exit 1, 378 over |

(A first combined run measured gzip 336251; its raw total was not captured
before the next build overwrote the output, so the table carries the two
fully captured runs.)

Worst case overall is 336252B: 335872 rejects it by 380B, 336128 rejects it
by 124B, and 336384 (256 x 1314) admits it with 132B of margin. Re-running
the checker on the combined build at 336384 exits 0 with every Kit asset
fitting, and at 336128 it exits 1. Worker (2551/1219B) and client CSS
(2 files, 2861/1019B) are byte-identical across all builds; client JS
(54 files, 255534/102838B) fits its unchanged ceilings, so no other ceiling
moves. Feature delta on the server total is +2059 raw / +597 gzip bytes
(paired worst minus pristine worst).

Rebuild jitter is disclosed, not signal: pristine gzip differs by 4B between
builds, combined gzip by 2B across three runs.

## Contention with sibling budget PRs

Other open budget PRs target the same fragment. This decision measures
main plus the featured return alone. A sibling that lands first changes the
base and invalidates this combined number, so whichever PR merges second must
re-measure the true union on the current main and take the smallest 256B step
covering the worst case; this allocation does not reserve room for any other
feature.

## Shipping tests

`ci/budget-fragments.test.mjs` moves with the ceiling: one allocation-list
entry, one admit test and one rejected neighbour (336385). Support for 336384
in the Reviewer-owned `ci/check-kit-perf.test.mjs` shipping allocations rides
in its own correction, not this PR; this PR does not edit that file and its
`ci/check-kit-perf.test.mjs` case stays red until that correction lands.

No feature, checker, dependency, workflow, mask or exclusion changes ship
here. Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert only this
fragment step, the test pin and this record.
