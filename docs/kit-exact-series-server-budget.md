# Exact-series server-gzip allocation

## Decision — 2026-10-26

Raise only `server.js.maxGzipBytes` in `ci/kit-perf-budget.json` from
334080 to **335104 bytes** (+1024). The largest fresh observation is
334893 bytes, leaving 211 bytes. This is the smallest fitting 256-byte-aligned
ceiling: 334848 rejects that output by 45 bytes.

This is a separately reviewed budget decision, not feature acceptance or a
reservation of headroom. Do not apply another pending allocation as proof that
this composition fits. Main itself fits; this is not a main-red repair.

## Source and execution pins

- Pristine main: `91b66a68d2d37bd2c717f3a75299300d3617b811`.
- Initial feature: `3cac3dd69163f1b527b7454c55105a6e12d5f746`.
- Initial clean composition tree: `b09a06a3cd4bb5fb07340905c5578b29390a73c6`.
- Updated feature, incorporating its independent test correction:
  `5717f4af9c3315a76b8b3b0ee5bd7a4505a05c92`.
- Updated composition tree: `3c11a33cc3d88e7483453f62d71f225a6d0b08e1`;
  this feature already contains the pinned main. Its advance changes tests and
  documentation only. No feature or acceptance-test bytes were edited here.
- Node 24.22.1, npm 11.19.1. Each workspace received independent root and
  `web/` exact-lock `npm ci --include=dev` installs.
- Production build command: `NODE_ENV=production npm run build --prefix web`.
  All four builds below exited 0. No server, database or live service was used.
- Measurements use the unchanged canonical
  `node ci/check-kit-perf.mjs --format json`, with `--root` selecting the
  isolated composition workspace when applicable. Gzip is the checker's actual
  per-file Node `gzipSync`, not archive compression or arithmetic inference.

## Fresh measurements

Raw and gzip columns are bytes. Every row retains the same enforced inventory.

| Tree/build | Server files | Server raw | Server gzip | Client files | Client raw | Client gzip | Checker with old cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Pristine main | 115 | 1178762 | 333872 | 54 | 253949 | 102273 | Exit 0, all groups pass |
| Initial composition, build 1 | 115 | 1183028 | 334892 | 54 | 254966 | 102602 | Exit 1, server gzip only |
| Initial composition, build 2 | 115 | 1183028 | 334891 | 54 | 254966 | 102602 | Exit 1, server gzip only |
| Updated composition, build 3 | 115 | 1183028 | 334893 | 54 | 254966 | 102602 | Exit 1, server gzip only |

Worker is 2551 raw / 1219 gzip bytes. Client CSS is 2 files, 2833 raw /
1006 gzip bytes. These fit on every build. Startup's 60000 ms configuration
is unchanged; startup timing was not measured.

Updated composition versus pristine main adds 4266 raw / 1021 gzip server bytes
and no server files. Per-file attribution is dominated by `chunks/admin.js`:
+4233 raw / +1004 gzip; the admin-events server entry adds 31 raw / 13 gzip.
Small generated-name differences explain residual build variation. The feature
contains the exact-series resolver, serializable view and SSR integration;
this budget PR changes none of them or their parity-pinned copy.

Every unrelated limit remains unchanged:

| Group | Raw ceiling | Gzip ceiling | File ceiling |
| --- | ---: | ---: | ---: |
| Worker | 3584 | 1536 | Canonical single entry |
| Server JS | 1203200 | **335104** | 126 |
| Client JS | 254976 | 102912 | 55 |
| Client CSS | 3072 | 1024 | 4 |

## Same-output boundary evidence

Each row was executed through the real checker on the saved output, without a
rebuild between controls. Three independent control sets passed **18/18**
expectations. SHA-256 manifests before and after each set prove that no measured
artifact changed; each scratch budget was restored byte-for-byte afterward.

| Control | Build 1 | Build 2 | Build 3 |
| --- | --- | --- | --- |
| Old 334080 | Exit 1; server only | Exit 1; server only | Exit 1; server only |
| One aligned step below, 334848 | Exit 1; over by 44 | Exit 1; over by 43 | Exit 1; over by 45 |
| Proposed 335104 | Exit 0; all four groups pass | Exit 0; all four groups pass | Exit 0; all four groups pass |
| Exact measured gzip | 334892: exit 0 | 334891: exit 0 | 334893: exit 0 |
| One byte below measured gzip | 334891: exit 1 | 334890: exit 1 | 334892: exit 1 |
| Restore old 334080 | Exit 1 | Exit 1 | Exit 1 |

## Shipping gate: merged dual-allocation support

