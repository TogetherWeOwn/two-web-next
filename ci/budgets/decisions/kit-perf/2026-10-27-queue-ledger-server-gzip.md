# 2026-10-27 decision: server JS gzip ceiling 335360 -> 335616

`server.js.maxGzipBytes` rises 335360 -> 335616 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
queue-ledger server-side statement bounds (PR #1866), whose timeout
wrappers grow the Kit server bundle past the current ceiling. One 256B
step, the smallest aligned cover for the measured worst case.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

Pristine main tip `ba58281d2`:

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1185439 | 335351 | exit 0, margin 9 |
| 2 | 116 | 1185441 | 335350 | exit 0, margin 10 |

Combined tree `3224cc8a` (main tip plus the feature: three `src/jobs`
files and six test files; no `web/`, manifest or lockfile byte differs
from the tip):

| Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---:|---:|---:|---|
| 1 | 116 | 1186952 | 335549 | exit 1, 189 over |
| 2 | 116 | 1186954 | 335552 | exit 1, 192 over |

Worst case overall is therefore 335552: the current 335360 ceiling
rejects it by 192B, and 335616 (256 x 1311) admits it with 64B of
margin. Worker (2551/1219B), client JS (54 files, 254926/102621B) and
client CSS (2 files, 2861/1019B) are byte-identical across all four
builds and fit their unchanged ceilings, so the growth is server-only
with no new files. Feature delta on the server total is +1513 raw /
+201 gzip bytes (local worst minus pristine worst).

Rebuild jitter is disclosed, not signal: pristine raw/gzip wobble by
+2/-1B across rebuilds, combined raw/gzip by +2/+3B. The 64B margin
covers ~21x the observed +-3B jitter. The checker itself is
deterministic: repeated runs over one build print identical bytes. No
CI measurement exists yet on the combined head; if CI lands above the
local worst the margin absorbs it, otherwise this record is
re-measured before merge.

## Attribution

The combined tree differs from the pristine tip only in the feature
diff, and tests never enter the bundle, so the growth belongs to the
three `src/jobs` files: the `withLedgerTimeout` wrapper around the
queue-ledger and unique-lock statements, the `needsSync` eligibility
bound, and the shared timeout constants. The timeout code ships into
`chunks/admin.js`: `withLedgerTimeout` occurs 0 times in the pristine
build's chunk and 5 times in the combined build's chunk.

## Shipping tests

335616 already has explicit support in `ci/check-kit-perf.test.mjs`
(`SHIPPING_SERVER_GZIP_ALLOCATIONS` plus the fixed 335504 / 335616 /
335617 interval, exact and one-byte-over literals), so that suite
passes unchanged with the new fragment. The
fragment-aggregation expectation in `ci/budget-fragments.test.mjs`
moves with the ceiling (one pinned value plus its comment) and admits
335616 as the third allocation, the same way the split carried the
256000 client-raw raise; without that pin the suite fails its
exact-ceilings case by design.

No checker, dependency, workflow, mask or exclusion changes ship here.
The budget portion of this change is exactly this record, the fragment
step and the aggregation pin. Startup, runtime, staging and release
acceptance are not claimed; exact-head CI and independent review
remain mandatory. Undo: revert only this fragment step, the
expectation pin and this record.
