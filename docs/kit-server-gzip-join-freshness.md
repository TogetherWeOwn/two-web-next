# Kit server gzip: join freshness prerequisite

## Latest base reconciliation — 2026-10-23

Base `2540adb21d03c0e36eab1ca9fd8c6fbbbdabe106` adds only budget decision
history to the previously measured base `46e4ef79b`; no numeric limit, source,
lockfile or checker changes. Preserve that new base history verbatim, followed
by this branch's existing two decision notes exactly once. Every numeric limit
still equals the new base, including the **329472-byte** server gzip ceiling.

The double-build measurements below remain evidence from the earlier run,
not newly executed builds. This prose-only follow-up reruns the unchanged
checker selftests, checker tests, documentation checks and floor guard; it
does not rerun the full check, builds or feature fixture suites. Required CI
and independent review must still pass on the new PR head.

## Measured reconciliation — 2026-10-23

Base `46e4ef79b80e13470795d3608bf45fde73aad39f` now carries a larger
`server.js.maxGzipBytes` ceiling of **329472 bytes**. Resolve the budget conflict
by keeping **every numeric limit from that base**, with no additional allowance.
The original 327936-byte proposal below is historical, not the current limit.
Retain the base's complete decision history and the original join-freshness
decision exactly once, then record this reconciliation.

Rebuild both that base and its merge with the unchanged feature head
`99a4516f9811a1bf6a9660ddd900da8818e0c8d9`, using Node 24.22.1 and the same
current locked root/web dependencies. The feature integration's only merge
conflict is the budget file; supply the inherited limits there. Neither the
feature ref nor runtime code is changed by this prerequisite.

| Artifact | Current base, two builds | Current feature integration, two builds | Inherited limit |
| --- | ---: | ---: | ---: |
| Server JS files | 118 | 118 | 126 |
| Server JS raw bytes | 1124086 | 1124709–1124711 | 1203200 |
| Server JS gzip bytes | 327993–327995 | 328146–328148 | 329472 |
| Client JS files | 53 | 53 | 54 |
| Client JS raw bytes | 243912 | 244032 | 251904 |
| Client JS gzip bytes | 98767 | 98813 | 101632 |
| Client CSS files | 2 | 2 | 4 |
| Client CSS raw/gzip bytes | 2737/983 | 2737/983 | 3072/1024 |
| Worker entry raw/gzip bytes | 2551/1219 | 2551/1219 | 3584/1536 |

All four current checker runs exit **0** with the inherited limits. The
worst measured integration leaves **1324 bytes** of server gzip margin; do not
add the old 256-byte increment on top of the base's newer ceiling. Against the
second base build, the feature adds 623 raw and 151 gzip bytes: `chunks/src.js`
+291/+78, `chunks/admin.js` +136/+18, join load +41/+15, join SSR +155/+41,
and hash/version effects net −1 gzip. No new server file is introduced.
These are new measurements, not a claim that the historical builds below
changed or were byte-identical to the current build.

The existing six checker selftests, thirteen checker tests and 131 freshness
fixture tests pass on the current integration. A controlled ceiling one byte
below its measured server gzip still exits **1**; restoring the inherited
budget exits **0**. The feature still needs its own current-head CI and review.

## Original decision — 2026-10-23 (superseded numeric proposal)

