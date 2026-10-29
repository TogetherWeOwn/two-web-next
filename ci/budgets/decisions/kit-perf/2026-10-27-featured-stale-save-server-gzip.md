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

## 2026-10-28 featured-unpublish composition: 337408 -> 337664

After GitHub reported a merge conflict, current main `728b70054` was
integrated before changing this allowance. It brings #1869's independently
reviewed featured-list unpublish action and its 336896 ceiling. Both locked
Node 24.22.1 / npm 11.19.1 production builds were repeated on pristine main
and the combined tree, with byte-identical dependency lockfiles:

| Tree | Build | Server files | Raw bytes | Gzip bytes | Gate |
|---|---|---:|---:|---:|---|
| Pristine main `728b70054` | 1 | 116 | 1194064 | 336801 | exit 0 against 336896, margin 95 |
| Pristine main `728b70054` | 2 | 116 | 1194062 | 336801 | exit 0 against 336896, margin 95 |
| Combined feature and corrections | 1 | 116 | 1196484 | 337502 | exit 1 against 337408, 94 over |
| Combined feature and corrections | 2 | 116 | 1196486 | 337503 | exit 1 against 337408, 95 over |

337664 is the smallest next 256B step, leaving 161B against the measured
worst 337503. The complete PR raise versus current main is 768B (0.228%),
within the 0.5% size-proxy cap. The combined-tree delta is +2422 raw / +702
gzip bytes versus pristine main's worst totals; identical-tree variation
is 2 raw bytes and 1 gzip byte. No extra step is reserved for that variation.

The difference remains the saved-content baseline, committing-lock check and
conflict form plus the JSON fallback-zone correction, now composed with
main's unpublish route. The built `chunks/admin.js` accounts for +2370 raw /
+699 gzip bytes; the JSON serializers change `chunks/events.js` and
`chunks/src.js` by 26 raw bytes each. Hashed manifest/import-name differences
account for the remaining small total variation. Source imports and both
parent changes were checked; no new dependency, duplicate import, new chunk
or accidental unrelated code was added by the resolution.

Client JS is byte-identical across the two combined builds: 257189 raw /
103229 gzip, versus main's 257102 / 103192 and unchanged 258048 / 103424
ceilings. CSS, Worker, server raw/file, client file and startup limits stay
unchanged. Current-main a11y, Lighthouse and browser-smoke checks and the
previous feature head's corresponding checks were green before this step;
no runtime, staging or other class-A threshold changes. This is a size-only
allowance, not runtime, deployment or staging acceptance. A fresh exact-head
review and CI remain required.

Both shipping oracles retain every parent allocation and add 337664 with
exact-fit / one-byte-over boundary evidence. Main's separate unpublish
decision remains unchanged. Undo: revert this fragment step, its additive
allocation proofs and this subsection together with the feature.

## Conflict-flow review corrections: no further ceiling change

Two locked production rebuilds after the incarnation/snapshot/history/session
corrections measure **337653 / 337652 gzip bytes**, both within the unchanged
337664 ceiling (worst margin 11B). Server raw is 1196925 / 1196923; files stay
116. Relative to `936cd8f6a` above, the combined correction adds about 150 gzip
bytes: tuple-incarnation preconditions, carrying the locked snapshot instead
of rereading, and loading the small featured-only history controller plus the
existing auth-status controller on conflicts. No new server import/dependency
is added. Redundant error metadata and a redundant property descriptor value
were removed rather than raising this ceiling again.

Client JS measures 257272 raw / 103255 gzip, still within 258048 / 103424;
Worker and CSS are unchanged. The new served history island has its own
initial measured asset allocation; the generic editor stays byte-identical.
No existing numeric ceiling or class-A threshold changes in this correction.
Local a11y passes; local Lighthouse cannot complete because the sandbox lacks
`ps`, so it is unverified, not green. Exact-head CI must supply that proof.

## Why one PR

Repo routing for budget conflicts: a feature PR carries its measured
affected fragment, this decision and the matching shipping-test
allocation entries (`ci/check-kit-perf.test.mjs`,
`ci/budget-fragments.test.mjs`, both additive; earlier allocations stay
byte-identical) rather than waiting on separate allocation PRs.

Startup, runtime, staging and release acceptance are not claimed;
exact-head CI and independent review remain mandatory. Undo: revert the
fragment step, the allocation entries and this record.
