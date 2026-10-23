# Soft-answer prerequisite: recover server headroom without an allowance

## Decision and scope

Co-compress `web/src/lib/ProfileView.svelte` with its Hono markup twin in the
existing SSR `profiles` group. This extracts the narrow grouping already proposed
in [#1652](https://github.com/TogetherWeOwn/two-web-next/pull/1652) at
`1a4db7eb62cc914aa115c9f1216fbf29eeb8db19` and reused in
[#1713](https://github.com/TogetherWeOwn/two-web-next/pull/1713) at
`217d9a2e90b031f8af08b8da1ba67d8352553bf7`. Neither was merged at measurement
time. Credit those implementations; this is their independently measured,
main-based extraction, not an additional or additive reduction.

No allowance is requested. `ci/kit-perf-budget.json`, its entire decision history,
all enumeration/checker code, minification settings and all other thresholds are
byte-identical to main. No application source, acceptance test, lockfile or
feature ref changes. The same view remains reachable from both profile page
entries; its separate server file disappears because the code moves into the
existing group, not because any output is excluded from measurement.

This prerequisite supports [#1463](https://github.com/TogetherWeOwn/two-web-next/pull/1463),
not the unrelated RSVP allowance proposed in
[#1712](https://github.com/TogetherWeOwn/two-web-next/pull/1712). That allowance
was still under review and does not authorize this union. After this squash
merges, consume the reduction normally and remeasure the actual integrated head.
If another PR lands the same grouping first, reuse that landed change rather
than claiming or applying the saving twice.

## Reproducible paired builds

Measured 2026-10-23, Node **24.22.1**, npm **11.19.1**. Install the identical
committed root and web locks with `npm ci --include=dev` in separate run-owned
dependency directories. Link dependencies to isolated `git archive` snapshots,
then run `npm run build --prefix web` twice for each tree. The standalone change
is built in its isolated execution worktree. Each measurement recursively counts
every server `.js`, every client JS/CSS, and the adapter Worker using the checker's
default `node:zlib.gzipSync` per-file totals, not Vite's estimates or Python gzip.
Inventories include paths, raw/gzip sizes and SHA-256 for every counted file.

Pins:

- Main: `46332992eb1b40ae729b47dbb092ec03c5af4c49`.
- Frozen soft-answer feature: `3de25ee786986327912d92aee4e214d7ab9227cb`.
- Reduced feature: that frozen tree plus only the same Vite grouping change.
- Standalone: pinned main plus the grouping change (this document has no build input).

| Tree | Server files | Raw bytes, build 1 / 2 | Gzip bytes, build 1 / 2 | Original gate |
| --- | ---: | ---: | ---: | --- |
| Main | 118 | 1128057 / 1128057 | 329273 / 329272 | pass / pass |
| Frozen feature | 118 | 1130127 / 1130125 | 329609 / 329608 | fail / fail |
| Frozen feature + grouping | 117 | 1128571 / 1128573 | 328275 / 328275 | pass / pass |
| Standalone main + grouping | 117 | 1126501 / 1126503 | 327937 / 327936 | pass / pass |

Unchanged server ceilings: **126 files, 1203200 raw B, 329472 gzip B**. The reduced
feature has **1197 gzip B** headroom in both builds. Few-byte differences across
identical builds are emitted chunk/import churn, not optimization claims.

The frozen feature's attributable growth is concentrated in `chunks/events.js`
(**+1730 raw / +248 gzip B**) and `chunks/site-shell.js` (**+340 / +90 B**).
Other same-size chunks vary by a few gzip bytes as imports/content change.

All before/after client paths and SHA-256 hashes are identical for each tree:

| Asset group | Main / standalone raw, gzip B | Feature / reduced feature raw, gzip B |
| --- | ---: | ---: |
| Client JS, 53 files | 245301, 99265 | 245966, 99425 |
| Client CSS, 2 files | 2737, 983 | 2737, 983 |
| Worker, 1 file | 2551, 1219 | 2551, 1219 |

Two alternative placement trials on the frozen feature were rejected and do not
ship: adding `SiteMetadata.svelte` to the shell rule measured **329607 gzip B**;
adding `Shell.svelte` measured **329610 B**. Both were already recursively owned
by the shell group, so neither moved modules or recovered meaningful headroom.
The profile grouping recovers **1333–1334 gzip B** on the frozen feature without
changing client chunking or source behavior.

## Verification and limits

- All **24** feature implementation/evidence/acceptance blobs are byte-identical
  to the frozen parent after the scratch reduction. The parent ref is untouched.
- **52/52 real-artifact boundary checks**: original budgets accept main, reduced
  feature and standalone but reject the frozen feature; exact measured limits
  pass, and one-byte-under raw/gzip or one-file-under limits refuse for server,
  client JS/CSS and Worker. These are scratch probes, not new acceptance files.
- **6/6 emitted profile comparisons**: before/after head and body are byte-identical
  for viewer, owner/moderator and new-owner fixtures, on both main and the frozen
  feature. The harness bundles the actual generated page entries and their own
  generated Svelte renderer, fixes `Date.now`, and asserts escaped hostile text,
  current profile stylesheets and share metadata remain. This is not browser QA.
- Unchanged standalone suites: `vitest run test/kit-profile-output.test.ts
  test/kit-profile-stylesheet-acceptance.test.ts test/kit-profile-deps.test.ts
  test/kit-profile-form.test.ts test/kit-event-detail.test.ts
  test/kit-event-detail-rsvp-companion-acceptance.test.ts
  test/rich-unfurl-brand-image-acceptance.test.ts`: **149 passed, 7 files**.
- Unchanged frozen-feature suites: `vitest run
  test/rsvp-soft-answer-event-page-acceptance.test.ts
  test/rsvp-soft-409-full-notice.test.ts test/islands-rsvp-button.test.ts
  test/kit-profile-output.test.ts test/kit-profile-stylesheet-acceptance.test.ts
  test/hono-no-member-data-contract.test.ts`: **183 passed, 6 files**.
  Both focused runs use local fixtures with database variables unset; no DB
  coverage is claimed.
- `node --test ci/check-kit-perf.test.mjs`: **13 passed, 0 skipped**.
  `npm run kit-perf:selftest`: **6 passed**.
- `npm run lint`, `npm run typecheck`, `npm run build:assets:check`,
  `npm run floor-guard -- --base origin/main` and `git diff --check`: pass.
- The ordinary `npm run check --prefix web` initially reports **129 errors**
  because external `node_modules/$app/tsconfig.json` resolves generated relative
  `rootDirs` against the dependency directory. Correcting only that run-owned
  generated file to the absolute web workspace and `.svelte-kit/types`, then
  running `web/node_modules/.bin/svelte-check --workspace web --tsconfig
  "$PWD/web/tsconfig.json" --fail-on-warnings`, gives **0 errors / 0 warnings**.
  No tracked TypeScript configuration or strictness changes.
- Full `npm run check`, database, browser, staging, accessibility, Lighthouse and
  visual suites were not run locally. No UI source changes or visual/DB success
  claims. Exact-head required CI and independent Paperclip Review remain gates.

Undo: revert the standalone prerequisite squash. No production tests, deploys,
network/host changes, migrations, secrets or spend are part of this work.
