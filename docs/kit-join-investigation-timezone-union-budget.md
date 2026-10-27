# Join investigation and chosen-timezone composition budget

Measured 2026-10-27 on main `cb0f15736f603bf263be9d386dee179c3be8d4d7`
(re-measured after the budget-fragment rebase and after main's further
ceiling movement; this supersedes the 2026-10-25 and 2026-10-26 measurements,
whose proposal numbers are stale). This separate allocation covers the
composition of
[join investigation](https://github.com/TogetherWeOwn/two-web-next/pull/1705)
with main after [chosen-timezone comparison](https://github.com/TogetherWeOwn/two-web-next/pull/1755).
It neither ships nor approves those behaviors. The
[earlier allocation](kit-perf-join-investigation-budget.md) describes older inputs;
its decision history remains unchanged.

Only three byte ceilings change, one unit per fragment:
[`ci/budgets/kit/server-js.json`](../ci/budgets/kit/server-js.json) and
[`ci/budgets/kit/client-js.json`](../ci/budgets/kit/client-js.json), with the
decision recorded in
[`ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md`](../ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md).
No history is appended to any shared line. Application code, acceptance tests,
checkers, inventories, workflows, dependencies, file caps and every other ceiling
remain unchanged.

## Pinned inputs and reproducibility

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`.
- Main: `cb0f15736f603bf263be9d386dee179c3be8d4d7`.
- Measurement tree: `a11050a93dbf2beea3c103d0eaee788ec2ac0d15`.

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
| Main | 116 | 1185439 / 1185439 | 335349 / 335349 | 54 | 254926 | 102621 | 0 |
| Composition | 116 | 1188637 / 1188637 | 336153 / 336153 | 55 | 256631 | 103418 | 1 |

Main fits every ceiling. The composition exceeds the retained server gzip
335360 B by **793 B**, client raw 256000 B by **631 B**, and client gzip
103168 B by **250 B**. Client paths and sizes are identical within each tree's
repeated builds; server gzip is identical across the pair this round (earlier rounds wobbled by 1 B), and the allocation
uses the observed value.

Worker and CSS are identical in every build: worker **2551 raw / 1219 gzip B**;
client CSS **2 files, 2861 raw / 1019 gzip B**.

## Attribution and duplication audit

Relative to main the composition adds **1705 raw / 797 gzip client B** and one JS
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

Server growth is **+3198 raw / +804 gzip B**: `chunks/admin.js` +3023 raw, the
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
| Server JS gzip B | 335360 | 336384 | 1024 | 231 |
| Client JS raw B | 256000 | 257024 | 1024 | 393 |
| Client JS gzip B | 103168 | 103424 | 256 | 6 |

Controls run the unchanged checker on the retained composition output, changing
**only disposable budget copies**:

- Original limits reject: server gzip +793 B, client raw +631 B, client gzip +250 B.
- Proposed limits accept the composition: exit 0.
- One step below proposed rejects on each axis independently: server gzip
  336128 B (short 25 B on the 336153 B build), client raw 256512 B (short 119 B),
  client gzip 103168 B (short 250 B).
- One byte below the observed client totals rejects (raw 256630 B, gzip 103417 B);
  the exact observed totals accept.

The unchanged checker passes its selftests, and the updated boundary pins pass:
`check-kit-perf.test.mjs` and `budget-fragments.test.mjs` 66/66 together,
including the new 336384 server arm and admission case, the moved raw/gzip
exact/one-over pins and the fixed 256631 B client raw evidence case. With the
fragments at main's values the new pins fail 6 cases (red-before). No
author-owned test was weakened; only ceiling literals moved with their fragments.
This does not claim a full application check, browser, visual, accessibility,
Lighthouse, startup-latency, staging or production verification.

Every other ceiling stays fixed: worker 3584 raw / 1536 gzip B; server 1203200 raw B
and 126 files; client JS 55 files; client CSS 3072 raw / 1024 gzip B and four files;
startup 60000 ms. The composition has **zero spare client JS files**, **5 B CSS gzip
margin** and only **6 B client gzip margin**. None is reserved capacity.
Any later integrated head must be freshly rebuilt and pass exact-head CI, security,
QA and independent review.

## Undo

Revert only these three numeric changes and this note. This restores the
335360 B server gzip and 256000/103168 B client limits, intentionally rejecting the
measured composition again. No application state, schema or deployed artifact changes.
