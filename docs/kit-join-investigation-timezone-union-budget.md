# Join investigation and chosen-timezone composition budget

Measured 2026-10-27 on main `db2590d0cfc892956aa8f96f21e616fa47b6d6d2`.
This supersedes the earlier measurements. This separate allocation covers the
composition of [join investigation](https://github.com/TogetherWeOwn/two-web-next/pull/1705)
with main after [chosen-timezone comparison](https://github.com/TogetherWeOwn/two-web-next/pull/1755).
It neither ships nor approves those behaviors. The
[earlier allocation](kit-perf-join-investigation-budget.md) describes older inputs;
its decision history remains unchanged.

Only three byte ceilings change (server gzip, client raw and client gzip):
[`ci/budgets/kit/server-js.json`](../ci/budgets/kit/server-js.json) and
[`ci/budgets/kit/client-js.json`](../ci/budgets/kit/client-js.json), with the
decision recorded in
[`ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md`](../ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md).
The shipping-budget pins move with their fragments; main's independently
supported allocation arms remain alongside them. Main's CSS gzip ceiling is
now 1280 B; this allocation preserves it, including its test pins. Application
code, checkers, inventories, workflows, dependencies, file caps, frozen decision
history and every other ceiling remain unchanged relative to main.

## Pinned inputs and reproducibility

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`.
- Main: `db2590d0cfc892956aa8f96f21e616fa47b6d6d2`.
- Measurement tree: `422aca706db5f56008d3bd790ab121cbf7f14df8`.

Merging the behavior head into main conflicts only on the deleted monolith
`ci/kit-perf-budget.json` (the behavior-side edit is `$comment`-only). The
measurement tree accepts the deletion, so it is behavior code under main's
fragment budgets. No behavior branch was merged, rebased, edited or pushed.

Both trees are fresh archives sharing one external `npm ci --include=dev
--no-audit --no-fund` installation for root and web; manifests and lockfiles are
byte-identical. Each tree was built twice with `npm run build --prefix web`, then
checked with `node ci/check-kit-perf.mjs --format json`; all four builds exit 0 and
inherited database variables were unset. Node 24.22.1, npm 11.19.1.
Main's critical-CSS build generation is unchanged by this allocation.

| Input | SHA-256 |
| --- | --- |
| Root lockfile | `dd4e6c3d1883a3fd35a4c30b80c4d9d07ab8e7f0922b839c25ec4b63402b9e6e` |
| Web lockfile | `87155c5518e9fedab6bbd33865ee7f5b5633349509f91fc5f122103875731909` |
| Canonical checker | `8629be9696e754c814291f6d137e9e8c724f39efbeb80cd84f2337ba48f0e24b` |

Gzip totals sum `gzipSync(bytes).length` **per file** under the canonical checker
paths. All emitted JS remains counted, including repeated wrappers.

## Repeated results at retained limits

| Tree | Server JS files | Server raw B, builds 1 / 2 | Server gzip B, builds 1 / 2 | Client JS files | Client raw B | Client gzip B | Gate exit, both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1190767 / 1190765 | 336372 / 336370 | 54 | 256400 | 103000 | 0 |
| Composition | 116 | 1193963 / 1193965 | 337174 / 337173 | 55 | 258105 | 103795 | 1 |

Main fits every ceiling, but its server gzip margin is only 12 B in the larger
build. The larger composition exceeds the retained server gzip 336384 B by
**790 B**, client raw 257024 B by **1081 B** and client gzip 103168 B by **627 B**.
Client paths and sizes are identical within each tree's repeated builds. Server
raw/gzip vary by 1–2 B; use the larger observed total for allocation, not a claim
of byte-stable rebuilds.

Worker and CSS are identical in every build: worker **2551 raw / 1219 gzip B**;
client CSS **2 files, 2861 raw / 1019 gzip B**.

## Attribution and duplication audit

Relative to main the composition adds **1705 raw / 795 gzip client B** and one JS
file. Client raw delta by emitted file (hashed names change with content):

| Generated output | Raw delta B |
| --- | ---: |
| New shared helper chunk (`chunks/D5KmFpmb.js`, used by all three nodes) | +1320 |
| App entry / import table (replaced file) | +33 |
| Node 12: activity log | -295 |
| Node 19: join-attempt list | +514 |
| Node 20: join-attempt detail | +133 |
| **Sum** | **+1705** |

All three nodes reference the same helper chunk. Its contents are paging, bounded
context, diagnostic labels and evidence copy, not a second framework runtime.
Every other client JS file is byte-identical to main (50 of 54).

Server growth is **+3196 / +3200 raw B** and **+802 / +803 gzip B** in paired
builds. Stable raw additions are `chunks/admin.js` +3023, the join-attempt detail
server load +67 and nodes 12/19/20 +36 each: +3198 B total. Import-table churn
accounts for the remaining -2 / +2 raw B; the retained second build changes
`chunks/instance.js` by +2 raw B. There are still 116 server JS files, no new
runtime or server chunk inventory. Since the previous main's measurements,
main gained 525–527 server raw B and 29 client raw B from the UTC-label,
admin Past-filter and profile-cancel changes; the behavior's +1705 client raw
and approximately +3198 server raw delta remain separately attributable.

Identical-content groups already exist on main and in the composition (client
nodes 0/2/5 and 29/31; server `manifest.js` / `manifest-full.js`); no new
duplicate JS class appears and no duplicate is excluded from a total.

### Smaller equivalent output considered

Inspection of the emitted shared chunk shows that it already omits unused
return-URL validation and parsing exports, and all three consumers reference one
implementation. No narrower-import trial was built or measured; this is an
inspection-based reason not to claim a saving, not proof of globally minimal
implementation size. The minimum claim below concerns only the aligned ceilings
for the measured output. Removing required copy, UTF-8 bounds, malformed-context
refusal or generated route wrappers is not an equivalent optimization, nor is
discounting identical wrappers in the checker. Moving presentation calculations
from Svelte modules into server loads is a plausible future client-artifact
optimization, but requires changes to page-data contracts and unchanged-acceptance
proofs; none is part of this bounded allocation and no saving from it is claimed.

## Minimum aligned allocation and refusal controls

Use the existing 512 B raw / 256 B gzip steps, not a percentage or reserve:

| Ceiling | Before | Proposed | Increase | Minimum observed remaining margin |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip B | 336384 | 337408 | 1024 | 234 |
| Client JS raw B | 257024 | 258560 | 1536 | 455 |
| Client JS gzip B | 103168 | 103936 | 768 | 141 |

The earlier unmerged 337152 B server proposal is now insufficient by 22 B in the
larger build. One additional 256 B step is required, not spare capacity.

Ten controls run the unchanged checker on the retained second composition
output, changing **only disposable budget copies**:

- Original limits reject: server gzip +789 B, client raw +1081 B and client gzip +627 B.
- The prior proposal (337152 server gzip, proposed client limits) rejects by 21 B.
- Proposed limits accept the composition: exit 0.
- One step below proposed rejects on each axis independently: server gzip
  337152 B (short 21 B), client raw 258048 B (short 57 B) and client gzip
  103680 B (short 115 B).
- One byte below that retained output rejects on all three axes (server gzip
  337172 B, client raw 258104 B, client gzip 103794 B); its exact observed totals
  accept. These controls freeze one output; they do not imply rebuild determinism.

The unchanged checker passes its 12 selftests, and the shipping-budget suites
`check-kit-perf.test.mjs` and `budget-fragments.test.mjs` pass 76/76 together.
Server and client interval/exact/one-over literals follow the measured maxima
and their aligned allocations. Main's 1280 B CSS fixtures are retained unchanged. This does not
claim a full application check, browser, visual, accessibility, Lighthouse,
startup-latency, staging or production verification.

Every other ceiling stays fixed relative to main: worker 3584 raw / 1536 gzip B;
server 1203200 raw B and 126 files; client JS 55 files; client CSS 3072 raw /
1280 gzip B and four files; startup 60000 ms. The composition has **zero spare
client JS files**, **261 B CSS gzip margin**, a **234 B** server gzip margin, a
**455 B** client raw margin and a **141 B** client gzip margin. None is reserved
capacity. Any later integrated head must be freshly rebuilt and pass exact-head
CI, security, QA and independent review.

## Undo

Revert the full allocation change: the three numeric limits, this note, its linked
decision record and the allocation-specific shipping pins in
`ci/budget-fragments.test.mjs` and `ci/check-kit-perf.test.mjs`. Preserve unrelated
main allocation arms, including CSS gzip 1280 B. This restores the 336384 B server
gzip, 257024 B client raw and 103168 B client gzip limits, intentionally rejecting
the measured composition again. No application state, schema or deployed artifact changes.
