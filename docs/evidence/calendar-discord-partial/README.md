# Partial Discord schedule: evidence

All captures render the real shared events screen (`renderEventsHtml`) with
two synthetic published rows, served with the repo's real stylesheets and
island script, screenshotted in headless Chromium at 1280x800 (desktop) and
390x844 (mobile). Before images render the base code; after images render this
branch. Every image below was opened by the author.

## Design contract

- Audience: members and guests checking the community schedule.
- Screen job: show usable local events during a Discord source failure without
  claiming the schedule is complete.
- Primary action: keep browsing healthy rows; secondary: retry the same page.
- Real content: two synthetic published events with game, time, venue, RSVP
  counts. No member data, no live Discord, no production fixtures.
- References: the existing full-error block (same retry + invite pattern) and
  the out-of-range status line (same `role="status"` treatment). No new visual
  direction, so no external references.
- Layout: one status block at the top of the swapped content zone, above the
  list or month grid; one sentence plus a retry link and the invite fallback.
- Typography/tokens: inherited theme type and callout panel; no new CSS.
- Responsive: the sentence wraps inside the panel at 390px; links stay in
  normal flow. No horizontal overflow at either width.
- Required states: partial list, partial month grid, recovered list (no
  notice). Failed-empty keeps the existing full error; genuine complete
  zero-match keeps the existing miss block (both covered by tests, not by
  new pixels here).
- Non-goals: new retry services, snapshot changes, homepage changes, feed or
  RSVP changes, new metrics.

## Before / after

Before = base code during a Discord failure: healthy rows render with no
missing-source notice, so the schedule reads as complete. The base recovered
captures are byte-identical to the base failure captures (verified with
`cmp`); the old code cannot distinguish the states, so they are not
duplicated here.

| State / width | Before | After |
| --- | --- | --- |
| List desktop | [before](before-list-desktop.png) | [after](after-partial-list-desktop.png) |
| List mobile | [before](before-list-mobile.png) | [after](after-partial-list-mobile.png) |
| Month desktop | [before](before-calendar-desktop.png) | [after](after-partial-calendar-desktop.png) |
| Month mobile | [before](before-calendar-mobile.png) | [after](after-partial-calendar-mobile.png) |
| Recovered list desktop | (identical to before) | [after](after-recovered-list-desktop.png) |
| Recovered list mobile | (identical to before) | [after](after-recovered-list-mobile.png) |

## Reviewed CI baselines

The pinned-runner visual suites compare only in CI. This change is expected to
shift exactly four baselines, each by the notice block above otherwise
unchanged rows: `events-desktop`, `events-mobile`, `kit-events-index-desktop`,
`kit-events-index-mobile`. Accept only through the failure artifact and
`node ci/visual-accept.mjs` after opening every expected/actual/diff image.
No threshold, mask, or spec change is part of this work.
