# 2026-10-29 decision: server JS raw ceiling 1203200 -> 1203968

`server.js.maxRawBytes` rises 1203200 -> 1203968 in
`ci/budgets/kit/server-js.json`; no other ceiling changes. This admits the
agent-event ingress statement-deadline bounds in PR #1872 (transaction-local
`statement_timeout` beside the existing `lock_timeout`, bounded grant/replay
lookups and denial audits, 57014 mapped to the audited retryable
`operation_busy` response). The agent-events ingress modules ship in the
Kit server bundle, so the shared Hono code growth cannot be avoided
without forking the ingress. 1203968 = 256 x 4703, the smallest aligned
cover for the measured worst case on the final composed head.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`. Worst case governs.

Pristine main tip `e2590f419` (main CI `check` job, 2026-10-29):

| Source | Server files | Raw bytes | Gzip bytes | Gate at 1203200/337152 |
|---|---:|---:|---:|---|
| CI run 40790714216 | 116 | 1202520 | 336739 | exit 0, margins 680 / 413 |

Composed tree: PR head `4bae822a0` plus main `e2590f419` merged in
(`0367e8718`). CI measured raw 1203930 on that exact head; two local
locked builds of the same tree both measured raw 1203932 / gzip 337033
(2B of the known renaming churn; disclosed, not signal). Worst case
1203932 governs.

| Build | Server files | Raw bytes | Gzip bytes | Gate at 1203200 |
|---|---:|---:|---:|---|
| CI `0367e8718` | 116 | 1203930 | (not read) | exit 1, 730 over |
| local 1 | 116 | 1203932 | 337033 | exit 1, 732 over |
| local 2 | 116 | 1203932 | 337033 | exit 1, 732 over |

Feature delta on the server total is +1412 raw / +294 gzip bytes (worst
local minus pristine main CI). Gzip fits its unchanged 337152 ceiling
(margin 119); file count is unchanged at 116/126. Worker (2551/1219B),
client JS (53 files, 258144/103202B) and client CSS (2 files,
2861/1019B) are byte-identical to pristine main CI, so only the server
raw ceiling moves. The lower aligned step 1203712 rejects the worst case
by 220; 1203968 leaves a 36B margin.

## Shipping tests

Server raw becomes allocation-aware in `ci/budget-fragments.test.mjs`
(`SHIPPING_SERVER_RAW_ALLOCATIONS = [1203200, 1203968]`, admit and
unsupported-rejection cases, per-row drift expectations), following the
landed server-gzip pattern; the `SHIPPING_KIT_BUDGET` pin stays at the
historical 1203200 baseline. The fixed server-raw boundary literals in
`ci/check-kit-perf.test.mjs` (exact ceiling / one byte over) move to
1203968/1203969 through the independent test-owner correction path, as
prior ceiling moves did.

## Ordering

Measured against main `e2590f419` composed with the PR head only.
Re-measure after any rebase or further main merge; if a higher server
raw ceiling lands first, this raise is dropped instead of stacking.

No feature, checker, dependency, workflow, mask or exclusion changes ship
in this step. Exact-head CI and independent review remain mandatory.
Undo: revert only this fragment step, the oracle allocation entry, the
boundary literals and this record.