Allow the measured server footprint of
[the join freshness fix, #1547](https://github.com/TogetherWeOwn/two-web-next/pull/1547)
in a separate budget PR. Change only `server.js.maxGzipBytes` in
`ci/kit-perf-budget.json`: **327680 → 327936 bytes**, one 256-byte step.
No runtime code, acceptance test, dependency, compressor, file-count cap,
other byte ceiling, startup bound or quality audit changes.

This is an explicit artifact-growth allowance, **not a size optimization**.
The feature must still pass its own exact-head CI and independent review after
integrating the merged prerequisite. This PR does not authorize the feature merge
or claim its pages were deployed or checked on staging.

## Reproduction

Use Node 24.22.1 and the committed root and `web/` lockfiles. Export these
commits with `git archive` into separate scratch directories:

- Base: `db0d82bb60b31221eafa906e9143792636e77744`.
- Feature integration: `99a4516f9811a1bf6a9660ddd900da8818e0c8d9`.

Install the same locked root/web dependencies for both with
`npm ci --include=dev` and `npm ci --prefix web --include=dev`.
For the recorded runs the installations lived outside the synced checkout,
with `node_modules` symlinks in each archive. Both lockfiles were byte-equal
between trees. Do not change Vite configuration or generated source inputs.
In each tree run twice:

```sh
npm run build --prefix web
npm run kit-perf
```

The checker sums `gzipSync(readFileSync(file)).length` from Node's `node:zlib`
**per file**, with default options. Do not substitute a different gzip level or
compress the concatenated bundle. Server sourcemaps are excluded by the unchanged
checker. Record raw lengths, gzip lengths and SHA-256 hashes per generated file.

| Artifact | Base, two builds | Feature, two builds | Existing limit |
| --- | ---: | ---: | ---: |
| Server JS files | 124 | 124 | 124 |
| Server JS raw bytes | 1113667 | 1114290–1114292 | 1203200 |
| Server JS gzip bytes | 327606–327607 | 327785 | 327680 |
| Client JS files | 53 | 53 | 53 |
| Client JS raw bytes | 249333 | 249453 | 249856 |
| Client JS gzip bytes | 100464 | 100514 | 100608 |
| Client CSS files | 2 | 2 | 4 |
| Client CSS raw/gzip bytes | 2737/983 | 2737/983 | 3072/1024 |
| Worker entry raw/gzip bytes | 2551/1219 | 2551/1219 | 3584/1536 |

Base checker exit: **0** twice. Feature checker exit: **1** twice, solely for
server gzip, 105 bytes over. Earlier measurements were 327604/327783 bytes;
this run reproduces the same breach within the documented three-byte rebuild
wobble, not byte identity with those earlier builds. Main is not red and this
is not a flake.

## Attribution and alternatives

Comparing the second build of each tree gives +178 bytes of server gzip:

| Server file | Raw delta | Gzip delta | Cause |
| --- | ---: | ---: | --- |
| `chunks/src.js` | +291 | +100 | Snapshot age and read-time freshness |
| `chunks/admin.js` | +136 | +21 | Hono conditional presence copy |
| `entries/pages/join/_page.server.ts.js` | +41 | +15 | Separate `widgetStale` boolean |
| `entries/pages/join/_page.svelte.js` | +155 | +40 | Kit conditional presence copy |
| `nodes/26.js` | 0 | +2 | Changed chunk reference |
| Other files | 0 | 0 net | Hash/version effects |

Against the first base build the net is +179 bytes. No server chunk was added.
The Hono screen ships through the Kit catch-all, so both renderers count here.

Prefer a behavior-preserving reduction when it removes actual waste. Here the
attributed additions implement required behavior: snapshot expiry uses
`fetchedAt` rather than a verdict clock refreshed by repeated 429s; stale presence
must not say “now”; and freshness travels separately from the four-field public
projection so member data remains private. Removing those checks, collapsing the
projection, or dropping one renderer's copy is not an acceptable optimization.
A broader chunk/minifier refactor would affect unrelated routes and diagnostic
constructor names for a 105-byte shortfall; it is not part of this prerequisite.
No claim is made that every possible equivalent refactor was benchmarked.

The first fitting 256-byte boundary is 327936, leaving 151 bytes at the measured
integrated size. A second step or a fresh 25% allowance would be speculative, so
neither is taken. Every other fitting limit stays fixed, even where its margin
is small. The checker must still reject the next over-budget build and refuse
missing or incompletely enumerated assets.

## Verification contract and rollback

Run `npm run kit-perf:selftest` and `node --test ci/check-kit-perf.test.mjs`.
Apply only this budget file to the feature **scratch archive**, rebuild twice,
and rerun `npm run kit-perf`. Run the unchanged snapshot-bound, fresh-only,
public-projection and stale-render tests there. Do not push to the feature ref.
The PR records the executed results separately from this reproduction recipe.

No production/staging database, network probe or deployment is needed for these
fixture/build checks. Reverting the original proposal would have restored its
prior ceiling and made the feature fail again. After reconciliation, this PR
changes no numeric limit: its rollback removes only decision/evidence prose,
leaving the independently landed base ceilings intact.
