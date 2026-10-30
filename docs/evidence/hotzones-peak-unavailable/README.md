# Hot-zone peak callouts + honest unavailable reads: evidence

All captures render real route output with the repo's real stylesheets,
screenshotted in headless Chromium at 1280x800 (desktop) and 390x844
(mobile). Hono captures render the real Hono handlers (`GET /hotzones`,
`GET /hotzones/:signal`) against a disposable `agent-testdb` schema seeded
with 8 joins Monday 2026-09-07 20:05 UTC + 3 Tuesday 10:15 UTC and one
published event (peak: Monday 20:00, 8 joins), an empty schema
(genuine-empty), or no database (unavailable). Kit captures SSR the real
Svelte shells with the real `loadHotzonesIndexData` /
`loadHotzoneSignalData` data shaped exactly as the `+page.server.ts`
bindings shape it, wrapped with the shared theme stylesheets (Kit's own
utility layer ships via its build; content and structure are exact). Before
images render the base code with the same fixtures. Every image below was
opened by the author.

## Design contract

- Audience: members and guests reading community activity rhythms.
- Screen job: answer "when does {signal} activity peak" at a glance, and say
  plainly when the joins read has no database instead of showing silent zeros.
- Primary action: read the peak summary, then scan the grid. No new actions.
- Real content: seeded joins (Monday 20:00 peak, 8 joins) plus the
  WhatPulse-seeded voice/games priors; no member data, no live Discord.
- References: the leaderboards outage line (same `role="status"` shape and
  "temporarily unavailable" voice); the existing per-section estimate labels.
  No new visual direction, so no external references.
- Layout: one summary `<p>` per grid directly above its grid (summary-first
  for screen-reader users); the outage line replaces the joins grid only.
- Typography/tokens: inherited body text; no new CSS.
- Responsive: the one-line summaries wrap in normal flow at 390px; the grid
  keeps its scroll region. No horizontal overflow at either width.
- Required states: peak lines on index + joins + voice (estimated qualifier),
  joins outage on index + signal with priors still rendering, genuine-empty
  keeping current copy + tables. Games signal renders through the same
  component as voice (pinned by tests, not duplicated here).
- Non-goals: new seasons/scopes, ranking changes, cross-signal links,
  board-view logging, other grammars; season plumbing, canonical URLs,
  `loginReturnTo`, period picking and priors labeling unchanged.

## Before / after

Before = base code: grids render with no peak callout, and the unavailable
joins read renders a silent-zero grid. The base unavailable HTML is
byte-identical to the base genuine-empty HTML (verified with `cmp`); the old
code cannot distinguish the states.

| State / width | Before | After |
| --- | --- | --- |
| Hono index peak desktop | [before](before-hono-index-peak-desktop.png) | [after](after-hono-index-peak-desktop.png) |
| Hono index peak mobile | [before](before-hono-index-peak-mobile.png) | [after](after-hono-index-peak-mobile.png) |
| Hono index unavailable desktop | [before](before-hono-index-unavailable-desktop.png) | [after](after-hono-index-unavailable-desktop.png) |
| Hono index unavailable mobile | [before](before-hono-index-unavailable-mobile.png) | [after](after-hono-index-unavailable-mobile.png) |
| Hono index genuine-empty desktop | (identical to before-unavailable) | [after](after-hono-index-genuine-empty-desktop.png) |
| Hono index genuine-empty mobile | (identical to before-unavailable) | [after](after-hono-index-genuine-empty-mobile.png) |
| Hono joins peak desktop | (no peak line, as index) | [after](after-hono-joins-peak-desktop.png) |
| Hono joins peak mobile | (no peak line, as index) | [after](after-hono-joins-peak-mobile.png) |
| Hono joins unavailable desktop | (silent zeros, as index) | [after](after-hono-joins-unavailable-desktop.png) |
| Hono joins unavailable mobile | (silent zeros, as index) | [after](after-hono-joins-unavailable-mobile.png) |
| Hono voice peak desktop | (no peak line, as index) | [after](after-hono-voice-peak-desktop.png) |
| Hono voice peak mobile | (no peak line, as index) | [after](after-hono-voice-peak-mobile.png) |
| Kit index peak desktop | [before](before-kit-index-peak-desktop.png) | [after](after-kit-index-peak-desktop.png) |
| Kit index peak mobile | [before](before-kit-index-peak-mobile.png) | [after](after-kit-index-peak-mobile.png) |
| Kit index unavailable desktop | [before](before-kit-index-unavailable-desktop.png) | [after](after-kit-index-unavailable-desktop.png) |
| Kit index unavailable mobile | [before](before-kit-index-unavailable-mobile.png) | [after](after-kit-index-unavailable-mobile.png) |
| Kit joins peak desktop | (no peak line, as index) | [after](after-kit-joins-peak-desktop.png) |
| Kit joins peak mobile | (no peak line, as index) | [after](after-kit-joins-peak-mobile.png) |
| Kit joins unavailable desktop | (silent zeros, as index) | [after](after-kit-joins-unavailable-desktop.png) |
| Kit joins unavailable mobile | (silent zeros, as index) | [after](after-kit-joins-unavailable-mobile.png) |

## Reviewed CI baselines

None. The Hono visual suite (`e2e/visual/public-pages.visual.ts`) has no
hot-zone baselines, and this change adds `<p>` elements only to hot-zone
pages, so `browser-smoke` pixel-compares nothing new here. The Kit parity
journey asserts grid-region counts with a seeded database (available), which
this change preserves.
