# Kit error correlation: combined budget reconciliation

## Current decision after the base-conflict wake

GitHub reported the budget-only PR conflicting at `1d327af96`. Merge incoming main
`826b40e85ab3201f199e4613f7f488a1e5d8b314` into this branch as requested; the only
manual conflict is `ci/kit-perf-budget.json`. Keep incoming history **byte-for-byte**
(SHA-256 `4762dfe891d0c0aa624c208f3f31773601cef114fc45d1aaf62c532e4fefbdfb`).
Main independently raised server gzip to 333824; do not stack that allocation on
this proposal. The two final ceilings stay exactly as previously proposed:

| Field | Incoming main | Final proposal | Additional bytes vs incoming main | Minimum measured margin |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 333824 | 334080 | 256 | 107 |
| `client.js.maxRawBytes` | 254464 | 254976 | 512 | 47 |

Every other numeric field, checker, inventory, manifest, lock, constraint and test
stays identical to incoming main. No feature/runtime change is authored here.
This prerequisite does not reserve capacity or approve the feature: the parent
must remeasure its actual integrated head and pass CI and independent review.

## Conflict-round repeated measurements

- Pinned main: `826b40e85ab3201f199e4613f7f488a1e5d8b314`.
- Frozen feature: `b5f461665bf6ec1c638d5e2ad812bfcbd5ed2249`.
- Scratch composed tree: `bb0c6425c5294426eec7c8f80e2a552591e33786`.
- Composition uses `git merge-tree --write-tree`; preserve its automatic source
  merge, resolve its sole conflict by restoring main's complete budget. This
  scratch measurement does not modify or approve the parent's branch.
- Node 24.22.1 / npm 11.19.1, locked root/web installations with
  `npm ci --include=dev --no-audit --no-fund`. Root lock SHA-256 remains
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`;
  web lock remains `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both trees use the **same scratch path and installed dependencies**. Manifests,
  locks, Vite config and checker/inventory match byte-for-byte. Remove all
  database-URL, Postgres and DB-binding environment keys. Local artifacts only;
  no database, live probe, staging, migration or deploy.
- Twice per tree: `NODE_ENV=production npm run build --prefix web`, then
  `node ci/check-kit-perf.mjs --format json`. All four builds exit 0.

| Tree / build | Server files | Server raw | Server gzip | Client raw / gzip | Incoming-main budget verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Pristine 1 | 115 | 1176056 | 333152 | 253949 / 102273 | exit 0 |
| Pristine 2 | 115 | 1176054 | 333152 | 253949 / 102273 | exit 0 |
| Composed 1 | 116 | 1178957 | 333972 | 254929 / 102692 | exit 1: server gzip + client raw |
| Composed 2 | 116 | 1178957 | 333973 | 254929 / 102692 | exit 1: server gzip + client raw |

The maximum observed server gzip selects `ceil(333973 / 256) * 256 = 334080`;
client raw selects `ceil(254929 / 512) * 512 = 254976`. Both old boundaries still
fail; main's new allowance does **not** absorb this feature. Differences of up to
three gzip bytes versus the earlier experiment are observed build variation, not
permission to ignore a breach or claim an unmeasured churn bound.

## Conflict-round actual-output controls

Apply each pair to both unmodified composed outputs and run the unchanged checker:

| Server gzip | Client raw | Expected result on both builds |
| ---: | ---: | --- |
| 334080 | 254976 | exit 0, proposal fits |
| 333824 | 254976 | exit 1, server only (one aligned step less) |
| 334080 | 254464 | exit 1, client only (one aligned step less) |
| measured gzip | 254929 | exit 0, exact fit |
| measured gzip minus 1 | 254929 | exit 1, server only |
| measured gzip | 254928 | exit 1, client only |
| 333824 | 254464 | exit 1, restored incoming main fails both |
| 334080 | 254976 | exit 0, restored proposal fits |

**16/16** expected outcomes match exits and failing-group identities (10 expected
failures, 6 expected passes). All other ceilings and emitted artifacts stay fixed.
Composed unaffected groups: Worker 2551 raw / 1219 gzip; client 54/55 files,
gzip 102692/102912; CSS 2/4 files, 2861/3072 raw, 1019/1024 gzip. Server raw
1178957/1203200 and count 116/126 fit. Startup remains 60000ms, **not timed**.

