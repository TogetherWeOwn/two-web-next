# Ember Hours integration review fixes

Captured on 2026-11-04 from the real local Hono application and built Kit Worker,
using disposable fixtures. All 16 application images and all nine standalone
fallback images linked below were opened. These are viewport screenshots, not
accepted visual-regression baselines. The [initial capture](../README.md) remains
a historical record; its measurements are not the results for these corrections.

## Design contract

- **Audience:** visitors and members browsing home and past events.
- **Screen job / primary action:** preserve Discord join, event browsing, search
  and calendar subscription actions.
- **Real content:** unchanged application markup, the existing Lighthouse news
  fixture, and one disposable past event, “Community co-op night,” on 1 January
  2020. No member data was used.
- **References:** [design-kit v0.2.0](https://github.com/TogetherWeOwn/two-design-kit/tree/v0.2.0),
  its [generated tokens](https://github.com/TogetherWeOwn/two-design-kit/blob/v0.2.0/dist/css/tokens.css),
  and the application at base commit `10099ce45e7f6a4f1ade945bbbca85278982109e`.
- **Layout / typography / tokens:** retain the composition and responsive
  breakpoints. Use the kit UI family and body metrics in both stacks, including
  the measured local Mona Sans fallback. Use semantic focus, on-accent and hover
  roles rather than page colors or brightness filters. Preserve Hono's
  page/surface mapping, Kit's surface/raised mapping and operator overrides.
- **Responsive behavior:** retain the existing action layout and keep two-digit
  archive dates on one line in their existing tile.
- **Required states:** default, keyboard focus, reduced motion and forced colors
  at 1280×800 and 390×844. The catastrophic fallback must remain usable offline,
  without JavaScript, fonts or external stylesheets.
- **Non-goals:** new layouts, components, light mode, route ownership changes,
  authentication changes, logo regeneration or legacy admin restyling. The
  standalone catastrophic fallback deliberately retains its system font.
- **REA angle:** none for implementation; the published kit already specifies the
  required roles. No third-party visual code was copied.

This contract supersedes the initial capture's “retain body type” wording:
review identified that system-UI body text was not consuming the kit UI role.

## Before and current after

The before images use the same base commit and fixture described in the initial
capture. Kit evidence is `/events/past`; `/` still forwards to Hono.

| Application | Viewport | Before | Current after |
| --- | --- | --- | --- |
| Hono `/` | 1280×800 | [Before](../hono-1280-before.png) | [After](hono-1280-default.png) |
| Hono `/` | 390×844 | [Before](../hono-390-before.png) | [After](hono-390-default.png) |
| Kit `/events/past` | 1280×800 | [Before](../kit-1280-before.png) | [After](kit-1280-default.png) |
| Kit `/events/past` | 390×844 | [Before](../kit-390-before.png) | [After](kit-390-default.png) |

Intended differences include the Ember palette, Mona Sans UI/body typography,
kit body metrics and semantic control states. Existing composition and artwork
are unchanged. These screenshots do not authorize a CI baseline update.

## Required application states

| Application / width | Reduced motion | Forced colors | Keyboard focus |
| --- | --- | --- | --- |
| Hono / 1280 | [Image](hono-1280-reduced-motion.png) | [Image](hono-1280-forced-colors.png) | [Image](hono-1280-keyboard-focus.png) |
| Hono / 390 | [Image](hono-390-reduced-motion.png) | [Image](hono-390-forced-colors.png) | [Image](hono-390-keyboard-focus.png) |
| Kit / 1280 | [Image](kit-1280-reduced-motion.png) | [Image](kit-1280-forced-colors.png) | [Image](kit-1280-keyboard-focus.png) |
| Kit / 390 | [Image](kit-390-reduced-motion.png) | [Image](kit-390-forced-colors.png) | [Image](kit-390-keyboard-focus.png) |

Observed in all 16 application states:

- Both routes return HTTP 200; Kit loads its compiled immutable CSS.
- Both bodies compute the Mona Sans stack, 16px size and 24.8px line-height.
- Every selected role resolves; Kit bridges renamed utility namespaces to the
  shared stylesheet's aliases without copying values.
- Both operator-hook families still resolve the six compatibility aliases.
- Normal and reduced motion resolve correctly. Keyboard focus has a 2px outline
  and 3px offset; forced colors retains a visible native outline.
- No horizontal overflow; the mobile two-digit archive date fits its tile.
- Exactly one Mona Sans preload. Mona and its measured fallback load; optional
  Instrument Serif and Fragment Mono remain unused and unloaded in these fixtures.
- Hono Events navigation and Kit's subscription disclosure work.
- Served homepage: **26,470 bytes HTML / 20,435 bytes inline CSS**, below the
  unchanged **26,732 / 20,697** ceilings.
- Raw/gzip stylesheet bytes: `styles.css` **5,483 / 1,881**,
  `theme-tokens.css` **1,468 / 494**, `theme.css` **13,482 / 3,507**.
  Original ceilings hold; no extra stylesheet request was added.

## Standalone catastrophic fallback

These images serve the generated `web/src/error.html` template independently,
with JavaScript disabled and offline/local interception. They are not evidence
of forcing a catastrophic exception in a running Kit Worker. The existing
standalone browser spec passed all 16 tests, including axe WCAG AA checks,
metadata, overflow, hostile-detail exclusion and both keyboard recovery links.

| Mode | Default | Home focus | Events focus |
| --- | --- | --- | --- |
| Desktop | [Image](fallback-desktop.png) | [Image](fallback-desktop-focus-home.png) | [Image](fallback-desktop-focus-events.png) |
| Mobile | [Image](fallback-mobile.png) | [Image](fallback-mobile-focus-home.png) | [Image](fallback-mobile-focus-events.png) |
| Forced colors | [Image](fallback-forced-colors.png) | [Image](fallback-forced-colors-focus-home.png) | [Image](fallback-forced-colors-focus-events.png) |

The fallback palette, focus geometry and exact CSP style hash are generated
together. No `unsafe-inline` was added.

## Verification observed for the correction batch

- `npm run check:ember-sync:selftest`: 23 tests passed; six generated artifacts.
  Coverage includes browser-chrome drift, generated fallback/hash equality,
  shared Kit aliases, UI family/body metrics and semantic control roles.
- `bin/local-ci.sh -- test/home-theme.test.ts test/display-fallback-stacks-acceptance.test.ts test/leaf-css-build-time.test.ts test/page-shells.test.ts test/homepage-mobile-lcp-acceptance.test.ts test/kit-fallback-style.test.ts test/kit-error-fallback.test.ts test/static-theme.test.ts`:
  exit 0, eight files / 145 tests passed with disposable Postgres 17.
- `bin/local-ci.sh -j 8`: exit 0, all gates passed in 322 seconds; 1,229 files /
  25,853 tests passed, with five files / 676 tests skipped by existing gates.
  Coverage: 97.87% statements, 95.54% branches, 97.66% functions, 98.81% lines.
  Non-UTC: 162 tests passed. Tier-0: 115 tests passed.
- `npm run lint`, `npm run typecheck`, `npm run build:assets:check`,
  `npm run check:kit-payloads`, `npm run budget`: exit 0.
- `npm run build --prefix web`: exit 0 after the Kit alias bridge correction.
- `npm run a11y`: exit 0, 154 Hono cases passed.
- `npm run lighthouse`: exit 0, 24/24 mobile reports, all assertions passed.
- `npm run lighthouse:quality`: exit 0, 24/24 desktop reports, all assertions passed.
- Actual-app browser driver: 16 states passed at both required widths; all images
  opened. The first run exposed an invalid Kit focus declaration caused by a
  missing shared alias. The generated bridge fixes it; the refreshed run passes.
- `npx playwright test --config=.local-ci/ember-fallback.config.ts` with
  `NODE_OPTIONS=--import=tsx` and database variables unset: 16/16 standalone
  fallback tests passed. The local configuration selects only the independent
  fallback spec and does not accept visual baselines.
- `npx --no-install vitest run test/kit-no-member-data-contract.test.ts test/kit-public-events-payload.test.ts test/kit-root-layout-load.test.mjs`:
  31/31 tests passed in Node 24 with container networking disabled and no database
  credentials supplied; these suites use local fixtures.

### Aggregate failures and limits

**A green `npm run check` is not claimed for this correction batch.**

- A host run with database variables unset failed: a database-required fixture
  refused to connect, and six migration-workflow authentication tests could not
  fetch their Git baseline. This was not a passing aggregate run.
- A sanitized Node 24 container run migrated a disposable scratch database and
  reached the Kit payload preflight, which reported `suite_run_failed` and zero
  assertions. Configuration inspection found that the custom scratch database
  name did not match the test guard's allowed naming pattern; the nested report
  did not expose the underlying exception. The exact three suites subsequently
  passed offline as recorded above, not as an aggregate rerun.
- A later local fixture-inspection connection used an incorrect database role and
  was refused. Database access stopped without trying another credential.
- The first full disposable gate found the new generated fallback module missing
  from the architecture map. The map was updated; the complete rerun passed.
- Hono accessibility and Lighthouse gates do not exercise Kit. Its real-app
  screenshots and browser assertions are the Kit visual evidence.
- Exact-pushed-head CI, independent design QA and CI visual-artifact review remain
  required. No visual baseline was accepted or regenerated locally. Accept an
  intentional diff only through the CI failure artifact and `ci/visual-accept.mjs`.

No production or staging database, probe, migration, deployment or merge was used.
No performance budget, accessibility threshold or visual mask was loosened.
