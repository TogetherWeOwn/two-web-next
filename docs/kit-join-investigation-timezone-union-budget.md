# Join investigation and chosen-timezone composition budget

Measured 2026-10-27 on main `b5bef6810e7803ddff8cbd5105e6253cf56e4320`
(re-measured after main's event-time change grew both bundles again) and
reproduced byte-for-byte on main `7d5db1c21f12d8d51b74be43374cb7451cd31c76`
(later commits change only budgets, tests and a Hono island); this supersedes the 2026-10-25 and 2026-10-26 measurements,
whose proposal numbers are stale). This separate allocation covers the
composition of
[join investigation](https://github.com/TogetherWeOwn/two-web-next/pull/1705)
with main after [chosen-timezone comparison](https://github.com/TogetherWeOwn/two-web-next/pull/1755).
It neither ships nor approves those behaviors. The
[earlier allocation](kit-perf-join-investigation-budget.md) describes older inputs;
its decision history remains unchanged.

Only two byte ceilings change (server gzip and client gzip), one unit per fragment:
[`ci/budgets/kit/server-js.json`](../ci/budgets/kit/server-js.json) and
[`ci/budgets/kit/client-js.json`](../ci/budgets/kit/client-js.json), with the
decision recorded in
[`ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md`](../ci/budgets/decisions/kit-perf/2026-10-26-join-investigation-timezone-composition.md).
No history is appended to any shared line. Application code, acceptance tests,
checkers, inventories, workflows, dependencies, file caps and every other ceiling
remain unchanged.

## Pinned inputs and reproducibility

- Behavior head (frozen, unchanged): `2ae12d2c2738d337112e4c8ca87762046dca0e20`.
- Main: `7d5db1c21f12d8d51b74be43374cb7451cd31c76` (first measured on `b5bef6810`, same sizes).
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
| Main | 116 | 1186502 / 1186500 | 335655 / 335653 | 54 | 255118 | 102664 | 0 |
| Composition | 116 | 1189698 / 1189698 | 336465 / 336463 | 55 | 256823 | 103459 | 1 |

Main fits every ceiling. The composition exceeds the retained server gzip
335872 B by **593 B** and client gzip 103168 B by **291 B**; client raw
(256823 of main's 257024 B) fits. Client paths and sizes are identical within
each tree's repeated builds; server gzip wobbled 1-2 B across each pair and the
allocation uses the larger observed value.

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
Every other client JS file is byte-identical to main.

Server growth is **+3198 raw / +812 gzip B**: `chunks/admin.js` +3023 raw, the
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

Use the existing 256 B gzip steps, not a percentage or reserve:

| Ceiling | Before | Proposed | Increase | Minimum observed remaining margin |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip B | 335872 | 336640 | 768 | 175 |
| Client JS gzip B | 103168 | 103680 | 512 | 221 |

Controls run the unchanged checker on the retained composition output, changing
**only disposable budget copies**:

- Original limits reject: server gzip +593 B and client gzip +291 B (client raw fits).
- Proposed limits accept the composition: exit 0.
- One step below proposed rejects on each axis independently: server gzip
  336384 B (short 81 B on the 336465 B build) and client gzip 103424 B (short 35 B).
- One byte below the observed totals rejects (server gzip 336464 B against the
  336465 B build, client gzip 103458 B; the latest rebuild read 336463 B, within the
  1-2 B jitter); the exact observed totals accept.

The unchanged checker passes its selftests, and the updated boundary pins pass:
`check-kit-perf.test.mjs` and `budget-fragments.test.mjs` 67/67 together,
including the new 336640 server arm and admission case, the moved client gzip
exact/one-over pins. With the
fragments at main's values the new pins fail 3 cases (red-before). No
author-owned test was weakened; only ceiling literals moved with their fragments.
This does not claim a full application check, browser, visual, accessibility,
Lighthouse, startup-latency, staging or production verification.

Every other ceiling stays fixed: worker 3584 raw / 1536 gzip B; server 1203200 raw B
and 126 files; client JS 55 files; client CSS 3072 raw / 1024 gzip B and four files;
startup 60000 ms. The composition has **zero spare client JS files**, **5 B CSS gzip
margin** a **175 B** server gzip margin and a **221 B** client gzip margin. None is reserved capacity.
Any later integrated head must be freshly rebuilt and pass exact-head CI, security,
QA and independent review.

## Undo

Revert only these two numeric changes and this note. This restores the
335872 B server gzip and 103168 B client gzip limits, intentionally rejecting the
measured composition again. No application state, schema or deployed artifact changes.
