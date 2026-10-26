# Event time: measured server-gzip cost and composition allowance

## Allocation proposal

Move Kit server JavaScript gzip bytes from **334080 to 334336** (one 256-byte
step) for the event-time composition. Every other numeric ceiling, file cap,
startup bound, checker, inventory, workflow, runtime, manifest, lock and
constraint stays unchanged. The budget's complete incoming `$comment` history
is preserved byte-for-byte (622700 characters on reconciliation main
`4d9ebeee5`). The original branch aligned three fixed server-gzip boundary
literals; the reconciliation below incorporates the independent test author's
explicit allocation mapping instead.

This allocation is neither feature approval nor release approval. The feature
owner must incorporate the reviewed decision, remeasure the actual integrated
head, and pass exact-head CI and independent review. No audit or gate is
skipped or disabled.

## Pinned inputs and method (initial decision)

- Main: `2fa2ef0885c5eb39d795f7412943bcfed7abe4b3` (tree
  `9aa557cb545ba05e6073a62c1a55a2194c8dc52c`).
- Combined source tree: `7fb5b0d0266ec2387b76596cb6e37a13a97557db`, built by
  applying the frozen six-source-file event-time delta (SHA256
  `7c95ba292ed195f39d555b0f270bdd271bd2aee2161a9b094783470ef177d979`)
  onto main with `git apply` (exit 0, no conflicts, no test changes):
  `src/events/date-format.ts`, `src/events/kit-detail.ts`,
  `src/events/pages-calendar-grid.tsx`, `src/events/pages-detail.tsx`,
  `src/islands/contracts-calendar.ts`, `web/src/lib/EventDetail.svelte`.
  Feature head [PR #1803](https://github.com/TogetherWeOwn/two-web-next/pull/1803)
  `6d810e08c7cc7b275b54f6b403d1326f00009a82`; availability base
  [PR #1778](https://github.com/TogetherWeOwn/two-web-next/pull/1778).
- Runtime: Node `24.22.1`, npm `11.19.1`.

Root and web package manifests and committed lockfiles are byte-identical
between the trees; the only main-side changes since the earlier `732a9582a`
evidence are the budget history, its shipping tests and this decision's
predecessor notes. Install each locked dependency root outside the synced
trees with `npm ci --include=dev --no-audit --no-fund`; both measurement
trees use the same root and web dependency installations. Remove all
database-URL variables from the build environment. Build twice per tree:

```sh
NODE_ENV=production WRANGLER_SEND_METRICS=false npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four builds exit 0. Pristine main passes the unchanged canonical checker
twice; the combined composition fails both times on exactly server gzip.
Gzip sizes use the canonical Node checker (`gzipSync` per-file totals), not
another compressor.

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Client JS files | 54 / 54 | 54 / 54 |
| Client JS raw | 253949 / 253949 | 254142 / 254142 |
| Client JS gzip | 102273 / 102273 | 102323 / 102323 |
| Server JS files | 115 / 115 | 115 / 115 |
| Server JS raw | 1178764 / 1178762 | 1179825 / 1179821 |
| Server JS gzip | 333874 / 333874 | 334189 / 334188 |

Worker entry stays 2551/1219 raw/gzip; client CSS stays 2 files at
2833/1006. The startup limit stays 60000ms; startup latency was not
measured. This reproduces the earlier `732a9582a` evidence (pristine
333873, combined 334190) within 2 bytes on the initial measurement base; both agree the
composition breaches the 334080 ceiling by about 109 bytes with a feature
increment of about 315 bytes.

## Attribution and source-optimization assessment

Server growth is **+1061 raw / +315 gzip** on build 1 and **+1059 raw /
+314 gzip** on build 2. Exact per-chunk attribution (canonical checker
arithmetic, identical feature-chunk deltas on both rebuild pairs):

| Server output | Raw delta | Gzip delta |
| --- | ---: | ---: |
| `chunks/events.js` | +543 | +130 |
| `chunks/site-shell.js` | +518 | +180 |
| Residual (`manifest.js`, `manifest-full.js`, `nodes/22.js`, `internal.js`, `profiles.js`, `instance.js`) | 0 / -2 | +5 / +4 net |

The two growing chunks carry the feature: one small pure elapsed-duration
formatter plus its Hono and Kit detail call sites (`events.js`), and the
Kit duration block plus calendar zone labels (`site-shell.js`). No new file,
route, import or dependency is added. The residual chunks shift by at most 3
gzip bytes each from embedded client-asset hash substitutions and ordinary
build variation (one chunk varies by 2 raw bytes on the second rebuild).

Client growth is +193 raw / +50 gzip and fits with 834 raw and 589 gzip
bytes to spare. Pristine server headroom is only 206 bytes, so the minimal
+315-byte feature cannot fit the existing ceiling by construction. Removing
required duration copy or zone labels would change the feature contract;
changing compiler settings or unrelated markup to save these bytes would
broaden this slice. Accept the attributed feature cost rather than introduce
that behavior risk or speculative optimization. No application edit and no
feature acceptance-test change ships with this decision.

## Minimality and unchanged enforcement (initial decision)

Run the unchanged canonical checker against the retained combined artifacts
with isolated budget copies (never edit the checker or the feature
artifacts):

| Server gzip ceiling | Expected and observed exit |
| ---: | --- |
| 334080 (current) | 1: server gzip fails |
| 334187 (measured minus one) | 1: server gzip fails |
| 334188 (measured) | 0: every group fits |
| 334336 (proposed) | 0: every group fits |

One smaller aligned 256-byte step below the proposal is the existing failing
ceiling. The proposal leaves at least 147 server gzip bytes across all
observed builds, deliberately far below an x1.25 allocation. Pristine main
also passes under the proposed ceiling. Client raw stays 254976, client gzip
stays 102912, server raw stays 1203200, file caps stay 55/126, CSS stays
3072/1024/4, and worker stays 3584/1536. Missing or invalid evidence and new
files still fail closed through the unchanged inventory and checker.

A production build of the standalone decision tree (main plus this budget,
note and regression alignment, without the feature) passes the canonical
checker: client 253949/102273, server 1178762/333874 raw/gzip, exit 0. No
feature source or feature acceptance-test changes ship on the decision
branch.

## Shipping-regression proof (initial branch; superseded below)

`ci/check-kit-perf.test.mjs` moves only the three server gzip boundary
literals to the new ceiling, as the suite's own history requires of an
intentional budget decision. All helpers, existing assertions and remaining
cases are untouched. Reproduce:

```sh
node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs
```

The suite passes 81/81 with no skips on Node 24.22.1. Without the alignment,
the suite fails exactly the stale `server gzip one byte over` case (334081
now admits). Independent scratch controls change only the copied shipping
ceiling and leave the checker unchanged:

| Control | Passed / failed | Observed protection |
| --- | ---: | --- |
| Server gzip reverted to 334080 | 28 / 2 | Exact admission and upper-bound diagnostic reject |
| Server gzip over-allocated to 334337 | 29 / 1 | Fixed upper-bound refusal incorrectly admits |
| Restored shipping budget | 30 / 0 | Every regression passes, no skips |

These results exercise checker behavior on synthetic complete fixtures, not
a substitute measurement of feature artifacts or a whole-app verdict.

## Conflict reconciliation on main `4d9ebeee5`

Main `4d9ebeee5b311dd5bedb606a57ea91183625c3c7` adds decision history and
independent shipping tests ([#1779](https://github.com/TogetherWeOwn/two-web-next/pull/1779),
[#1814](https://github.com/TogetherWeOwn/two-web-next/pull/1814)), plus
verification documentation. Application source, assets, manifests, both
lockfiles and the canonical checker are byte-identical to the initial
measurement base. Preserve all 622700 incoming history characters and every
incoming enforcement value except the proposed server gzip 334336. The live
feature head remains `6d810e08c7cc7b275b54f6b403d1326f00009a82`.

Repeat the same method above on **this main**, in separate pristine and
combined scratch worktrees sharing fresh locked dependency installs outside
the source trees. Verify the frozen patch's SHA256 before applying it; no
feature or test changes enter the decision tree. Node remains 24.22.1 and
npm 11.19.1. All four builds exit 0:

| Group | Pristine build 1 / build 2 | Combined build 1 / build 2 |
| --- | ---: | ---: |
| Server JS raw | 1178764 / 1178762 | 1179825 / 1179823 |
| Server JS gzip | 333874 / 333873 | 334190 / 334190 |
| Client JS raw | 253949 / 253949 | 254142 / 254142 |
| Client JS gzip | 102273 / 102273 | 102323 / 102323 |
| Canonical checker exit under 334080 | 0 / 0 | 1 / 1 (server gzip only) |

Counts stay 115 server JS, 54 client JS and 2 CSS files. Worker entry remains
2551/1219 raw/gzip and CSS remains 2833/1006. Exact feature-chunk deltas are
still `chunks/events.js` +543/+130 raw/gzip and `chunks/site-shell.js`
+518/+180. Residual server chunks add 0/+6 on pair 1 and 0/+7 on pair 2,
so total feature growth is +1061/+316 and +1061/+317. These are fresh
measurements, not a relabelling of the initial results; the one-byte gzip
variation does not justify a larger step.

On the retained combined build 2, isolated scratch-budget controls observe
334080 and 334189 fail (exit 1), and 334190 and 334336 pass (exit 0). The
proposed one-step allocation therefore still suffices, leaving **146 bytes**
over the maximum now observed. No other ceiling needs an increase. The
standalone reconciled decision tree also builds and passes the canonical
checker: server 1178762/333874 and client 253949/102273 raw/gzip, exit 0.

Main's new shipping tests explicitly support 334080 and 335104 but omit
this independently measured, smaller 334336 allocation. Taking main's test
file byte-verbatim reproduces four failures: the explicit-allocation control
and the three server-gzip cases (157/161 in the eight-file Kit gate, no skips).
The independent test author's [correction](https://github.com/TogetherWeOwn/two-web-next/commit/bb98fbbb43d394c027b3872e2609ebc6453e540f)
is incorporated byte-verbatim for `ci/check-kit-perf.test.mjs` (SHA256
`6b095ee20f9454d8d333fda98ec54109e56e890353f16feca3ded74c533c96d9`). It adds
fixed 334189/334336/334337 interval/exact/over witnesses and explicit mapping
and diagnostics; existing 334080 and 335104 cases and unrelated assertions
remain intact. Increasing the budget to 335104 just to satisfy the test would
be unjustified. This replaces the original three-literal edit without
replacing main's test structure.

On the actual reconciled tree, the two-file checker/inventory suite passes
82/82 and the eight-file collected Kit gate passes 161/161, with zero skips.
Independent scratch-budget controls run the corrected shipping suite 31/31
at each supported ceiling (334080, 334336 and 335104). Unsupported 334335,
334337 and 334592 each fail exactly four allocation/server cases (27 pass,
4 fail), so arbitrary adjacent or larger ceilings cannot pass. These are
synthetic boundary controls in addition to, not instead of, the real-artifact
measurements above.

`npm run typecheck`, `npm run lint`, `node ci/check-doc-links.mjs`,
`npm run floor-guard`, `npm run test:inventory -- --strict` (1254/1254 test
files, 55/55 Playwright specs), and `npm run budget` pass on the local
reconciliation. `context-pack --base origin/main` still exits at startup
with `RuntimeError: MCP server exited`; manual caller coverage is the
unchanged canonical checker, its shipping suite and the collected Kit gate.
Full `npm run check`, database tests, browser/a11y/Lighthouse and deployment
checks were not run for this budget-only reconciliation.

ACT: retain one 256-byte server-gzip composition step and current main's
history and independent test structure. WHY: repeated same-dependency
measurements attribute a real roughly 315-byte combined cost that pristine
main does not incur and cannot fit. UNDO: revert only this allocation,
note and its independent test entry if the feature is abandoned; do not
revert unrelated budget history, supported test allocations or independently
reviewed ceilings.

These measurements establish build-size behavior only. They do not establish
browser behavior, accessibility, startup timing or deployment health. No
staging, production, deployment, host action, migration or new spend is
involved.
