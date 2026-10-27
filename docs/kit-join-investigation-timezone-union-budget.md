# Join investigation and chosen-timezone composition budget

Measured 2026-10-27 on main `227414575dd8fffe8ebe245086442ce5a20ca174`
(re-measured after the archive-search and Happening-now changes grew the Kit
bundles again); this supersedes the earlier measurements, whose proposal
numbers are stale. This separate allocation covers the
composition of
[join investigation](https://github.com/TogetherWeOwn/two-web-next/pull/1705)
with main after [chosen-timezone comparison](https://github.com/TogetherWeOwn/two-web-next/pull/1755).
It neither ships nor approves those behaviors. The
[earlier allocation](kit-perf-join-investigation-budget.md) describes older inputs;
its decision history remains unchanged.

Only three byte ceilings change (server gzip, client raw and client gzip), one unit per fragment:
[`ci/budgets/kit/server-js.json`](../ci/budgets/kit/server-js.json) and
[`ci/budgets/kit/client-js.json`](../ci/budgets/kit/client-js.json), with the
decision recorded in
[`ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md`](../ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md).
No history is appended to any shared line. Application code, acceptance tests,
checkers, inventories, workflows, dependencies, file caps and every other ceiling
remain unchanged.

## Pinned inputs and reproducibility

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`.
- Main: `227414575dd8fffe8ebe245086442ce5a20ca174`. Main later moved to `b69eea7d7f8e99096cb497dce71210caf9af0502` with no build-input change
  (CI, Lighthouse and docs files, plus the 336384 server gzip ceiling); sizes were not rebuilt
  for that head and the composition still exceeds the 336384 retained ceiling by 262 B.
- Measurement tree: behavior head merged into that main (unrecorded tree id; reproduce with `git merge` and accept the monolith deletion).

Merging the behavior head into main conflicts only on the deleted monolith
`ci/kit-perf-budget.json` (the behavior-side edit is `$comment`-only). The
measurement tree accepts the deletion, so it is behavior code under main's
fragment budgets. No behavior branch was merged, rebased, edited or pushed.

Both trees are fresh checkouts sharing one external `npm ci --include=dev
--no-audit --no-fund` installation for root and web; manifests and lockfiles are
byte-identical. Each tree was built twice with `npm run build --prefix web`, then
checked with `node ci/check-kit-perf.mjs --format json`; all four builds exit 0 and
inherited database variables were unset. Node 24.22.1, npm 11.19.1.

| Input | SHA-256 |
| --- | --- |
| Root lockfile | `59ac3d0ca3ab0c590badbd0fbc3d74ac98abdf6f334ab36323380dd2bf906b7c` |
| Web lockfile | `87155c5518e9fedab6bbd33865ee7f5b5633349509f91fc5f122103875731909` |
| Canonical checker | `8629be9696e754c814291f6d137e9e8c724f39efbeb80cd84f2337ba48f0e24b` |

Gzip totals sum `gzipSync(bytes).length` **per file** under the canonical checker
paths. All emitted JS remains counted, including repeated wrappers.

## Repeated results at retained limits

| Tree | Server JS files | Server raw B | Server gzip B, builds 1 / 2 | Client JS files | Client raw B | Client gzip B | Gate exit, both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1187398 / 1187400 | 335838 / 335837 | 54 | 255632 | 102846 | 0 |
| Composition | 116 | 1190596 / 1190598 | 336646 / 336644 | 55 | 257337 | 103642 | 1 |

Main fits every ceiling. The composition exceeds the retained server gzip
336384 B by **262 B**, client raw 257024 B by **313 B** and client gzip
103168 B by **474 B**. Client paths and sizes are identical within
each tree's repeated builds; server gzip wobbled 1-2 B across each pair and the
allocation uses the largest observed value (336646 B over all builds; a later
pair of rebuilds on a newer main read 336644 / 336645 B with identical raw totals).

Worker and CSS are identical in every build: worker **2551 raw / 1219 gzip B**;
client CSS **2 files, 2861 raw / 1019 gzip B**.

## Attribution and duplication audit

Relative to main the composition adds **1705 raw / 796 gzip client B** and one JS
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
Every other client JS file is byte-identical to main.

Server growth is **+3198 raw / +808 gzip B**: `chunks/admin.js` +3023 raw, the
join-attempt detail server load +67, and nodes 12/19/20 +36 each. Same-length
import-table churn elsewhere nets to +0 raw. There are still 116 server JS files,
no new runtime or server chunk inventory.

Identical-content groups already exist on main and in the composition (client
nodes 0/2/5 and 29/31; server `manifest.js` / `manifest-full.js`); no new
duplicate JS class appears and no duplicate is excluded from a total.

### Smaller equivalent output considered

A narrower helper import does not remove the required bytes: the emitted shared
chunk already omits unused return-URL validation and parsing exports, and all
three consumers reference one implementation. Removing required copy, UTF-8
bounds, malformed-context refusal or generated route wrappers is not an
equivalent optimization, nor is discounting identical wrappers in the checker.
Moving presentation calculations from Svelte modules into server loads is a
plausible future client-artifact optimization, but needs changed page-data
contracts and unchanged-acceptance proofs; none is part of this bounded allocation
and no saving from it is claimed.

## Minimum aligned allocation and refusal controls

Use the existing 512 B raw / 256 B gzip steps, not a percentage or reserve:

| Ceiling | Before | Proposed | Increase | Minimum observed remaining margin |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip B | 336384 | 336896 | 512 | 250 |
| Client JS raw B | 257024 | 257536 | 512 | 199 |
| Client JS gzip B | 103168 | 103680 | 512 | 38 |

Controls run the unchanged checker on the retained composition output, changing
**only disposable budget copies**:

- Original limits reject: server gzip +262 B, client raw +313 B and client gzip +474 B.
- Proposed limits accept the composition: exit 0.
- One step below proposed rejects on each axis independently: server gzip
  336640 B (short 4 B on the retained 336644 B build, 6 B on the 336646 B build),
  client raw 257024 B (short 313 B) and client gzip 103424 B (short 218 B).
- One byte below the observed totals rejects (client raw 257336 B, client gzip
  103641 B; server gzip is not byte-controlled because the two builds read 336646 and
  336644 B, within the 1-2 B jitter); the exact observed totals accept.

The unchanged checker passes its selftests, and the updated boundary pins pass:
`check-kit-perf.test.mjs` and `budget-fragments.test.mjs` 74/74 together,
including the new 336896 server arm and admission case. Main's tests already
admit the 257536/103680 client arms, so with the fragments at main's values
only 1 case fails (the aggregate fragment pin, red-before). No
author-owned test was weakened; only ceiling literals moved with their fragments.
This does not claim a full application check, browser, visual, accessibility,
Lighthouse, startup-latency, staging or production verification.

Every other ceiling stays fixed: worker 3584 raw / 1536 gzip B; server 1203200 raw B
and 126 files; client JS 55 files; client CSS 3072 raw / 1024 gzip B and four files;
startup 60000 ms. The composition has **zero spare client JS files**, **5 B CSS gzip
margin** a **250 B** server gzip margin, a **199 B** client raw margin and a **38 B** client gzip margin. None is reserved capacity.
Any later integrated head must be freshly rebuilt and pass exact-head CI, security,
QA and independent review.

## Undo

Revert only these three numeric changes and this note. This restores the
336384 B server gzip, 257024 B client raw and 103168 B client gzip limits, intentionally rejecting the
measured composition again. No application state, schema or deployed artifact changes.
