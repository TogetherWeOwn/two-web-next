# Join investigation and chosen-timezone composition budget

Measured 2026-10-26 (re-measured after the budget-fragment rebase; this
supersedes the 2026-10-25 measurement on main `853f954b`, whose proposal
numbers are stale). This separate allocation covers the composition of
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
- Freshly fetched main: `7f1dc8c5521e2d9e1d4abfe54c0aeb8e1cfb9862`.
- Measurement tree: `2745d26d3acb1327e30df79ca255e014f9074405`.

A fresh `git merge-tree --write-tree <behavior-head> <main>` reports exactly
one conflict: the deleted-monolith modify/delete on `ci/kit-perf-budget.json`
(the behavior-side edit is `$comment`-only; ceilings identical to its
merge-base). A disposable Git index drops that behavior-side monolith copy so
the tree is behavior code under main's fragment budgets. No behavior branch was
merged, rebased, edited or pushed. This is a measured composition, not a claim
that the current Git merge is conflict-free.

Use fresh `git archive` trees with the same external dependency installations:
`npm ci --include=dev --no-audit --no-fund` for root and web manifests/lockfiles.
Both pairs of manifests and lockfiles are byte-identical across all three trees.
Build twice per tree with `npm run build --prefix web`, then run `npm run kit-perf`
and `node ci/check-kit-perf.mjs --format json`. All four builds exit 0. Inherited
database URL variables were removed; no database, remote probe or deploy was used.

Runtime: Node 24.22.1, npm 11.19.1, zlib `1.3.2.1-motley-285e94b`;
Svelte 5.57.2, Kit 3.1.0, Vite 8.3.4, Cloudflare adapter 8.0.1.
Identical SHA-256 inputs across every tree:

| Input | SHA-256 |
| --- | --- |
| Root lockfile | `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d` |
| Web lockfile | `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e` |
| Canonical checker | `8629be9696e754c814291f6d137e9e8c724f39efbeb80cd84f2337ba48f0e24b` |
| Canonical inventory | `be56bc95eb20a156176b4452925260d30c417c758bbed2f193fc55f58423b75a` |

Gzip totals sum `gzipSync(bytes).length` **per file** under the canonical checker
paths, not concatenated data. All emitted JS remains counted, including repeated
wrappers. Server sourcemaps are excluded by the unchanged checker.

## Repeated results at retained limits

| Tree | Server JS files | Server raw B | Server gzip B, builds 1 / 2 | Client JS files | Client raw B | Client gzip B | Gate exit, both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Main | 116 | 1182431 / 1182429 | 334842 / 334842 | 54 | 254929 | 102692 | 0 |
| Composition | 116 | 1185629 / 1185627 | 335677 / 335678 | 55 | 256634 | 103493 | 1 |

Main fits every ceiling. Composition exceeds the retained server gzip
335104 B by **573–574 B**, client raw 256000 B by **634 B**, and client gzip
102912 B by **581 B**. Within each tree's repeated builds every client path, raw/gzip
size and SHA-256 is identical. Server gzip varies by 1 B within each pair; the
allocation uses the larger observed value, not a claim of server byte identity.

Worker and CSS are identical in every build: worker **2551 raw / 1219 gzip B**;
client CSS **2 files, 2861 raw / 1019 gzip B**.

## Attribution and duplication audit

Relative to current main, the composition adds **1705 raw / 801 gzip client B**
and one JS file. The complete client delta is:

| Generated output | Raw delta B | Gzip delta B |
| --- | ---: | ---: |
| Shared `table-list` helper, `chunks/D5KmFpmb.js` | +1320 | +643 |
| App entry / import table | +33 | +16 |
| Node 12: activity log | -295 | -146 |
| Node 19: join-attempt list | +514 | +225 |
| Node 20: join-attempt detail | +133 | +63 |
| **Sum** | **+1705** | **+801** |

