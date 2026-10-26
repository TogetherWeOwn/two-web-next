# Kit schedule return: measured server gzip allowance

## Current decision (after the budget-fragment reconciliation)

Main's [#1858](https://github.com/TogetherWeOwn/two-web-next/pull/1858) replaced
the monolithic budget files with per-unit fragments. Reconcile onto main
`0f8fdd17f21abe7d0f7c015001b9415b180efe99` by accepting that deletion and moving
only this branch's unique history, verbatim, into the new
[schedule-return decision](../ci/budgets/decisions/kit-perf/2026-10-26-schedule-return-server-gzip.md).
Every fragment, frozen legacy decision, checker and test remains byte-identical
to incoming main. Do not restore `ci/kit-perf-budget.json`: alongside fragments
it is ambiguous authority and the checker fails closed.

All production inputs (`src/`, `assets/`, `public/`, `web/`, root package manifest
and lockfile, TypeScript and Wrangler configuration) are byte-identical between
this main and the previously measured `0fe4dd903`. The earlier composition below
is same-input historical evidence, not a new execution or approval. The parent
must remeasure its real integrated head with the fragment-aware checker.

Fresh resolved-tree verification (Node 24.22.1, npm 11.19.1, locked external
installs, production build with database/token/secret variables scrubbed):

- Two `npm run build --prefix web` executions and the fragment-aware canonical
  checker both exit 0. Server: 115 files, 1179528/1179526 raw bytes, both
  334041 gzip; client: 54 files, 253949 raw / 102273 gzip. Worker: 2551 raw /
  1219 gzip; CSS: two files, 2833 raw / 1006 gzip. Startup is not timed.
- The exact CI Kit node-test batch, now including fragment tests, passes
  **192/192**; checker selftest passes **12/12**. Before removing the obsolete
  monolith, the fragment/shipping batch fails on ambiguous authority; afterwards
  it passes **62/62**, with no test changes.
- Lint (2104 files), typecheck, documentation links and floor guard pass.
  Full `npm run check`, browser/a11y/Lighthouse, DB and live probes are not run.
  No feature or release acceptance is claimed.

Main has independently landed the identical ceiling this PR proposed, so the
reconciled PR now moves **no** numeric bound and records the evidence only:

| Budget field | Original main | Current main | This PR | Net increase |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 334080 | 335104 | 335104 | 0 |

The fresh composition below re-proves 335104 remains the minimum aligned
allowance on the newest main: `ceil(335087 / 256) * 256 = 335104`, 17 bytes of
observed margin. Every numeric field, checker, inventory, manifest, lock,
constraint and test stays identical to incoming main; the shipping test file
is taken byte-for-byte from main. No feature/runtime change is authored here.
This prerequisite does not reserve capacity or approve the feature: the
parent must remeasure its actual integrated head and pass exact-head CI and
independent review.

## Second reconciliation and fresh measurements

After the first reconciliation (below), main advanced three commits past
`4d9ebeee5` and GitHub reported conflicts again on head `e976dbda6`:

