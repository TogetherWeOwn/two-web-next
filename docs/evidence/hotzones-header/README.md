# Hotzone header parity evidence

## Design contract

- **Audience and screen job:** community visitors viewing aggregate activity rhythms.
- **Primary action:** Open Discord, linking directly to `/discord`, as the Hono pages do.
- **References:** [Hono hotzone headers](../../../src/hotzones/pages.tsx),
  [Shell snippet contract](../../../web/src/lib/Shell.svelte) and
  [header account slot](../../../web/src/lib/SiteHeader.svelte).
- **Layout, typography and tokens:** preserve the schedule shell, `.btn` styling,
  page content, logo and navigation. Replace only the default guest account cluster.
- **Responsive behavior:** preserve existing desktop and stacked mobile headers.
- **Required states:** index and joins/voice/games, all-time and explicit season.
- **Non-goals:** new visual direction, shared login URL behavior, other headers,
  OAuth/session/RSVP flows, data, error representation or route flags.

## Captures

All eight images were opened for visual inspection. The viewport is 1280×800
for desktop and 390×844 for mobile. Both pages use `?season=2026-10`.
The only intended visual change is the account action; the caption disappears
and the shorter button remains aligned. Header heights remain 80px desktop and
141px mobile, with no page-level horizontal overflow at either width.
The existing heatmap presentation is unchanged.

| Page / viewport | Before | After |
| --- | --- | --- |
| Index / desktop | [Before](before-index-desktop.png) | [After](after-index-desktop.png) |
| Index / mobile | [Before](before-index-mobile.png) | [After](after-index-mobile.png) |
| Joins / desktop | [Before](before-joins-desktop.png) | [After](after-joins-desktop.png) |
| Joins / mobile | [Before](before-joins-mobile.png) | [After](after-joins-mobile.png) |

## Fixture and coverage boundaries

These are real Kit **component-fixture** captures, not deployed-page observations.
The web workspace's locked Svelte compiler compiles the actual index/signal
components and their real Shell/Header/Metadata dependencies; `svelte/server`
renders them with deterministic synthetic load data. The shared Hono grid
renderer supplies the table markup. Chromium opens the rendered documents from
a short-lived loopback fixture server, using the actual Vite-built Kit CSS,
public theme sheets, logo and local fonts. Off-origin requests are aborted.
No database, Discord, bot or staging traffic supplies these screenshots.
The fixture does not execute the complete Kit Worker request/load pipeline.

The focused `test/kit-hotzones-header-render.test.mjs` suite renders both Hono
and Kit for all four paths, with and without an explicit season (16 cases).
Each checks the direct Discord header action and excludes the join-OAuth link
and sign-in label. Removing the index override fails its two Kit cases;
removing the signal override fails its six Kit cases. The existing paired
Worker journey also requires matching direct-action headers on both renderers.

Hono a11y, Lighthouse and public-page visual gates do **not** exercise these
Kit routes. Their results are reported separately in the pull request. No
visual baseline was changed or accepted, and no threshold was relaxed.
