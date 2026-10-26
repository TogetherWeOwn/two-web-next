# Correlation server-gzip composition

## Decision and scope

Propose only `server.js.maxGzipBytes`: **334080 → 334848 bytes** (+768).
This is the minimum 256-byte-aligned fit for the remeasured correlation
composition. The next lower step, 334592, rejects the peak by 91 bytes;
334848 leaves 165 bytes. This is not a feature reservation, permission to
skip another gate, or staging/deployment approval.

The separate feature is [#1475](https://github.com/TogetherWeOwn/two-web-next/pull/1475).
Its runtime, original acceptance, and source branch are not changed by this
allocation. The feature owner must integrate the reviewed prerequisite and
run acceptance and required CI on the resulting head.

Keep every other numeric ceiling and the complete inherited `$comment`
unchanged. In particular, do not add a concurrent allowance to this one.
If a newer reviewed main allocation admits the remeasured composition,
retain it and withdraw this obsolete increase. Related concurrent work:
[#1811](https://github.com/TogetherWeOwn/two-web-next/pull/1811) proposes a
smaller server allowance for a different composition;
[#1814](https://github.com/TogetherWeOwn/two-web-next/pull/1814) owns shipping
fixture compatibility for a different proposed server ceiling. Neither open
proposal is an inherited main allocation or approval for this composition.

## Exact inputs

Measured on 2026-10-26 with Node **24.22.1**, npm **11.19.1**, and independently
installed committed root and web locks (`npm ci --include=dev --no-audit --no-fund`
and `npm ci --prefix web --include=dev --no-audit --no-fund`). Both
`npm ls --include=dev --depth=0 --json` inventories exited 0 on both trees.
Installation does not replace the required dependency audit in CI.

| Input | Pin |
| --- | --- |
| Pristine main | `2fa2ef0885c5eb39d795f7412943bcfed7abe4b3` |
| Pristine main tree | `9aa557cb545ba05e6073a62c1a55a2194c8dc52c` |
| Frozen feature head | `80a2a9652d57921f1c7b53c494b23e26c8c361c1` |
| Frozen feature tree | `4ffda07059f4c892f0bed501fa2b0f55734b9bef` |
| Root lock SHA-256 | `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d` |
| Web lock SHA-256 | `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e` |
| 25-path runtime overlay SHA-256 | `6a1124e6ba9f0b1e100923c2653d66394cad17ba4a1271c8aa3d83b1a8dc67cf` |
| Acceptance/support overlay SHA-256 | `a721a942e34ae1f852fa84beb1a739f75f51247ad6bf0365748c4effb7506b42` |
| Original `test/kit-error-request-correlation.test.ts` SHA-256 | `7f90959f02d315a31b348041185bde8885a5547681d7c61e0ae81571e5d6ecb9` |
| Inherited `$comment` SHA-256 (decoded UTF-8) | `da07d2fd7cdb07d116e1c7f70f27c6eab99a10562f6956bd3ca469546f34fff0` |

Main was still this exact ref when the measurements were checked. The feature
was OPEN/MERGEABLE at the frozen head; no feature push, main merge or rebase
was performed. The union is an archive of this main plus the frozen runtime
patch, not a stale feature checkout replacing newer main files. All 25
resulting runtime files match the frozen source's SHA-256 manifest. The
separate support overlay copies its unchanged tests, payload inventory/checker
support and log documentation into the scratch union only. It changes no
runtime bytes. Main's shipping checker/tests, budget, canonical inventory,
constraints, locks and newer budget history remain present in the union.

Each build/test subprocess removes **every environment key containing
`DATABASE_URL`**. No live application, staging/production database, network
probe, migration or deployment is exercised. Builds use
`NODE_ENV=production npm run build --prefix web`, followed immediately by the
unchanged `node ci/check-kit-perf.mjs --format json`. Measurements use the
checker's default Node `gzipSync`, summing each individual file's compressed
size; sourcemaps are excluded. SHA-256/raw/gzip manifests accompany the
internal evidence work product.

## Repeated measurements

Byte columns are raw / gzip. Old-cap exit codes below are actual checker
results, not predicted results.

| Tree / build | Server files | Server bytes | Client JS files / bytes | CSS files / bytes | Worker bytes | Old-cap exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pristine main 1 | 115 | 1178764 / 333873 | 54 / 253949 / 102273 | 2 / 2833 / 1006 | 2551 / 1219 | 0 |
| Pristine main 2 | 115 | 1178762 / 333873 | 54 / 253949 / 102273 | 2 / 2833 / 1006 | 2551 / 1219 | 0 |
| Correlation union 1 | 116 | 1181665 / 334682 | 54 / 254929 / 102692 | 2 / 2861 / 1019 | 2551 / 1219 | 1 |
| Correlation union 2 | 116 | 1181667 / 334683 | 54 / 254929 / 102692 | 2 / 2861 / 1019 | 2551 / 1219 | 1 |

All four builds exit 0. Both union gates fail **only** server gzip, by 602
and 603 bytes. Pristine main has 207 bytes of server-gzip margin. All 54 client
JS paths and hashes are identical across repeated builds within each tree.
The small server output variation does not explain away the persistent
breach, and no flake rerun is used.

The unchanged union margins are small and explicit: client raw **47 bytes**,
client gzip **220 bytes**, CSS raw **211 bytes**, CSS gzip **5 bytes**.
They are not permission to allocate additional client or CSS headroom.

| Ceiling retained | Bytes / count |
| --- | ---: |
| Server raw / files | 1203200 / 126 |
| Client JS raw / gzip / files | 254976 / 102912 / 55 |
| CSS raw / gzip / files | 3072 / 1024 / 4 |
| Worker raw / gzip | 3584 / 1536 |
| Startup readiness timeout | 60000 ms |

## Attribution

The second-build canonical server delta reconciles to **+1 file, +2905 raw
bytes, +810 gzip bytes**. The newly emitted file is the root layout server
entry. The largest costs are expected support-reference propagation, not a
dependency or lock change:

| Server output | Raw delta | Gzip delta |
| --- | ---: | ---: |
| `chunks/events.js` | +689 | +183 |
| `entries/pages/_layout.server.ts.js` | +192 | +166 |
| `entries/hooks.server.js` | +563 | +125 |
| `chunks/admin-errors.js` | +576 | +73 |
| `chunks/site-shell.js` | +284 | +64 |
| `nodes/0.js` | +140 | +47 |
| Event/hotzones/member error-page entries | +113 | +75 |
| Root error-page entry | +37 | +22 |
| Member leaderboard server entry | +107 | +20 |
| Activity-log server entry | +34 | +19 |
| Hotzones list/detail server entries | +122 | +36 |
| Remaining route entries and hash relinking | +48 | -20 |
| **Total** | **+2905** | **+810** |

The detailed 32-row attribution preserves actual path hashes and zero/negative
deltas as well as positive deltas. Existing schedule-availability and
observability work consumed earlier main margin. Removing correlation
behavior is not the budget slice: the independent acceptance is preserved.

## Same-output boundary controls

The unchanged real checker measured the **same saved second-union output**
six times. Only its scratch server-gzip ceiling varied; all other fields
stayed identical, and the original scratch plan was restored byte-for-byte.
No artifact was rebuilt or changed during these controls.

| Scratch server-gzip cap | Expected / actual exit | Server outcome |
| --- | ---: | --- |
| Old 334080 | 1 / 1 | rejects by 603 bytes |
| Next lower step 334592 | 1 / 1 | rejects by 91 bytes |
| Proposed 334848 | 0 / 0 | fits with 165 bytes |
| Measured exact 334683 | 0 / 0 | exact fit |
| Measured minus one 334682 | 1 / 1 | rejects by one byte |
| Restored old 334080 | 1 / 1 | rejects by 603 bytes |

Worker, client JS and CSS groups pass in all six controls. This proves the
allocation's necessity and lower-step refusal on real output, but does not
replace fixed shipping-plan boundary tests.

## Shipping evidence and verification

The current main shipping fixture intentionally expects 334081 to fail under
334080. Under the proposed cap, the **unchanged original suite is 29 passed /
1 failed** (`server gzip one byte over`, actual 0 versus expected 1). That is
a test-ownership correction prerequisite, not an accepted failure, permission
to delete the negative, or evidence of a clean final head. The owned correction
must retain explicit old-plan enforcement and add fixed composition/exact/new
one-over evidence before the allocation PR can be marked ready. It may not
auto-generate fixture lengths from whichever cap happens to be loaded.

Additional observed checks:

- Actual budget-only branch build: exit 0; unchanged canonical checker exit 0,
  server 115 files, 1178764 raw / 333876 gzip. The branch contains no feature.
- Kit gate selftests: **12/12**; bundle-inventory acceptance: **51/51**;
  served-asset budget selftests: **34/34**; served-asset budget: pass.
- `npm run floor-guard -- --base origin/main`, `npm run config:check`,
  `npm run docs:links`, `npm run typecheck`, `npm run lint`: exit 0.
- Strict inventory: **1254/1254** test files and **55/55** Playwright specs
  reachable from CI.
- Scratch union's unchanged correlation suite: **158/158**, eight files;
  request-id binding suite: **22/22**, three files; neither suite skips tests.
- Scratch union payload privacy: **31/31**, 29 server files classified, no
  unmapped files; root typecheck passes; Svelte check: **1252 files, zero
  errors, zero warnings**.

The local full `npm run check`, coverage, browser/visual, a11y, Lighthouse,
startup timing and staging/deployment were not run. The selected checks above
are not a full-suite PASS. Exact-head required CI and independent Paperclip
Review 5/5 remain mandatory; this document is not either verdict.

## ACT / WHY / UNDO

**ACT:** propose one bounded server-gzip allocation, keep all other caps and
inherited history, and obtain an owned fail-closed shipping-test correction.
**WHY:** repeated pristine-versus-union measurements isolate a real 603-byte
server-gzip breach without weakening the feature or hiding a test failure.
**UNDO:** use a reviewed revert of this standalone scalar, correction and
note, after remeasuring intervening main growth. Never rewrite history or
revert unrelated accepted allocations. The feature cannot merge under an
insufficient cap and must reverify after any reintegration.
