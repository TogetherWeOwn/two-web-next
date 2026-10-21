# Past-event share honesty: evidence

All captures render real output: the Hono captures run the real `/e/:key`
route handler through the acceptance fixtures; the Kit capture
SSR-compiles the real `EventDetail.svelte` with the resolver model. The
repo stylesheets (`styles.css`, `theme-tokens.css`, `theme.css`,
`event-theme.css`) are inlined byte-identical from `public/` because the
evidence browser cannot reach a local static server; the Display webfont
falls back to system fonts for the same reason. No member data, no live
Discord, no production fixtures. Every image below was opened by the
author.

## Design contract

- Audience: visitors landing on a past event page.
- Screen job: share an event that already happened, and offer a way on.
- Primary action: Copy link; secondary: browse the past archive.
- Real content: a synthetic past event (Chess night, January 2020, venue,
  lineup counts) plus the live control (same event, January 2030).
- References: the cancelled (410) page's way-back link (same plain-anchor
  convention); the live share box (same section, separators, toast).
  No new visual direction, so no external references.
- Layout: unchanged share section; past swaps the heading to "Share this
  event", drops the two calendar actions, keeps Copy link, and appends
  "Browse past events" after the existing separator.
- Typography/tokens: inherited; no new CSS.
- Responsive: the two past links wrap in normal flow at 390px. No
  horizontal overflow at either width.
- Required states: past (new box), live (byte-identical box). Cancelled
  keeps its 410 page with no share box; draft keeps the live box for
  moderators (both covered by branch-stability tests, not by new pixels).
- Non-goals: archive page, ICS feed mechanics, cancelled-page behavior.

## Before / after

Before: the share box was unconditional, so past events rendered the exact
box the live captures below still show ("Save the date" plus both
calendar actions). The RED acceptance run pins that before-state
(heading "Save the date", calendar links present); the live after-shots
double as the before-past rendering.

| State / width | After |
| --- | --- |
| Past Hono desktop (1280x800) | [after](after-past-hono-desktop.png) |
| Past Hono mobile (390x844) | [after](after-past-hono-mobile.png) |
| Live Hono desktop (1200x750, desktop layout) | [after](after-live-hono-desktop.png) |
| Live Hono mobile (390x844) | [after](after-live-hono-mobile.png) |
| Past Kit desktop (1200x750, desktop layout) | [after](after-past-kit-desktop.png) |

Not captured: Kit mobile and Kit live cells. The shared evidence browser
was viewport-contended during this run, so those two widths would not
hold. They are covered without new pixels: Kit live output is pinned
byte-identical by test S2, Kit past behavior by K1-K4/P1-P3, and the
390px wrap by the Hono twin captures above (identical share markup
structure and the same stylesheets).

## Reviewed CI baselines

No visual-baseline change: the pinned-runner suites have no past-event
detail baseline, and the live share box is byte-identical, so no seeded
page shifts. If a baseline diffs, accept only through the failure
artifact and `node ci/visual-accept.mjs` after opening every
expected/actual/diff image. No threshold, mask, or spec change is part of
this work.