All 54 client paths/sizes/hashes, both CSS files and Worker match within each
repeat pair. Server repeat changes are confined to `chunks/instance.js` and
`chunks/internal.js` (113/115 pristine and 114/116 composed paths identical).
Second-build comparison changes/adds 32 server paths with no removals; the sole
addition is `entries/pages/_layout.server.ts.js` (192 raw / 166 gzip). Largest
server deltas remain events +689/+196, admin-errors +576/+73, hooks +563/+127 and
site-shell +284/+59 raw/gzip. Total feature deltas are +2901–2903 server raw,
+820–821 server gzip, +980 client raw and +419 client gzip. Full manifests preserve
variation rather than hiding an asset or assuming whole-server byte identity.

All archived tracked files match their source tree after scratch controls. The
original acceptance remains SHA-256
`7f90959f02d315a31b348041185bde8885a5547681d7c61e0ae81571e5d6ecb9`.
The actual resolved budget-only branch also builds and passes the canonical
checker: server 115 files, raw 1176052 / gzip 333149; client 253949 / 102273.

## Conflict-round history and scope

Keep incoming main's complete `$comment` unchanged; it contains the old branch
history as an exact prefix. The appendix sweep also finds three previously
undelimited duplicate records already preserved in main: terminal-review allocation,
its a1a078e0a reconciliation, and profile composition-limits. Remove only those
appendix copies. The 20 independently delimited remaining records are verbatim
substrings of the frozen feature, none an exact segment in incoming main. Their
concatenation SHA-256, excluding the document terminal newline, is
`47008e6a9fc2531e52b7b658c85c544dda53d46630622848bd53463494e8a93f`.
The earlier 20-block count grouped the extra records into neighbouring blocks;
the new hash and exact-boundary sweep supersede that claim. Previous measurements
and document history remain below and in Git; main's records are not deleted.

ACT: resolve the verified base conflict, retain the proposed ceilings and update
evidence. WHY: fresh repeat builds and independent lower-boundary controls show
the same minimum aligned pair remains necessary. UNDO: reviewed revert of only
the PR's two scalar changes and notes after remeasurement; no history rewrite.
Parent owns feature integration. No feature/staging/release PASS is claimed.

## Superseded review-correction experiment

The following sections retain the earlier experiment at main `847bf4647`. All
references to current main or unchanged branch history **below this heading** are
historical and superseded by the conflict-round pins, history and measurements above.

### Current decision after review

The original server-only allocation fit its frozen base, but **does not fit the
current-main feature composition**. Review identified real server-gzip and client-raw
breaches, reproduced in two fresh builds. Replace the stale passing claim with the
following minimum aligned allocation:

| Budget field | Current main | Proposal | Increase from main | Minimum measured margin |
| --- | ---: | ---: | ---: | ---: |
| `server.js.maxGzipBytes` | 333568 | 334080 | 512 | 110 |
| `client.js.maxRawBytes` | 254464 | 254976 | 512 | 47 |

The server proposal is one additional 256-byte step above the previous 333824-byte
proposal. Client raw is a newly breached axis on the current composition, not
unrelated headroom. The review-correction request is addressed by measuring and
justifying both affected axes. Every **other** numeric field remains identical to
main: server raw/count, client gzip/count, CSS, Worker, and startup. No blanket 25%
allowance, checker/inventory change, skip, suppression, dependency change, or runtime
optimization is included. Neither affected axis fits at one aligned step less.

