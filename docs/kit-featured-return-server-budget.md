# Featured inventory return: server gzip allocation

Measured 2026-10-25, remeasured 2026-10-26. This separate budget decision supports the native navigation
in [#1805](https://github.com/TogetherWeOwn/two-web-next/pull/1805); it does not
ship or approve that feature. The initial proposal changed only
`server.js.maxGzipBytes` in [`ci/kit-perf-budget.json`](../ci/kit-perf-budget.json):
**333568 → 333824 B**. Main subsequently allocated that ceiling in
[#1799](https://github.com/TogetherWeOwn/two-web-next/pull/1799), then independently
raised server gzip to 334080 B and client raw to 254976 B through
[#1800](https://github.com/TogetherWeOwn/two-web-next/pull/1800). Two conflict
reconciliations kept **no numeric change relative to main** while the base moved
only through budgets. The third reconciliation remeasures on a base that moved
through product sources (#1778, #1808): pristine main now builds 333874 gzip B
and the true combined tree builds 334473–334474 gzip B, over the inherited
334080 cap by 393–394 B. This PR therefore allocates two 256 B steps,
**334080 → 334592 B**, the minimum fitting allocation. All incoming
history and all three earlier featured-return records are retained; the latest
remeasurement below confirms the feature fits without any further allowance.

## Locked inputs and method

- Pristine main: `847bf4647def72aebcb84d1defa9ec8726afa207`.
- Feature: `576d7051f7d58fd7da55fdca5a047ed1de00b307`. Main is its ancestor,
  so that complete feature tree is also the combined tree; no merge reconstruction
  or partial feature overlay is needed.
- Node 24.22.1, npm 11.19.1, zlib `1.3.2.1-motley-285e94b`.
- Root lockfile SHA-256:
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`.
- Web lockfile SHA-256:
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both trees use identical lockfiles and dependency installations, installed with
  `npm ci --include=dev` outside the source trees and linked into them.
- Build with `npm run build --prefix web`, then run
  `node ci/check-kit-perf.mjs --format json`. Use `--root <tree>` when measuring
  an archived tree from the main checkout. The checker sums each emitted file's
  raw length and `gzipSync(bytes).length`; it does not compress concatenated files.
  Every generated JS/CSS file remains counted, including duplicate wrappers and
  manifests. Sourcemaps retain the checker's existing exclusion.

Two builds per locked input, before any budget change:

| Group | Pristine main raw / gzip B | Combined feature raw / gzip B | Files / cap | Unchanged raw / gzip cap B |
| --- | ---: | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry | 3584 / 1536 |
| Server JS | 1176054–1176056 / 333150–333151 | 1178089 / 333741–333745 | 115 / 126 | 1203200 / 333568 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 | 254464 / 102912 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 | 3072 / 1024 |

The unchanged gate passes pristine main (exit 0) and refuses the combined tree
only for server gzip (exit 1, **173–177 B over**). Rebuild variation is reported,
not hidden: server gzip varies by 1 B on main and 4 B on the feature. Client
JS/CSS and Worker totals repeat exactly. The earlier feature measurement of
333743 gzip B falls inside this independently reproduced range.

## Attribution and no-allowance alternative

First-build server attribution, using output paths rather than client content hashes:

| Emitted file | Before raw / gzip B | After raw / gzip B | Delta raw / gzip B |
| --- | ---: | ---: | ---: |
| `chunks/admin.js` | 412754 / 101024 | 414371 / 101493 | +1617 / +469 |
| `entries/pages/admin/featured/_id_/_page.server.ts.js` | 685 / 434 | 981 / 529 | +296 / +95 |
| `entries/pages/admin/featured/_page.server.ts.js` | 1385 / 691 | 1507 / 735 | +122 / +44 |
| Remaining server files, net | — | — | 0 / −18 |
| **Total** | **1176054 / 333151** | **1178089 / 333741** | **+2035 / +590** |

The admin chunk contains the shared five-field return codec, native Hono form
links/copy and route propagation. The two Kit loaders compute the edit, return,
save and delete URLs server-side. The existing featured-list parser remains the
single normalization authority; no second validator, new runtime dependency,
new server file or browser navigation controller is introduced. The edit route
already disables client-side rendering. This PR changes none of that source.

A disposable single-pass parser experiment replaced `some` plus
`Object.fromEntries(map(...))` with a five-field loop collecting first values and
tracking presence before calling the same normalizer. It built **1178118 raw /
333738 gzip B**, still **170 B over** the original ceiling, while growing raw
output by 29 B. It was discarded and the exact feature blob restored. This is
size evidence only, not a claim of acceptance-test equivalence. Moving required
markup or validation away, weakening bounds, or changing bundling globally to
recover these bytes would exceed this narrow allocation's scope.

## Minimum step and refusal controls

One existing 256 B gzip step gives **333824 B**, leaving **79–83 B** against the
two measured unmodified feature builds. Zero steps fails. This is not an x1.25
allowance or reserved capacity for another feature. Server raw and file caps,
all client/Worker caps and the 60000 ms startup ceiling remain unchanged. The
byte gate does not measure actual startup time; the existing parity readiness
timeout enforces that separate bound.

Using retained unmodified feature output at 1178089 raw / 333745 gzip B and
115 files, disposable budget controls exercised the unchanged exported checker:

- Original server gzip cap: exit 1, 177 B over.
- Proposed 333824 B cap: exit 0 across all asset groups.
- Exact actual server raw/gzip/file caps: exit 0.
- Actual server gzip minus one byte: exit 1.
- Actual server raw minus one byte, with the proposed gzip cap: exit 1.
- Actual server file count minus one, with the proposed gzip cap: exit 1.
- Existing `node ci/check-kit-perf.mjs --selftest`: 12 passed.
- Existing `node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs`:
  64 passed, zero failures or skips, including empty/missing/incomplete evidence
  and unbudgeted-asset refusals. No acceptance test files were edited.

After restoring the exact feature source and copying only the proposed budget,
a fresh build passes every group at **1178091 raw / 333744 gzip B**, 115 server
files (80 B gzip margin). The two-byte raw variation is included rather than
attributed to an application edit. Its client, CSS and Worker totals are unchanged.
Pristine main also passes with the proposed cap at 1176056 raw / 333150 gzip B.

The feature's client raw margin is only **99 B**, CSS gzip margin **18 B**, and
new server gzip margin at least **79 B** across the unmodified feature builds. Do not treat this
allocation as proof for a future composition: rebuild the actual integrated head
and retain all normal CI/security/independent-review gates. The feature remains
non-reviewable until its separate acceptance corrections and prerequisite work
are resolved.

## Reconciliation after main adopts the same ceiling

Main `826b40e85ab3201f199e4613f7f488a1e5d8b314` merges #1799. The diff from the
original pristine main `847bf4647` changes **only** `ci/kit-perf-budget.json`:
server gzip becomes 333824 B and a different feature's decision is appended.
Application sources, lockfiles and checkers are identical. Preserve main's full
history as an exact prefix, retain this feature's original decision once, and
append this reconciliation. Do not add the two identical steps together.

Fresh repeat builds with the resolved plan and the same locked dependencies:

| Group | Pristine current main raw / gzip B | Frozen featured-return composition raw / gzip B | Files / cap |
| --- | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry |
| Server JS | 1176054–1176056 / 333150–333152 | 1178091 / 333743–333744 | 115 / 126 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 |

All four checker runs pass. The measurement-only composition uses frozen feature
`576d7051f7d58fd7da55fdca5a047ed1de00b307` plus the resolved budget; the budget-only
base move leaves its application tree identical. These measurements do not
compose the other unmerged feature from #1799. Any future application-source
combination needs its own fresh measurement.

On the second composed artifact, the old 333568 B cap still fails by 176 B;
333824 B passes with 80 B margin. Exact measured server limits pass, while
actual-minus-one gzip, raw and file-count limits each fail. The unchanged checker
selftests pass 12/12 and the two checker suites pass 64/64 with no skips. No numeric
field differs from current main, and no acceptance test is edited.

ACT: reconcile the conflict and record a no-additional-allowance decision.
WHY: the complete frozen featured-return tree fits the now-inherited cap.
UNDO: remove only this feature's appended history and this note; leave main's
independently reviewed 333824 B ceiling and its decision intact.

## Second reconciliation: retain current main's independent allocations

Main `2f9e60791` incorporates #1785 and #1800. Since `826b40e85`, only the budget
and two error-correlation measurement documents changed. Runtime sources,
lockfiles and checkers remain byte-identical. Take every incoming numeric limit
verbatim: server gzip **334080 B**, client raw **254976 B**, all other limits
unchanged. Keep main's complete history as an exact prefix, then this branch's
original decision and first reconciliation exactly once. No additional capacity
or reserved headroom is allocated by this PR.

On 2026-10-25, two fresh builds per unchanged application tree, with the resolved
budget and the same external dependency installations, produced:

| Group | Pristine main raw / gzip B | Frozen featured-return raw / gzip B | Files / cap |
| --- | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry |
| Server JS | 1176054–1176056 / 333150 | 1178091 / 333743–333745 | 115 / 126 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 |

All four builds and checker runs pass. Since the base move has no application
changes, the archived pristine and frozen-feature sources are byte-identical to
the current-main and frozen-feature application compositions respectively; only
the resolved budget is overlaid. This does not compose any other unmerged
feature measured by #1799, #1785 or #1800.

On the second feature artifact, inherited limits pass with **335 B server gzip**
and **611 B client raw** margin. The original 333568 B server gzip cap rejects by
177 B; exact measured server raw/gzip/file limits pass; actual-minus-one gzip,
raw and file-count limits each reject. The unchanged checker selftests pass
12/12 and its two suites pass 64/64 without skips. Lint, docs links, floor guard,
strict test inventory (1249/1249 files and 54/54 browser specs), root/CI types and
E2E types pass. No full local check is claimed for this second reconciliation;
the earlier interrupted full-check limitation remains disclosed in the PR.

ACT: resolve the new history conflict without changing any incoming ceiling.
WHY: complete frozen featured-return output already fits main's independent
allocations. UNDO: remove only this branch's history and note, not main's limits.
The 18 B CSS gzip margin remains thin; future application unions must remeasure.

## Third reconciliation and allocation: base sources moved

Main `732a9582a` merges #1668 (combined-board client history), #1808
(admission-diagnostics sources) and #1778 (schedule-availability sources,
styles, baselines) on top of `2f9e60791`. Twelve product paths moved under
`src/` and `public/`; lockfiles (root
`023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`, web
`feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`) and checkers
are byte-identical, and every numeric ceiling still equals the previous head.
Because application inputs moved, the prior "no allowance" conclusion cannot be
carried forward: both trees were rebuilt on the post-merge head.

The combined tree is a clean scratch merge of current main `732a9582a` with the
frozen feature `576d7051f7d58fd7da55fdca5a047ed1de00b307` (8 build-input files,
no conflicts), overlaid with the resolved budget only. Feature #1805 has since
moved to `e7950bc1`, but its drift is three test-only commits: every build
input is byte-identical to the frozen ref, so the measurement stands for the
current feature head too. Two locked builds per tree (Node 24.22.1, npm 11.19.1,
zlib `1.3.2.1-motley-285e94b`, identical dependency installations):

| Group | Pristine main raw / gzip B | Combined raw / gzip B | Files / cap |
| --- | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry |
| Server JS | 1178764 / 333874 | 1180797–1180799 / 334473–334474 | 115 / 126 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 |

Pristine passes the inherited 334080 B cap with 206 B; combined fails it by
393–394 B (exit 1). Per-chunk attribution on the second build pair shows the
feature delta is the same code as originally measured: `chunks/admin.js`
+1617 / +470, the two featured loaders +296 / +95 and +122 / +44, with 23
raw-identical files contributing only ±8 B of gzip-context noise (net +2033 /
+600). The base itself moved +724 gzip B under the feature through #1778/#1808.
The prior single-pass parser experiment's conclusion stands: no
behavior-preserving no-allowance optimization is established, and any
application change belongs on the feature PR, not here.

One 256 B step (334336) still refuses the second combined artifact by 138 B,
so the minimum fitting allocation is two steps, **334080 → 334592 B** (+512,
118 B minimum margin). No other ceiling moves: server raw (22401 B margin),
file count, client, CSS, Worker and startup limits are unchanged.

Disposable budget controls on the retained second combined artifact, using the
unchanged exported checker:

- Inherited 334080 B cap: exit 1, 394 B over.
- One-step 334336 B cap: exit 1, 138 B over.
- Proposed 334592 B cap: exit 0 across all asset groups.
- Exact actual server raw/gzip/file caps: exit 0.
- Actual server gzip minus one byte: exit 1.
- Actual server raw minus one byte, with the proposed gzip cap: exit 1.
- Actual server file count minus one, with the proposed gzip cap: exit 1.
- Existing `node ci/check-kit-perf.mjs --selftest`: 12 passed.
- Existing `node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs`:
  64 passed, zero failures or skips. No acceptance test files were edited.

Lint (Biome, 2067 files), docs links (164 files), floor guard, strict test
inventory (1254/1254 files, 55/55 browser specs), config docs, island bundle
budget, and root/CI/E2E typechecks pass. No test pins the old cap value. The
full `npm run check` suite is not claimed; CI runs it on the exact head.

ACT: resolve the history conflict and allocate the minimum fitting two-step
server gzip increase. WHY: the remeasured post-merge union exceeds the
inherited cap by 394 B and one step still refuses it. UNDO: revert only this
334592 → 334080 B step and this PR's appended history/note, never main's
allocations. The 118 B server and 18 B CSS gzip margins remain thin; the
feature's exact integrated head must still remeasure and pass all normal gates.

## Fourth reconciliation: feature sources moved, ceiling stands

Main `4d9ebeee5` adds #1779 (client budget history) and #1814 (shipping
tests now support server gzip 334080 and 335104 through an explicit
two-entry fixed-literal mapping; any other ceiling fails the allocation
control and the three server cases). Since the round-three base
`732a9582a`, main moved only through `ci/` and `docs/`: no product
source, lockfile or checker changed. The feature, however, moved past
the frozen ref: `de2487c4` edits the Kit build input
`web/src/routes/admin/featured/[id]/+page.server.ts` (+3/−1) and
`432820f89` adds tests. Because a build input moved, both trees were
rebuilt on the post-merge head.

The combined tree is a clean scratch merge of current main `4d9ebeee5`
with feature head `432820f89` (no conflicts; the four Kit inputs are
byte-identical to the feature versions and main never touched them),
overlaid with the resolved budget only. Two locked builds per tree
(Node 24.22.1, npm 11.19.1, zlib `1.3.2.1-motley-285e94b`, root and web
lockfiles byte-identical at both refs):

| Group | Pristine main raw / gzip B | Combined raw / gzip B | Files / cap |
| --- | ---: | ---: | ---: |
| Worker entry | 2551 / 1219 | 2551 / 1219 | one entry |
| Server JS | 1178762–1178764 / 333874–333876 | 1180821–1180823 / 334487 | 115 / 126 |
| Client JS | 253949 / 102273 | 254365 / 102446 | 54 / 55 |
| Client CSS | 2833 / 1006 | 2833 / 1006 | 2 / 4 |

Pristine repeats the round-three totals within 2 B and passes the
inherited 334080 B cap; combined fails it by 407 B (exit 1, both
builds). Per-chunk attribution on the second build pair shows the same
feature code plus the fix: `chunks/admin.js` +1617 / +470, the
`[id]` loader +320 / +108 (the fix adds +24 / +13 over round three),
the featured-list loader +122 / +44, with 23 raw-identical files
contributing only gzip-context noise (net +2057 / +613).

Disposable budget controls on the retained second combined artifact,
using the unchanged exported checker:

- Inherited 334080 B cap: exit 1, 407 B over.
- One-step 334336 B cap: exit 1, 151 B over.
- Proposed 334592 B cap: exit 0 across all asset groups.
- Exact actual server raw/gzip/file caps: exit 0.
- Actual server gzip minus one byte: exit 1.
- Actual server raw minus one byte, with the proposed gzip cap: exit 1.
- Actual server file count minus one, with the proposed gzip cap: exit 1.

**334080 → 334592 B remains the minimum fitting allocation** (105 B
margin, down from 118 B). The #1814 allowance of 335104 B (worst
334994) is not adopted: it is not reproducible from these locked
inputs, whose worst is 334487 B on both builds — 507 B lower,
deterministic, on the same locked toolchain that reproduces every
prior round. Adopting it would swallow 507 B of unexplained growth.

This merge takes main's restructured shipping tests verbatim; the
earlier test-owner literals for this ceiling predate that structure and
no longer apply. The merged tree therefore fails exactly the new
allocation control plus the three server cases: fail-closed by design,
never green for the wrong reason. A test-owner correction adding the
measured 334592 allocation (interval witness 334487, exact 334592,
one-over 334593) is pending; this PR holds unpushed until it lands.

ACT: resolve the history conflict, keep the measured two-step server
gzip increase, and hold the merge for the test correction. WHY: the
remeasured current union needs 334592 B and one step still refuses it.
UNDO: drop the local merge; main's #1779 history and #1814 tests are
untouched.

## Undo and scope

The original pre-main proposal's undo was 333824 → 333568 B, intentionally
refusing the measured feature. That numeric change now belongs to #1799, not
this reconciled PR. The first two reconciliations were history-only. This third
reconciliation adds one numeric step pair, 334080 → 334592 B: reverting this PR
removes that step and its appended history/note, and must not undo main's own
allocations. The fourth reconciliation keeps that same step on fresh
measurements and holds the merge for the test-owner correction. No application, schema, test, dependency,
workflow, checker, mask, skip or exemption changes are included. No deployment
or production/staging database test is part of this work.
