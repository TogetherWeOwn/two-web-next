# Past-event search notice: fixture visual evidence

## Design contract

- Audience: people searching the past-event archive.
- Screen job: explain an overlong search without claiming an outage.
- Primary action: **Back to events** (`/events`); secondary: homepage (`/`).
- Real content: **Events**, “Search query must be 255 characters or fewer.”
- References: the existing [Hono notice](../../../src/events/pages-calendar-screen.tsx),
  [shared notice copy](../../../src/islands/contracts-calendar.ts), and
  [Kit recovery shell](../../../web/src/lib/ErrorShell.svelte).
- Layout, typography and tokens: retain the existing recovery hero and site shell.
  Use the existing responsive action row, stacked on mobile. No redesign, new
  tokens, query-length policy, search behavior or navigation changes.
- Required state: 422 notice with events/home recovery, without query echo or
  outage copy. The former 500 fallback is shown for comparison only.

## Captures

| State | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- |
| Former mapping | [Before](before-desktop.png) | [Before](before-mobile.png) |
| Corrected notice | [After](after-desktop.png) | [After](after-mobile.png) |

Captured on 2026-10-21 in local Chromium with JavaScript disabled. The fixture
SSR-renders the real `ErrorShell.svelte`, bundles its real child components,
uses the public stylesheets and compiled Kit `app.css`, and intercepts a
synthetic origin to serve local assets. No database or external network is used.
All four images were opened and reviewed: notice and recovery actions remain
readable at both widths without horizontal overflow.

The before captures explicitly reproduce the former boundary mapping with
`ErrorShell(500)`; they are not from a historical checkout. The after captures
use `ErrorShell(422)`. These are component-fixture visuals, not proof of live
HTTP dispatch, hydration, staging or production deployment. No visual-regression
baseline was changed. The opted-in `kit-error-shell-render.test.ts` suite
separately checks the rendered recovery links, focus order and accessibility.
