# Event-time composition on main `7f1dc8c55`

## Decision

Raise only `server.js.maxGzipBytes` in `ci/budgets/kit/server-js.json`
from **335104 to 335360**: one 256-byte step, not x1.25 headroom.
The previous no-change proof in [the measurement history](../../../../docs/kit-event-time-server-budget.md)
is valid on its pinned base `a902d670f`, not on the newer application tree.
No product source, acceptance test, checker, other ceiling or frozen legacy
history changes in this decision.

## Reproduce

- Main: `7f1dc8c5521e2d9e1d4abfe54c0aeb8e1cfb9862`.
- Feature: [#1803](https://github.com/TogetherWeOwn/two-web-next/pull/1803),
  head `6d810e08c7cc7b275b54f6b403d1326f00009a82`.
- Frozen six-source-file feature patch SHA256:
  `7c95ba292ed195f39d555b0f270bdd271bd2aee2161a9b094783470ef177d979`.
  It applies without conflict; `kit-detail.ts` has a five-line offset from
  incoming error-correlation code. No feature tests enter the measured tree.
- Node 24.22.1, npm 11.19.1. Install root and web dependencies outside both
  source trees using the same committed manifests/lockfiles and
  `npm ci --include=dev --no-audit --no-fund`; share those installations.
  Remove database-URL variables. Build twice for each tree:

```sh
NODE_ENV=production WRANGLER_SEND_METRICS=false npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

The decision worktree's application and dependency inputs are byte-identical
to main. The composition is a separate archive of that main plus exactly the
frozen patch. All four production builds exit 0. Under unchanged main budgets,
both pristine checks exit 0; both composition checks exit 1 on server gzip only.

| Group | Pristine build 1 / 2 | Composition build 1 / 2 |
| --- | ---: | ---: |
| Server JS raw | 1182429 / 1182429 | 1183492 / 1183492 |
| Server JS gzip | 334839 / 334841 | 335143 / 335144 |
| Server JS files | 116 / 116 | 116 / 116 |
| Client JS raw | 254929 / 254929 | 255122 / 255122 |
| Client JS gzip | 102692 / 102692 | 102742 / 102742 |
| Client JS files | 54 / 54 | 54 / 54 |

Worker stays 2551/1219 raw/gzip; CSS stays 2861/1019 across two files.
Startup latency was not measured. The 60000ms readiness ceiling is unchanged.

## Attribution and minimality

Canonical Node `gzipSync` per-file totals attribute +1063 raw and +304/+303
gzip to the composition. `chunks/events.js` adds 543 raw / 123 gzip;
`chunks/site-shell.js` adds 518 raw / 181 gzip on both pairs. Residual files
add 2 raw / 0 or -1 gzip net; each residual gzip delta is at most 3 bytes.
Small rebuild variation is disclosed rather than treated as feature growth.

The two feature chunks still implement the required duration and calendar-zone
labels described in the historical assessment. There is no new dependency or
route. Removing that copy changes the feature; changing unrelated compiler or
markup behavior to reclaim 40 bytes broadens the slice. Accept the measured
cost with bounded headroom instead. Client raw/gzip retain 878/170 bytes;
CSS gzip retains 5 bytes. No unrelated ceiling is raised.

335104 is the next lower aligned 256-byte ceiling and fails by up to 40 bytes.
335360 leaves **216 bytes** above the maximum observed composition. Scratch
budget copies against retained composition build 2, with checker and artifacts
unchanged, verify the exact boundary independently of alignment:

| Server gzip ceiling | Observed checker exit |
| ---: | --- |
| 335104 | 1: server gzip fails |
| 335143 | 1: server gzip fails |
| 335144 | 0: all groups fit |
| 335360 | 0: all groups fit |

The existing independent `ci/check-kit-perf.test.mjs` already supports 335360
with fixed interval/exact/one-byte-over witnesses. Use it byte-identical to
main; do not rewrite tests to make the decision pass. The frozen fragment
history also remains byte-identical.

## Scope and rollback

The calendar clock repair [#1841](https://github.com/TogetherWeOwn/two-web-next/pull/1841)
is inherited from main, not duplicated or edited. Its local intercepted-browser
suite passes 40/40 with Chromium's available shared libraries. This is not a
staging, deployment, whole-app accessibility or Lighthouse verdict.

ACT: allocate one measured 256-byte server-gzip composition step.
WHY: current-base composition fails the old ceiling twice; all other groups fit.
UNDO: revert this fragment change and this decision only if the feature is
abandoned and no later allocation depends on it; preserve unrelated ceilings,
tests and historical decisions. The feature owner must remeasure the actual
integrated head and obtain exact-head CI and independent review. This decision
is neither feature approval nor release approval. No staging, production,
database, host, credential or spend action is involved.
