# Event time: measured server-gzip cost and composition allowance

## Allocation proposal

Move Kit server JavaScript gzip bytes from **334080 to 334336** (one 256-byte
step) for the event-time composition on current main. Every other numeric
ceiling, file cap, startup bound, checker, inventory, workflow, runtime, test,
manifest, lock and constraint stays unchanged. The budget's complete `$comment`
history is preserved byte-for-byte (621575 characters). The three fixed server
gzip shipping-regression literals move with the ceiling: exact admission 334336,
upper fixture 334337 and its diagnostic ceiling 334336.

This allocation is neither feature approval nor release approval. The feature
owner must incorporate the reviewed decision, remeasure the actual integrated
head, and pass exact-head CI and independent review. No audit or gate is
skipped or disabled.

## Pinned inputs and method

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
333873, combined 334190) within 1 byte on the current base; both agree the
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

## Minimality and unchanged enforcement

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

## Shipping-regression proof

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

ACT: allocate one 256-byte server-gzip composition step with its measurement
record and regression alignment. WHY: repeated same-dependency measurements
attribute a real +315-byte combined cost that pristine main does not incur
and cannot fit. UNDO: revert only this allocation, note and alignment if
the feature is abandoned; do not revert unrelated budget history or its
independently reviewed ceilings.

These measurements establish build-size behavior only. They do not establish
browser behavior, accessibility, startup timing or deployment health. No
staging, production, deployment, host action, migration or new spend is
involved.
