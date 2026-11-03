# Ember Hours token and font migration evidence

Captured on 2026-11-03 from the real local applications with disposable fixtures.
Every image linked below was opened. These are viewport screenshots, not full-page
captures or accepted visual-regression baselines.

## Design contract

- **Audience:** visitors and members browsing the homepage and past events.
- **Screen job / primary action:** preserve the homepage's Discord join action and
  the archive's event browsing, search and subscription actions.
- **Real content:** unchanged application markup; the homepage uses the existing
  Lighthouse news fixture. The archive contains one disposable past event,
  “Community co-op night,” on 1 January 2020. No member data was used.
- **References:** [design-kit v0.2.0](https://github.com/TogetherWeOwn/two-design-kit/tree/v0.2.0),
  its [generated tokens](https://github.com/TogetherWeOwn/two-design-kit/blob/v0.2.0/dist/css/tokens.css),
  and the existing application at base commit
  `10099ce45e7f6a4f1ade945bbbca85278982109e`.
- **Layout / typography / tokens:** retain the existing composition and body type.
  Replace the old palette and display face using generated kit adapters and the
  self-hosted Mona Sans subset. Keep Hono's page/surface mapping and Kit's distinct
  surface/raised mapping. Do not add a serif accent, gradient or component.
- **Responsive behavior:** preserve existing breakpoints and action layout. Keep
  two-digit archive dates on one line inside their existing date tile.
- **Required states:** default, keyboard focus, reduced motion and forced colors
  at 1280×800 and 390×844.
- **Non-goals:** route ownership changes, new layouts, new components, light mode,
  authentication changes, logo or icon regeneration, and legacy admin restyling.
- **REA angle:** none for implementation; the binding, published design-kit source
  already defines the required roles. No third-party visual code was copied.

## Before and after

Before images were rendered from an isolated snapshot of base commit
`10099ce45e7f6a4f1ade945bbbca85278982109e`, using the same fixtures and viewport
sizes as the after images. The Kit evidence uses the compiled SvelteKit
`/events/past` page, not `/`, whose ownership still forwards to Hono.

| Application | Viewport | Before | After |
| --- | --- | --- | --- |
| Hono `/` | 1280×800 | [Before](hono-1280-before.png) | [After](hono-1280-default.png) |
| Hono `/` | 390×844 | [Before](hono-390-before.png) | [After](hono-390-default.png) |
| Kit `/events/past` | 1280×800 | [Before](kit-1280-before.png) | [After](kit-1280-default.png) |
| Kit `/events/past` | 390×844 | [Before](kit-390-before.png) | [After](kit-390-default.png) |

The intended differences are the kit palette and display font, including the
wider font's natural text wrapping. The narrow archive-date correction adds
`white-space: nowrap` and shares `--font-display`; it changes no grid or token.
The inherited logo artwork is unchanged.

## Required after states

| Application / width | Reduced motion | Forced colors | Keyboard focus |
| --- | --- | --- | --- |
| Hono / 1280 | [Image](hono-1280-reduced-motion.png) | [Image](hono-1280-forced-colors.png) | [Image](hono-1280-keyboard-focus.png) |
| Hono / 390 | [Image](hono-390-reduced-motion.png) | [Image](hono-390-forced-colors.png) | [Image](hono-390-keyboard-focus.png) |
| Kit / 1280 | [Image](kit-1280-reduced-motion.png) | [Image](kit-1280-forced-colors.png) | [Image](kit-1280-keyboard-focus.png) |
| Kit / 390 | [Image](kit-390-reduced-motion.png) | [Image](kit-390-forced-colors.png) | [Image](kit-390-keyboard-focus.png) |

## Browser assertions observed

- HTTP 200 for both routes; compiled immutable Kit CSS loaded on the Kit route.
- Every selected role exposed in computed styles in both stacks.
- Both `--theme-*` and `--theme-schedule-*` override families resolve all six
  ink/paper/brand/muted/surface/line aliases in both stacks.
- Kit keeps paper on surface (`#1c1614`) and surface on raised (`#241c19`).
- Fast motion is positive normally and zero under reduced motion.
- First keyboard focus is visible, with a 2px outline and 3px offset.
- Exactly one Mona Sans font preload. Mona Sans uses `swap`; the serif and mono
  faces use `optional`, are not preloaded and remain unused in these fixtures.
- No horizontal document overflow at either viewport.
- The mobile `01` date has one rendered text line; its glyph right edge is 85px,
  inside the tile's 93px right edge.
- Hono Events navigation and Kit's calendar subscription disclosure work.
- Served homepage: **26,368 bytes HTML**, **20,333 bytes inline CSS**, below the
  unchanged **26,732 / 20,697** ceilings.

## Automated gates observed

- `bin/local-ci.sh -j 8`: exit 0; 1,229 passing files, 25,853 passing tests.
  Coverage: 97.87% statements, 95.54% branches, 97.66% functions, 98.81% lines.
  Non-UTC: 162 passing tests. Tier-0: 115 passing tests.
- Focused theme regression run: 7 files, 135 tests passed.
- `npm --prefix web run build`: exit 0.
- `npm run a11y`: 154 passing Hono cases, no failures; the injected failure
  sentinel and owned fixture cleanup both passed.
- `npm run lighthouse`: 24/24 mobile Hono reports; all assertions passed.
- `npm run lighthouse:quality`: 24/24 desktop Hono reports; all assertions passed.

The Hono accessibility and Lighthouse gates did not exercise the Kit route.
The actual Kit screenshots and browser assertions above are its visual evidence.
No production or staging database, probe, migration or deployment was used.
No threshold was loosened. CI visual-baseline acceptance and independent design
QA are separate from this local capture record; these screenshots do not replace
those gates.