- [#1826](https://github.com/TogetherWeOwn/two-web-next/pull/1826) raised
  main's own server gzip ceiling 334080 → 335104 for the merged
  inventory-return slice (its head measured 334807) — the same value this PR
  proposed independently.
- [#1812](https://github.com/TogetherWeOwn/two-web-next/pull/1812) added
  search-match context to the events cards, growing the pristine-main server
  bundle (fresh builds below).
- [#1827](https://github.com/TogetherWeOwn/two-web-next/pull/1827) added a
  third supported allocation, 335360, to `ci/check-kit-perf.test.mjs` (its
  combined worst 335338, margin 22) without changing the shipping 335104
  ceiling.

Resolve the single conflict (`ci/kit-perf-budget.json` `$comment` history)
by keeping incoming main's complete history verbatim as the prefix, retaining
the branch-only schedule-return record once, appending one reconciliation
note, and keeping every number exactly equal to main — a reviewer can verify
this by comparing the parsed JSON values. `ci/check-kit-perf.test.mjs` stays
byte-identical to incoming main, including the #1827 335360 allocation
controls; no acceptance test is authored or edited. The inherited
335104-allocation interval probe is fixed at 334994, now **below** this
composition's 335087 maximum; it remains #1814's fixed evidence for the
allocation, not this slice's measured size — which is exactly why the parent's
own exact-head measurement, not this probe, is the gate.

Fresh builds on newest main `0fe4dd90396dc17d7985ae6e5df24ebad46c226e`
(Node 24.22.1, npm 11.19.1, external locked installs — root lock SHA-256
`023b560f…631d`, web lock `feaa492a…565e`, byte-identical across the measured
trees; `NODE_ENV=production`, database/token/secret variables scrubbed):

- Pristine main, two builds: checker exit 0; server 1179526 raw,
  334041/334038 gzip, 115 files; client 253949 raw / 102273 gzip, 54 files.
  Main alone now sits 1063 bytes under its own 335104 ceiling after #1812.
- Composing newest main with the frozen feature `9968879` conflicts in
  exactly one file, `src/events/pages-calendar-card.tsx`, at the two lines
  both slices touched (the `schedule` prop destructure and the title anchor).
  For measurement only, resolve those two lines as the union of both changes
  in a scratch worktree (scratch tree
  `20651183e15ea9337f94b400aae18584babcba17`); that resolution is never
  shipped and binds nothing — the parent's owner resolves the same lines in
  the feature integration. Two builds: server 1183212 raw, 335085/335087
  gzip, 115 files; client 254010 raw / 102287 gzip, 54 files; Worker and CSS
  unchanged. The feature adds +3686 raw / about +1046 gzip over the new
  pristine main, the whole raw delta again in `chunks/events.js` (+3686 raw,
  +1027 gzip by per-file compare; remaining bytes are same-size repeat churn
  in five other chunks), and the composed tree **fits** the already-shipping
  335104 ceiling with 17 bytes of observed margin.
- Unchanged-checker `runJson` controls on the archived composed output,
  **5/5**: 335104 admits (exit 0, every group fits); 334848, exact-minus-one
  (335086) and the former 334080 each reject with server gzip the only
  failing group; exact fit (335087) admits.
- The resolved decision-only tree (newest main plus the history and doc
  records) therefore needs no new build to fit: it is numerically identical
  to the pristine-main builds above. Net diff versus main is the budget
  history line and this document only.
- The CI Kit node-test batch, selftest, lint and typecheck results for this
  reconciled head are reported in the PR verification section. Full
  `npm run check` and browser/DB/live checks are not run. The prior
  pre-review score applies to its original head; new exact-head CI and
  review remain required.

Because the composed maximum now sits only 17 bytes under the ceiling, the
parent's true union head could need the already-supported 335360 allocation.
This PR proposes no such step: only the parent's measured integrated head can
justify it, by the same reconcile-and-remeasure discipline used here.

The first reconciliation, its measurements, and the original pinned evidence
below remain historical records for their named trees.

## First conflict reconciliation and its measurements

Merge incoming main head `4d9ebeee5b311dd5bedb606a57ea91183625c3c7` into this
PR after GitHub reports conflicts. The two conflicts are decision history and
the now-superseded test literals. Preserve incoming main's complete history as
an exact prefix, append the branch-only decision once, and retain every main
bound except the measured server gzip allowance. Keep
`ci/check-kit-perf.test.mjs` identical to main, including its explicit
334080/335104 allocation controls from [#1814](https://github.com/TogetherWeOwn/two-web-next/pull/1814).
No acceptance test is authored or edited by this reconciliation. The inherited
335104-allocation interval probe is fixed at 334994, above this composition's
334942 maximum; it is #1814's conservative evidence, not this slice's measured
size. Its 333639 probe remains in the original 334080-allocation branch.

The intervening main changes from `91b66a68d` touch only
`ci/kit-perf-budget.json` and `ci/check-kit-perf.test.mjs`. Runtime source,
assets, build configuration and both locks are byte-identical. Nevertheless,
rebuild both trees with the same external locked installs (Node 24.22.1,
npm 11.19.1, `NODE_ENV=production`, database/token/secret variables scrubbed):

- Pristine main: `npm run build --prefix <archive>/web`, then its canonical
  checker with `--format json`: exit 0, server 1178764 raw / 333873 gzip,
  115 files; client 253949 raw / 102273 gzip, 54 files.
- Compose main with the same frozen feature `9968879` using conflict-free
  `git merge-tree --write-tree`; tree `f1287813c892cd0983a0146a683efda551c6a2cb`.
  Two builds: server 1182450/1182448 raw, 334942/334941 gzip, 115 files;
  client 254010 raw / 102287 gzip, 54 files. Both checker runs exit 1,
  failing server gzip only at main's 334080 ceiling.
- On both archived outputs, unchanged `runJson` proves all **10/10** controls:
  335104 passes all groups; 334848, exact-minus-one and restored 334080
  fail only server gzip; exact fit passes. The 335104 proposal remains the
  minimum aligned allowance, now with 162 bytes of observed margin.
- The resolved budget-only worktree build passes every group: server
  1178764 raw / 333875 gzip, 115 files; client 253949 / 102273, 54 files;
  Worker 2551 / 1219; CSS 2833 / 1006, 2 files. Startup is not timed.
- The full CI Kit node-test batch passes **161/161**, selftest **12/12**,
  and lint passes. Unmodified incoming shipping tests pass **31/31** at
  334080 and at 335104; unsupported 335103 and 335105 each fail as expected.
  An initial batch without installed dependencies failed the Playwright
  wiring test with `MODULE_NOT_FOUND`; the locked install resolves that
  environment failure. Full `npm run check` and browser/DB/live checks are
  not run. The prior pre-review score applies to its original head,
  not the reconciled head; new exact-head CI and review remain required.

The original pinned measurements below remain historical evidence, not claims
about the reconciled tree. Rebuild variation does not alter the minimum
aligned ceiling; it is not permission to ignore a breach.

## Original pinned inputs

- Main: `91b66a68d2d37bd2c717f3a75299300d3617b811`.
- Frozen feature: `9968879992bbb023f57776b26c3feb2069f9e9c6`
  (branch `feat/schedule-detail-return`).
- Scratch composed tree: `1db090d43ab9085b1f1b89f49603a85183ba6f47`, a real
  `git merge` of the frozen feature into pinned main with zero conflicts.
  This scratch measurement does not modify or approve the parent's branch.
- Node `24.22.1`, npm `11.19.1`, root/web locked installs with
  `npm ci --include=dev`. Root lock SHA-256
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`;
  web lock SHA-256
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
  Both lockfiles are byte-identical between the measured trees (`cmp` clean),
  so both trees build against the same installed dependencies.
- `NODE_ENV=production` in all builds. The first build pair ran with inert
  staging/PlanetScale URL variables present; the second pair and the third
  combined build ran with them scrubbed. Outputs agree within 2 bytes, so the
  extra variables are demonstrated inert, not assumed so. Local artifacts only;
  no database, live probe, staging, migration or deploy.

## Original repeated production builds

Per tree: `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`. All five builds exit 0. The
unchanged canonical checker sums individual files' default-`gzipSync` sizes;
this is not a concatenated archive or another compressor. Both pristine builds
pass main's complete budget. All three combined builds fail only server gzip.

| Tree / build | Server files / cap | Server raw / ceiling | Server gzip / main ceiling | Client raw / gzip | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Pristine main 1 | 115 / 126 | 1178762 / 1203200 | 333875 / 334080 | 253949 / 102273 | exit 0 |
| Pristine main 2 | 115 / 126 | 1178764 / 1203200 | 333874 / 334080 | 253949 / 102273 | exit 0 |
| Combined 1 | 115 / 126 | 1182448 / 1203200 | 334938 / 334080 | 254010 / 102287 | exit 1, server gzip |
| Combined 2 | 115 / 126 | 1182448 / 1203200 | 334938 / 334080 | 254010 / 102287 | exit 1, server gzip |
| Combined 3 | 115 / 126 | 1182450 / 1203200 | 334940 / 334080 | 254010 / 102287 | exit 1, server gzip |

The maximum observed combined server gzip, 334940, selects the proposal. The
2-byte spread across combined builds is observed build variation (see repeat
identity below), not permission to ignore a breach or claim an unmeasured
churn bound.

## Original actual-output negative controls

Apply each ceiling to both archived combined outputs (builds 2 and 3) and run
the unchanged checker via its real `runJson` entry point. Every other ceiling
stays at main's values; emitted artifacts stay fixed.

| Server gzip ceiling | Build 2 (334938) | Build 3 (334940) |
| ---: | --- | --- |
| 335104 (proposed) | exit 0, every group fits | exit 0, every group fits |
| 334848 (one aligned step less) | exit 1, server gzip only | exit 1, server gzip only |
| exact fit (334938 / 334940) | exit 0 | exit 0 |
| exact fit minus one byte | exit 1, server gzip only | exit 1, server gzip only |
| 334080 (restored main) | exit 1, server gzip only | exit 1, server gzip only |

**10/10** expected outcomes match exits and failing-group identities. No
smaller aligned ceiling fits either output.

Unaffected groups on the combined builds, at main's unchanged limits: Worker
entry 2551/3584 raw, 1219/1536 gzip; client JavaScript 54/55 files, 254010
raw, 102287 gzip; client CSS 2/4 files, 2833 raw, 1006 gzip; server raw
1182450/1203200 with 115/126 files. Startup remains 60000ms, **not timed**.

## Attribution and repeat identity

Versus pristine main, the combined slice adds 3686 server raw bytes and
1063–1066 server gzip bytes with no new chunk. A per-chunk split attributes
the whole raw delta and +1037 gzip bytes to `chunks/events.js`: the shared
schedule-context parser/builders, grid-origin link context and twin
continuation controls (the combined chunk contains the new `Back to schedule
results` / `Back to calendar` labels). The remaining ~13–29 gzip bytes are
cross-chunk deflate wobble, including same-size reference churn in
`chunks/site-shell.js`; no other counted chunk changes.

Within the combined repeats, 181 of 183 server files are byte-identical; only
`chunks/instance.js` and `chunks/internal.js` vary (same size, different hash),
matching the known repeat signature. All client JavaScript/CSS bytes are
identical; only the uncounted `_app/version.json` stamp differs. No asset or
file-count check is hidden.

A behavior-preserving size reduction is not available without deleting
safeguards: the growth is the bounded parser's refusal paths, the context
linkage and the continuation controls the slice exists to add. The ordinary
island budget already fits unchanged on the feature branch.

## History, scope and limitations

Incoming main's `$comment` history stays byte-for-byte as the prefix, followed
by this decision's unique record and its two reconciliations; no earlier
record is edited or removed. After the second reconciliation the standalone
decision tree is numerically identical to the measured pristine main, so its
fits verdict is the pristine builds above.

Two parked sibling budget PRs propose higher server gzip ceilings
(`#1786` → 335360, `#1806` → 334592); both currently conflict and neither is
merged or relied upon here. If `#1786` lands first, its ceiling absorbs the
measured 335087 and this PR reconciles to history-only; `#1806`'s ceiling
would not absorb it. If this PR lands first, the siblings reconcile upward on
their own measurements. Either order keeps exact-head enforcement. Since
then, [#1827](https://github.com/TogetherWeOwn/two-web-next/pull/1827)
already landed the test support for 335360 while keeping 335104 the shipping
ceiling; this PR does not select that allocation.

No feature source or feature acceptance-test change ships on the decision
branch. Feature behavior, database cases, browser journeys, accessibility,
live pages, startup latency and full `npm run check` are not established by
this experiment.

ACT: reconcile to main's identical 335104 ceiling with no numeric change,
consume main's independent fixed-allocation tests unchanged and record the
remeasured evidence.
WHY: main landed the proposed value on its own evidence, and two fresh
compositions on the newest main fit it (335087 maximum) while one aligned
step less still rejects. UNDO: revert this history and document record; the
ceiling itself now belongs to main. The parent owns actual reintegration and
acceptance.