The shipping suite uses fixed literals selected by an explicit allocation
mapping; fixtures are never derived from the loaded cap. The base for this PR
(`4d9ebeee5b311dd5bedb606a57ea91183625c3c7`) merged the dual-allocation
support from
[PR #1814](https://github.com/TogetherWeOwn/two-web-next/pull/1814), and this
PR carries no test changes: `ci/check-kit-perf.test.mjs` is byte-identical to
that base (`git diff` of the file against the base is empty). Its SHA-256 at
this head is
`9baec3e7a51a99ba04293970590376c04a3168b482a6d7226a5e5d2a6631a981`.

The mapping at `ci/check-kit-perf.test.mjs:325-326` approves exactly two
server-gzip allocations:

| Loaded cap | Interval witness | Exact ceiling | One byte over |
| ---: | ---: | ---: | ---: |
| 334080 (legacy) | 333639 | 334080 | 334081 |
| 335104 (this decision) | 334994 | 335104 | 335105 |

The `shipping budget: server gzip allocation is explicitly approved` control
rejects any other loaded ceiling, and the three server-gzip cases then fail
with it, so an arbitrary widening or narrowing cannot go green. The 335104
interval witness 334994 is the combined-worst case (margin 110 under the
ceiling); the lower aligned step 334848 is unapproved by design.

An earlier revision of this PR paired the scalar with the independently
authored literal-only correction from commit
`d8bc0a9a06ea59c8d58787d90f96488d60300dee`
([#1797](https://github.com/TogetherWeOwn/two-web-next/pull/1797), SHA-256
starting `ed7d91f5`). That file was superseded when the base merged #1814:
the merge adopted main's dual-allocation file verbatim, and no literal-only
bytes remain in this PR. The composition measurements in this record are
unaffected; #1814 changed tests only.

Fresh isolated executions of the merged gate file on this tree (scratch
budgets restored byte-for-byte afterward; the full file is 31 tests, of which
18 are the shipping subset: the allocation control plus 17 boundary cases):

| Budget | Result |
| --- | --- |
| Approved legacy 334080 | 31/31 pass (shipping 18/18) |
| Proposed 335104 | 31/31 pass (shipping 18/18) |
| Unapproved 335105 | 27/31; exactly the allocation control plus the 3 server-gzip cases fail |
| Unapproved lower step 334848 | 27/31; exactly the allocation control plus the 3 server-gzip cases fail |
| Unapproved next step 335360 | 27/31; exactly the allocation control plus the 3 server-gzip cases fail |
[PR #1811](https://github.com/TogetherWeOwn/two-web-next/pull/1811)'s 334592
proposal cannot admit the measured exact-series tree. Other feature allocations
such as [#1796](https://github.com/TogetherWeOwn/two-web-next/pull/1796) and
[#1684](https://github.com/TogetherWeOwn/two-web-next/pull/1684) are not proof of
fit for this tree; no existing merged cap covers it at the source pin above.

## Verification and limits

Fresh local evidence after pairing the scalar with the merged dual-allocation gate:

- Checker `--selftest`: 12/12 pass.
- `node --test ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs ci/floor-guard.test.mjs`:
  141/141 pass, no skips.
- Collected Kit parity-gates/origin/checker/perf/inventory/visual-accept/CI-wiring/
  section-normalization suites: 161/161 pass, no skips. These are fixture tests,
  not browser journeys.
- `npm run lint`, `npm run typecheck`, `npm run docs:links`, and
  `node ci/floor-guard.mjs --base origin/main`: exit 0.
- Full `npm run check`, coverage, browser journeys, UI gates, startup readiness,
  feature acceptance, staging and deployment are not claimed by this budget
  evidence. Required exact-head CI and independent Paperclip Review 5/5 remain
  mandatory before automatic squash merge.

The full inherited `$comment` remains an exact prefix (SHA-256
`da07d2fd7cdb07d116e1c7f70f27c6eab99a10562f6956bd3ca469546f34fff0`);
this decision appends one dated record. No checker, inventory, product source,
workflow, dependency, lockfile, constraint, route flag or other ceiling changes.

## Rollback

Use a reviewed revert of the single scalar and this decision's appended
record/evidence note together. The shipping gate tests live on main (merged
#1814) and are untouched by this PR, so no test revert is paired with this
change. Preserve incoming history and all unrelated enforcement. Remeasure
first if intervening features have consumed the allowance; reverting only the
scalar can intentionally make those later compositions red. No deploy or live mutation is part of this work.
The feature owner must remeasure the actual integrated head after the prerequisite
lands; this evidence is not permission to bypass their separate acceptance gate.