This is a budget-only prerequisite for
[Kit request correlation](https://github.com/TogetherWeOwn/two-web-next/pull/1475),
not feature acceptance, reserved capacity, staging evidence, or release approval.
The feature owner must remeasure the actual integrated head and pass exact-head CI
and independent review. No gate is skipped or weakened.

### Current pinned inputs

- Main: `847bf4647def72aebcb84d1defa9ec8726afa207`.
- Frozen feature: `b5f461665bf6ec1c638d5e2ad812bfcbd5ed2249`.
- Scratch composed source tree: `1a7816e9008cd9858a89db6f25ecd6247ff2e557`.
- Compose with `git merge-tree --write-tree`, retain its automatic source merge,
  and replace the sole conflict, `ci/kit-perf-budget.json`, with pinned main's
  complete budget. No application or test conflict is resolved manually.
- Main was **not** merged or rebased into this PR branch. The scratch tree is a
  build experiment, not a validated implementation merge or parent-branch edit.
- Node `24.22.1`, npm `11.19.1`, root/web locked installs using
  `npm ci --include=dev --no-audit --no-fund`.
- Root lock SHA-256: `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`.
- Web lock SHA-256: `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both manifests, both locks, `web/vite.config.ts`, `ci/check-kit-perf.mjs`, and
  `ci/bundle-inventory.mjs` are byte-identical between the current measured trees.

Build both trees sequentially at the same scratch path with the same installed
dependencies, outside synced worktrees. Remove database-URL and Postgres/DB binding
environment keys. No database, live probe, staging, production, migration, or
deployment is part of this experiment.

### Repeated current-base production builds

Run twice per tree:

```sh
NODE_ENV=production npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

All four production builds exit `0`. The unchanged canonical Node checker sums
individual files' `gzipSync` sizes; this is not a concatenated archive or another
compressor. Both pristine builds pass main's complete budget. Both combined builds
fail **only** server gzip and client raw.

| Tree / build | Server files / cap | Server raw / ceiling | Server gzip / main ceiling | Client raw / main ceiling |
| --- | ---: | ---: | ---: | ---: |
| Pristine main 1 | 115 / 126 | 1176056 / 1203200 | 333151 / 333568 | 253949 / 254464 |
| Pristine main 2 | 115 / 126 | 1176054 / 1203200 | 333149 / 333568 | 253949 / 254464 |
| Combined feature 1 | 116 / 126 | 1178957 / 1203200 | 333970 / 333568 | 254929 / 254464 |
| Combined feature 2 | 116 / 126 | 1178959 / 1203200 | 333970 / 333568 | 254929 / 254464 |

The previous proposal, server gzip 333824 with client raw 254464, fails both
combined builds: server gzip exceeds it by 146 bytes; client raw by 465 bytes.
The reviewer independently measured server gzip 333971/333972 and client raw
254929 at the same main/feature pins. These are not substituted for our own
measurements; both observations reject the previous proposal and select the same
new aligned boundaries. The larger reviewer observation would leave 108 bytes of
server-gzip margin. No unmeasured universal churn bound is claimed.

### Actual-output negative controls

On each unchanged combined build, modify only scratch budget fields and rerun the
unchanged canonical checker:

| Server gzip ceiling | Client raw ceiling | Both builds |
| ---: | ---: | --- |
| 333824 (previous proposal) | 254464 | exit 1; both groups fail |
| 334080 (proposed) | 254976 (proposed) | exit 0; every group fits |
| 333824 (one server step less) | 254976 | exit 1; server gzip only |
| 334080 | 254464 (one client step less) | exit 1; client raw only |
| 333970 (exact fit) | 254929 (exact fit) | exit 0 |
| 333969 (one byte less) | 254929 | exit 1; server gzip only |
| 333970 | 254928 (one byte less) | exit 1; client raw only |
| 333568 (restored main) | 254464 | exit 1; both groups fail |
| 334080 (proposal restored) | 254976 | exit 0 |

All **18/18** controls produce their expected exits and failing group identities.
`ceil(333970 / 256) * 256 = 334080`; `ceil(254929 / 512) * 512 = 254976`.
The next-lower aligned values fail independently, so no smaller aligned pair fits.

Both combined builds fit every unaffected group at main's unchanged limits:

| Group | Files / cap | Raw bytes / ceiling | Gzip bytes / ceiling |
| --- | ---: | ---: | ---: |
| Worker entry | one canonical entry | 2551 / 3584 | 1219 / 1536 |
| Client JavaScript | 54 / 55 | 254929 / 254976 proposed | 102692 / 102912 unchanged |
| Client CSS | 2 / 4 | 2861 / 3072 | 1019 / 1024 |

Pristine client JavaScript is 54 files at 253949 raw / 102273 gzip bytes; pristine
CSS is 2 files at 2833 raw / 1006 gzip bytes. The worker is unchanged. Startup
stays `60000ms`; startup latency was not measured.

### Attribution and repeat identity

Versus current pristine main, the combined feature adds 2901–2905 server raw bytes,
819–821 server gzip bytes, one server file, 980 client raw bytes, and 419 client
gzip bytes. Main growth since the original experiment consumed the earlier margin;
this is not main-red, a flaky checker, or permission to rerun until green.

Comparing second builds, 32 server paths change or are added; none are removed.
The sole addition is `entries/pages/_layout.server.ts.js` (192 raw / 166 gzip).
Largest raw deltas, relative to `web/.svelte-kit/output/server`:

| Server path | Raw delta | Gzip delta |
| --- | ---: | ---: |
| `chunks/events.js` | +689 | +196 |
| `chunks/admin-errors.js` | +576 | +73 |
| `entries/hooks.server.js` | +563 | +127 |
| `chunks/site-shell.js` | +284 | +59 |
| `entries/pages/_layout.server.ts.js` | +192 | +166 |

Within each tree, all 54 client JavaScript paths, raw/gzip sizes, and SHA-256 hashes
are identical across repeats; both CSS files and the Worker are identical too.
Server output is **not** byte-identical: only `chunks/instance.js` and
`chunks/internal.js` vary within each pair (113/115 pristine and 114/116 combined
paths are identical). Combined server raw varies by two bytes while its gzip
happens to match in this pair; pristine gzip varies by two bytes. Full manifests
retain these observations. No asset or file-count check is hidden.

### Superseded original-base experiment

The original proposal at `5d1ee004a083e107fed543775fe58db28d898244` measured main
`853f954bdf7b2c851b14185d58157b217e4454d7` and the same frozen feature. Its result
was valid **only for that base**, not the current integration:

| Original tree | Server raw bytes | Server gzip bytes | Client raw / gzip |
| --- | ---: | ---: | ---: |
| Pristine main 1 / 2 | 1174980 / 1174982 | 332939 / 332940 | 253330 / 102135 |
| Frozen combined 1 / 2 | 1177885 / 1177885 | 333758 / 333755 | 254310 / 102553 |

At that base, 333824 server gzip passed, with 66/69 bytes of margin, and one step
less failed. That historical passing result is **not** the current decision.
The original artifact and Git history retain the complete experiment.

### History, scope, and limitations

The PR's existing `$comment` stays byte-for-byte unchanged from its fork point
(SHA-256 `c3a2077bb7197a068f733986453f505c42ff6a53fdb1965cd5937af39eabde25`).
Incoming main's history is retained in the scratch composition; this PR does not
copy it into its branch merely to refresh a measurement. The frozen feature history
also remains at [its pinned source](https://github.com/TogetherWeOwn/two-web-next/blob/b5f461665bf6ec1c638d5e2ad812bfcbd5ed2249/ci/kit-perf-budget.json)
(comment SHA-256 `383e406fe38b1fdf6e8442492fed7103adbefb11386a9a4cac0c846b53fee5b7`).

The [historical appendix](kit-error-correlation-budget-history.md) now retains
**20** branch-only segments. Review found a restored-write record already in
main; an exact-substring sweep also found a discovery past-card record already in
main. Both duplicate copies are removed from the appendix, not from main history.
Every remaining segment is preserved verbatim. Corrected concatenation SHA-256:
`b2067f8585541df4d49835a8824196583b39732421dc30fbcedf84c70e7705da`.

The original feature acceptance file, `test/kit-error-request-correlation.test.ts`,
remains SHA-256 `7f90959f02d315a31b348041185bde8885a5547681d7c61e0ae81571e5d6ecb9`.
No source or test from the feature or newer main ships in this budget-only PR.
Feature behavior, database cases, browser journeys, accessibility, live pages,
startup latency, and full `npm run check` are not established by this experiment.

ACT: replace the stale server-only proposal with the minimum measured server-gzip
and client-raw pair, and deduplicate only the historical appendix. WHY: current
composition reproducibly breaches both old axes, while pristine main fits; both
independent one-step-less controls reject and the pair passes twice. UNDO: revert
these two scalar changes and notes if the composition is abandoned, after measuring
intervening main growth. The parent owns actual reintegration and acceptance.