The Vite manifest maps all three nodes to the **same** helper chunk. Its contents
are paging, bounded context, diagnostic labels and evidence copy, not a second
framework runtime. Every other client JS file is byte-identical to main.
`npm ls --include=dev svelte @sveltejs/kit vite @sveltejs/adapter-cloudflare --json`
resolves one installed version of each runtime/build package, shared by every tree.

Server growth is **3198 raw / 836 gzip B** in each paired comparison: second-build
`chunks/admin.js` contributes +3023/+777 B, the detail server load +67/+25 B, and
nodes 12/19/20 together +108/+34 B. Same-length import-table churn in other files
nets to exactly +0/+0 B; these files remain counted. There are still 116 server JS
files, not another runtime or server chunk inventory.

Identical-content groups already exist in **both parents and the composition**:
client nodes 0/2/5 (146 raw / 144 gzip B each), nodes 29/31 (422/231 B each), and
server `manifest.js` / `manifest-full.js` (6635 raw B each). No new duplicate JS
class appears. The two client CSS files differ from each other; server copies of
those styles are not another client group. No duplicate is excluded from a total.

### Smaller equivalent output considered

A narrower helper import does not remove the required bytes: the emitted shared
chunk already omits unused return-URL validation and parsing exports, and all
three consumers reference one implementation. Existing server configuration
already groups admin helpers and pages for co-compression. Removing required copy,
UTF-8 bounds, malformed-context refusal or generated route wrappers is not an
equivalent optimization, nor is discounting identical wrappers in the checker.

Because admin inherits `csr = false`, moving presentation calculations from Svelte
modules into server loads is a plausible **future** client-artifact optimization.
It requires changing page-data contracts and proving rendering, escaping, context,
authorization and audit equivalence with unchanged acceptance tests. No such source
change or equivalence proof is part of this bounded allocation; no saving from it
is claimed. This decision allocates the minimum for the **existing, measured**
composition, not a claim that every possible refactor has been exhausted.

## Minimum aligned allocation and refusal controls

Use the existing 512 B raw / 256 B gzip steps, not a percentage or reserve:

| Ceiling | Before | Proposed | Increase | Minimum observed remaining margin |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip B | 335104 | 335872 | 768 | 194 |
| Client JS raw B | 256000 | 257024 | 1024 | 390 |
| Client JS gzip B | 102912 | 103680 | 768 | 187 |

Ten controls run the unchanged exported checker on the retained composition
output, changing **only disposable budget copies**:

- Proposed limits accept the composition: exit 0.
- One server gzip step below proposed, 335616 B, rejects by 62 B.
- One client raw step below proposed, 256512 B, rejects by 122 B.
- One client gzip step below proposed, 103424 B, rejects by 69 B.
- Each axis independently accepts its exact second-build total and rejects one
  byte below it: server gzip 335678/335677 B, client raw 256634/256633 B and
  client gzip 103493/103492 B. Other axes retain proposed limits in these controls.

The unchanged checker also passes **12 selftests**, and the updated boundary pins
pass: `check-kit-perf.test.mjs` 36/36 and `budget-fragments.test.mjs` 27/27,
including the new 335872 server arm, the moved raw/gzip exact/one-over pins and
the fixed 256634 B evidence case. No author-owned test was weakened; only ceiling
literals moved with their fragments. This does not claim a full application check,
browser, visual, accessibility, Lighthouse, startup-latency, staging or production
verification.

Every other ceiling stays fixed: worker 3584 raw / 1536 gzip B; server 1203200 raw B
and 126 files; client JS 55 files; client CSS 3072 raw / 1024 gzip B and four files;
startup 60000 ms. The readiness timeout, not this byte measurement, enforces startup.
The composition has **zero spare client JS files**, only **5 B CSS gzip margin**,
and **194 B minimum observed server gzip margin**. None is reserved capacity.
Any later integrated head must be freshly rebuilt and pass exact-head CI, security,
QA and independent review; this note is not permission to bypass those gates.

## Undo

Revert only these three numeric changes and this note. This restores the
335104 B server gzip and 256000/102912 B client limits, intentionally rejecting the
measured composition again. No application state, schema or deployed artifact changes.
