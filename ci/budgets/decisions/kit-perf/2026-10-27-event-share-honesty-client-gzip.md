# 2026-10-27 decision: client JS gzip ceiling 103168 -> 103424 for event share honesty

`client.js.maxGzipBytes` rises 103168 -> 103424 in
`ci/budgets/kit/client-js.json`; no other ceiling changes. This admits the
event-share-honesty change (PR #1865: share actions stay honest without
JavaScript and on draft previews), whose event-detail client growth pushes
the Kit client bundle past the current ceiling once merged with current
main. One 256B step, the smallest aligned cover for the measured worst
case: 103168 rejects it by 26B.

The union also breaches the server gzip ceiling (336552 worst vs 336384,
168 over), but the server step ships separately: one fragment per budget
PR, and the 336640 literal the union would need is not an admitted
allocation on main. The parent feature stays red on `kit-perf` until that
server raise lands too. See Measurements for the attribution.

## Measurements

Locked Node 24.22.1 / npm 11.19.1 production builds
(`npm run build --prefix web`), measured through
`node ci/check-kit-perf.mjs`, two builds per tree. Worst case governs.

- Pristine main: `4e90a8bcfd70a46564f6bb363e1543304ec271c0`
- Feature head: `0b50ae40de95b11caf1557e8685bef8e72e0cd25`
  (event share honesty; still open and unchanged)
- Composition: scratch merge `72b709e1091c17cc51f02e7d52b0c2780775f54d`
  (clean merge, no conflicts; the merge touches only the copy-link
  islands, `event-theme.css`, `src/events/pages-detail.tsx`,
  `web/src/lib/EventDetail.svelte` and five share-honesty test files —
  zero budget, checker or workflow files)

Pristine main (ceilings: server gzip 336384, client gzip 103168):

| Build | Server files | Server raw/gzip | Client files | Client raw/gzip | Gate |
|---|---:|---:|---:|---:|---|
| 1 | 116 | 1190242 / 336247 | 54 | 256371 / 102994 | exit 0 |
| 2 | 116 | 1190242 / 336249 | 54 | 256371 / 102994 | exit 0 |

Composition (same ceilings):

| Build | Server raw/gzip | Client files | Client raw/gzip | Gate |
|---|---:|---:|---:|---|
| 1 | 1191376 / 336552 | 54 | 256958 / 103194 | exit 1, server 168 over, client 26 over |
| 2 | 1191376 / 336550 | 54 | 256958 / 103194 | exit 1, server 166 over, client 26 over |

(Composition raw/file counts re-read from the build-2 output with
scratch-only raised ceilings; the checker prints no `ok` detail for
breaching groups.)

With the fragment set to 103424 the composed client total exits 0 on its
axis (margin 230B). One step below (103168) rejects by 26B, so 103424 is
the smallest 256B-aligned ceiling that admits the measured worst case.
Client bytes are deterministic (byte-identical across rebuilds within
each tree); server gzip wobbled 2B across identical-tree rebuilds
(336247/336249 pristine, 336552/336550 composed) — disclosed jitter, not
signal. Worker (2551/1219B) and client CSS (2 files, 2861/1019B) are
byte-identical in all four builds.

Feature delta (union worst minus pristine worst): server +1134 raw /
+303 gzip bytes at 116 files; client +587 raw / +200 gzip bytes at 54
files. Client raw (256958/257024B) and the 55-file ceiling fit unchanged.

Main-advance attribution: the feature branch's merge-base with main is
`d4d7a9da5`, exactly one commit behind the measured tip (`#1866`,
server-side job-ledger bounds). The earlier card-era union figure was
server 336347 / client 103194; client is byte-identical now, so the
+205B server-only growth came from that single main-side commit. The
card-era "server fits" premise is stale for that reason — not because
the feature grew.

## Why the growth is justified

The client bytes are the honest-share behavior itself: the event-detail
Kit twin renders share controls that stay truthful with scripting
disabled and on draft previews, instead of controls that imply an action
the page cannot perform. The cost is markup and label fragments in the
existing route chunk — no new route, island, query or dependency. The
only cheaper alternative is to drop the behaviour the change exists to
deliver.

## Shipping tests

No checker, source, workflow, mask or exclusion changes ship here.
`ci/check-kit-perf.test.mjs` already carries 103424 in its
`SHIPPING_CLIENT_GZIP_ALLOCATIONS` (interval 103302, exact 103424, one
byte over 103425), so that suite passes unchanged with the new fragment:
the measured 103194 sits inside the newly allowed interval. The
aggregate `SHIPPING_KIT_BUDGET` in `ci/budget-fragments.test.mjs`
mirrors the shipped fragments, so its `client.js.maxGzipBytes` literal
moves 103168 -> 103424 in this same PR (one line; with that line
reverted the suite fails 1 of 33). The budget suites (`check-kit-perf`,
`budget-fragments`, `bundle-inventory-acceptance`) run against the new
fragment: 124 tests, 124 pass, 0 fail on Node 24.22.1.

Sibling work: PR #1947 (open draft) proposes the identical 103168 ->
103424 step for moderator navigation, measured on older main; whichever
PR lands second re-measures on the new main. The union's server breach
needs its own raise PR; separate in-flight server-ceiling work may
cover it. Startup, runtime, staging and release acceptance are not
claimed; exact-head CI and independent review remain mandatory. Undo:
revert this fragment step, the oracle pin and this record.
