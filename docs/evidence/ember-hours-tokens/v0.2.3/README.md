# Ember Hours v0.2.3 integration evidence

**Historical capture, not combined-head acceptance.** On 2026-11-06, the migration
incorporated the exact four-file allocation from merged [PR #2042](https://github.com/TogetherWeOwn/two-web-next/pull/2042),
squash `c141e701a4a15a47c78ab1b913bda2081d817785`, in integration commit
`d2858449`. The approved Kit server-only ceilings are now **1,222,656 raw /
342,272 gzip bytes**, with the **126-file cap unchanged**. All client, Worker,
startup, stylesheet and homepage ceilings remain unchanged. This supersedes the
extraction prerequisite described in the historical failure section below;
extraction is an independent follow-up, not part of this migration.

The measurements and opened images below remain evidence of the retained
`47a0fd8b` candidate, not a passing build or fresh visual review of the combined
head. Fresh GitHub Actions suite, browser, accessibility, Lighthouse, budget and
visual-artifact results are required. No local full-suite or CI-mirror rerun is
authorized. Independent technical/design QA and exact-head production confirmation
remain separate gates.

The existing Actions browser job now runs
`e2e/kit-parity/ember-token-evidence.spec.ts` against both actual applications
before mutating journeys. It captures the 16 viewport/state combinations below
and uploads PNGs plus SHA/metric receipts as
`ember-ui-evidence-<run-id>-<attempt>` before later Playwright steps clean the
output directory. This capture is not a baseline update or UX approval. Its first
combined-head execution is recorded below; the local images and measurements in
later sections remain historical.

## Combined-head Actions evidence and baseline acceptance

[Browser run 42289276465, attempt 1](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42289276465)
ran at `78830b034c6a0679eec7f19cde161b685938ee59`. All 16 viewport PNGs in
[artifact 13538448331](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42289276465/artifacts/13538448331)
were opened individually. Their SHA/metric receipts report Mona Sans, 16px body
text, 24.8px line height, no horizontal overflow, zero reduced-motion duration
and the focused skip link's 2px ring with 3px offset.

That browser run finished **failure**, as did
[CI run 42289269852](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42289269852).
Hono a11y and Lighthouse jobs passed. Lint stopped the main and Node 22 checks
before types/tests; the asset selftest failed on a missing scratch-fixture file.
Critical journeys had six failures: four stale rule-target color pins, one stale
fallback-shell color pin and the font-swap negative control. The real Mona swap
passed, but the old 100% bad-metric mutation no longer crossed the unchanged CLS
or line-count limit. The repair uses a deliberately large 50% mismatch; it does
not loosen either limit. These repairs await fresh Actions verification.

The failure artifact
[e2e-failure-42289276465-1](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42289276465/artifacts/13539617300)
contains 48 expected/actual/diff triples. All triples were opened as labeled
comparison sheets for implementation inspection. Both acceptance scripts first
passed a read-only dry run, then copied only those CI actuals into 18 Hono and
30 Kit-suite baselines:

- Hono, desktop and mobile: `about`, `event`, `event-cancelled`, `event-paused`,
  `events`, `home`, `past`, `privacy` and `rules` (18).
- Kit archive `populated` and `out-of-range`, each desktop/mobile (4);
  Kit events index, desktop/mobile (2).
- Kit member board `activity`, `default`, `relative` and `season`, each
  desktop/mobile (8).
- Member-board viewer: every Hono/Kit × overall/relative × desktop/mobile ×
  normal/forced-colors combination (16).

Commands: `node ci/visual-accept.mjs --dry-run --format json <artifact-root>`
and `node ci/kit-visual-accept.mjs --dry-run --format json <artifact-root>`,
followed by each command without its preview flags. Actual acceptance reported
18 and 30 baselines respectively, with no collision. No local snapshot
regeneration, pixel threshold, masking, viewport, fixture or application CSS was
changed in this repair round.

The intended changes are the generated Ember palette, semantic control colors
and body/display typography. Resulting text wrapping, document heights and
scrolled table-row density change with the new metrics. Forced-colors tables
keep their system-color treatment and viewer outlines. This records artifact
provenance and implementation inspection, **not independent UX design QA**.
Fresh exact-head Actions, all required browser states, independent technical and
UX review, and separate production-merge confirmation remain required.

Captured on 2026-11-04 from the actual local Hono application and compiled Kit
Worker using disposable fixtures. All 16 images below were opened individually.
These are viewport screenshots, not accepted CI visual-regression baselines.
The [initial capture](../README.md) and [earlier integration fixes](../review-fixes/README.md)
remain historical records, not verification of the current adapter.

## Design contract

- **Audience:** visitors and members browsing home and past events.
- **Screen job / primary action:** preserve Discord join, event browsing, search
  and calendar subscription actions.
- **Real content:** unchanged app markup, the existing Lighthouse news fixture,
  and one disposable “Community co-op night” event on 1 January 2020. No member
  data was used.
- **References:** [design-kit v0.2.3](https://github.com/TogetherWeOwn/two-design-kit/tree/v0.2.3),
  its [generated CSS](https://github.com/TogetherWeOwn/two-design-kit/blob/v0.2.3/dist/css/tokens.css),
  and the existing application at base commit
  `10099ce45e7f6a4f1ade945bbbca85278982109e`.
- **Layout / typography / tokens:** retain existing compositions and responsive
  breakpoints. Consume the new distinct `font-ui` role for UI/body text; retain
  `font-display` for display rules and the measured local Mona fallback. Use
  generated semantic control roles. Keep Hono page/surface, Kit surface/raised,
  and both operator-override families.
- **Responsive behavior:** preserve existing action layout and keep two-digit
  archive dates on one line inside the existing date tile.
- **Required states:** default, keyboard focus, reduced motion and forced colors
  at 1280×800 and 390×844.
- **Non-goals:** new layouts, components, light mode, route ownership changes,
  authentication changes, logo regeneration or legacy admin restyling. The
  catastrophic fallback retains system fonts and no external dependencies.

## Before and after

Before images retain the same base commit and fixtures described in the initial
capture. Kit evidence uses `/events/past`; `/` still forwards to Hono.

| Application | Viewport | Before | Current after |
| --- | --- | --- | --- |
| Hono `/` | 1280×800 | [Before](../hono-1280-before.png) | [After](hono-1280-default.png) |
| Hono `/` | 390×844 | [Before](../hono-390-before.png) | [After](hono-390-default.png) |
| Kit `/events/past` | 1280×800 | [Before](../kit-1280-before.png) | [After](kit-1280-default.png) |
| Kit `/events/past` | 390×844 | [Before](../kit-390-before.png) | [After](kit-390-default.png) |

The intended shifts are the Ember palette and Mona Sans UI/body and display
roles. The opened images retain the existing composition, visible actions and
artwork. Mobile text wraps without document overflow; the archive date fits its
tile. Forced colors retains readable text, link distinctions and control edges.
The first-Tab skip link is visible at both widths. No new visual direction was
introduced and no baseline acceptance is implied.

## Required states

| Application / width | Reduced motion | Forced colors | Keyboard focus |
| --- | --- | --- | --- |
| Hono / 1280 | [Image](hono-1280-reduced-motion.png) | [Image](hono-1280-forced-colors.png) | [Image](hono-1280-keyboard-focus.png) |
| Hono / 390 | [Image](hono-390-reduced-motion.png) | [Image](hono-390-forced-colors.png) | [Image](hono-390-keyboard-focus.png) |
| Kit / 1280 | [Image](kit-1280-reduced-motion.png) | [Image](kit-1280-forced-colors.png) | [Image](kit-1280-keyboard-focus.png) |
| Kit / 390 | [Image](kit-390-reduced-motion.png) | [Image](kit-390-forced-colors.png) | [Image](kit-390-keyboard-focus.png) |

## Browser assertions observed

- HTTP 200 for both routes, with real compiled immutable Kit CSS loaded.
- Every selected raw author token role resolves in both stacks. Unused Tailwind
  utility definitions are intentionally pruned; their absence is not a missing
  raw alias. Type, spacing, family and motion aliases reuse the shared served
  sheets rather than forcing a duplicate utility bridge into the client CSS.
- Both bodies compute Mona Sans, 16px size and 24.8px line-height.
- Both `--theme-*` and `--theme-schedule-*` families resolve all six compatibility
  aliases. Kit retains paper on surface and surface on raised.
- Normal fast motion is positive; reduced fast motion is zero.
- Keyboard focus has a 2px outline and 3px offset.
- Exactly one Mona Sans preload. The serif and mono faces use optional display,
  are not preloaded and remain unloaded in these fixtures.
- No document overflow at either width; the archive date stays on one line and
  its glyph right edge remains inside its tile.
- Hono Events navigation and Kit calendar subscription disclosure work.
- Served homepage: **26,369 bytes HTML / 20,334 bytes inline CSS**, below the
  unchanged **26,732 / 20,697** ceilings.

## Verification observed

- Focused fixture command with `KIT_ERROR_SHELL_BROWSER_TESTS=true`:
  `npx vitest run test/kit-tailwind-sources.test.ts test/kit-error-shell-render.test.ts test/home-theme.test.ts test/page-shells.test.ts test/content-leaf-no-webfont.test.ts test/display-fallback-stacks-acceptance.test.ts`:
  six files / 223 tests passed. Database variables were unset. This explicitly
  exercised the gated rendered Kit error-shell browser/a11y checks.
- `npm run lint`, `npm run typecheck`, `npm run e2e:typecheck`, and
  `npm run check --prefix web`: exit 0. Kit reported zero errors and warnings.
- Actual-app driver: all 16 states passed; all images opened. It interacted with
  Hono navigation and Kit's calendar disclosure, not just server readiness.
- `node --test ci/check-ember-token-sync.test.mjs`: 24 tests passed, including
  divergent upstream UI/display stacks and shared raw-alias availability.
- `npm run check:design-kit-drift`, `npm run build:assets:check`, and
  `npm run budget`: exit 0. Exact v0.2.3 upstream bytes verified. Hono raw/gzip
  bytes: `styles.css` **6,066 / 2,048**, `theme-tokens.css` **1,468 / 494**,
  `theme.css` **12,798 / 3,335**, `schedule-theme.css` **6,128 / 1,658**.
- `bin/local-ci.sh -j 8`: exit 0 in 323 seconds against disposable Postgres 17;
  1,229 files / 25,856 tests passed, with five files / 676 tests skipped by
  existing gates. Coverage: 97.87% statements, 95.54% branches, 97.66% functions,
  98.81% lines. Non-UTC hotzone: 162 passed. Tier-0: 115 passed.
- `npm run a11y`: exit 0, 154 passing Hono fixture cases.
- `npm run lighthouse`: exit 0, 24/24 mobile Hono reports; all assertions passed.
- `npm run lighthouse:quality`: exit 0, 24/24 desktop Hono reports; all assertions
  passed. These Hono gates did not exercise the Kit route.
- `npm run docs:links`: exit 0.

## Remaining gate failure and limits

The latest real Kit build succeeds, but `node ci/check-kit-perf.mjs` fails its
unchanged server JavaScript ceilings:

| Inventory | Raw bytes | Gzip bytes | Original ceilings, raw / gzip |
| --- | --- | --- | --- |
| Kit client CSS | 3,068 | 1,189 | 3,072 / 1,280 |
| Kit client JavaScript | 261,348 | 104,378 | 261,632 / 104,448 |
| Kit server JavaScript | 1,222,249 | 341,995 | 1,220,608 / 341,248 |

The restored build's server deficit is **1,641 raw / 747 gzip bytes**. No budget was increased,
required role removed or inventory hidden. The embedded critical CSS occurs
once; moving tokens among the three source sheets does not remove its total
server bytes. Broader extraction or SSR chunking changes need a bounded,
verified approach, not speculative minification or a threshold waiver.

### Bounded SSR experiment (reverted)

Measured exactly one SSR-only union of the existing `content` and `site-shell`
groups, without changing the client configuration or conservative minification.
The real build succeeded. The candidate measured **1,222,143 raw / 341,821 gzip
bytes across 115 server files**: savings of only **106 raw / 173 gzip bytes**,
so both original byte ceilings still failed. Worker and client totals stayed
unchanged. The emitted graph had no missing relative targets or detected cycles
across static imports, re-exports and literal dynamic imports. The remaining
indirect dynamic import is Svelte's existing `node:crypto` fallback; this is not
an unrestricted claim about arbitrary runtime import expressions.

Reverted the experiment and rebuilt: **116 files / 1,222,249 raw / 341,995 gzip
bytes**. The recorded source/lock/generated-CSS hashes match the pre-experiment
baseline; emitted `instance.js` and `internal.js` hashes changed, with one extra
gzip byte in `instance.js` (baseline total 341,994). Raw totals are unchanged.
No experimental grouping is retained. Further grouping/minifier experiments are out of scope; a separately
reviewed build-time critical-CSS extraction prerequisite must establish a new
exact-byte contract with generated CSS/CSP coherence and visual equivalence.
No extraction is implemented or authorized by these measurements.

No green aggregate `npm run check` is claimed here. Its pre-experiment disposable
run was stopped before completion when the bounded experiment was authorized;
its owned labeled containers and network were cleaned. A fresh aggregate remains
required on the final candidate. Hono gates do not exercise the Kit route; its screenshots and
explicit rendered browser checks are separate evidence. The delayed-font smoke
spec and intentional visual diffs still require the supported CI runner; the
normal browser-smoke configuration refuses execution on the controller.

Exact-head CI, independent design QA and production-merge confirmation remain
required. No visual baseline was accepted locally. Accept an intentional diff
only through the reviewed CI failure artifact: use `ci/visual-accept.mjs` for Hono
and `ci/kit-visual-accept.mjs` for Kit. No production
or staging database, probe, migration, deployment or merge was used.
