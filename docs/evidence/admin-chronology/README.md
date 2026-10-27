# Admin chronology fixture evidence

These are local fixture renders, not live member data or release proof.
The real Hono handlers and compiled Kit loads/templates ran against the mapped
SQL fixture in `test/helpers/admin-chronology.ts`. JavaScript was disabled.

Each opened contact sheet contains four original screenshots without rescaling:
before on the left, after on the right; desktop 1280×800 above mobile 390×844.
The before revision is `d6e9491c2`. An unavailable timestamp previously refused
the whole page; the after state keeps all three rows and marks only that time
unavailable. The original mobile tables are horizontally scrollable: an edge
can clip a column until the labelled region is focused and scrolled.

## Design contract

- Audience/job: moderators reading response updates and activity chronology.
  Existing search, sort and filter controls remain the primary actions.
- References: existing Hono admin tables and their Kit twins; semantic HTML
  `time`. Keep established type, colors, spacing and labels; no visual redesign.
- Content: readable UTC dates with seconds, exact ISO machine instants, and
  **Time unavailable** for unusable values. Response updates do not imply
  attendance or the original waitlist join time.
- Responsive/state contract: normal and one-unavailable-row states, both
  renderers and viewports, with native keyboard-focusable horizontal scrolling.
  A scoped nonwrapping time cell prevents dates breaking across several lines.
- Non-goals: data repair, extra identifiers/reads, changed ordering/pagination,
  public time surfaces, route activation, and new client interactions.

## Opened before/after sheets

| Renderer | Screen | Normal | One unavailable row |
| --- | --- | --- | --- |
| Hono | Roster | [Sheet](Hono-roster-normal.png) | [Sheet](Hono-roster-unavailable.png) |
| Hono | Activity | [Sheet](Hono-activity-normal.png) | [Sheet](Hono-activity-unavailable.png) |
| Kit | Roster | [Sheet](Kit-roster-normal.png) | [Sheet](Kit-roster-unavailable.png) |
| Kit | Activity | [Sheet](Kit-activity-normal.png) | [Sheet](Kit-activity-unavailable.png) |

## Opened mobile time-column views

These additional 390×844 captures show the focused table after horizontal
scrolling brings the time column fully into view. Native ArrowRight moved
every scrollable region in a JavaScript-disabled browser; browser scrolling
animation was disabled for deterministic assertions.

| Renderer | Screen | Normal | One unavailable row |
| --- | --- | --- | --- |
| Hono | Roster | [Time column](Hono-roster-normal-390-scrolled.png) | [Time column](Hono-roster-unavailable-390-scrolled.png) |
| Hono | Activity | [Time column](Hono-activity-normal-390-scrolled.png) | [Time column](Hono-activity-unavailable-390-scrolled.png) |
| Kit | Roster | [Time column](Kit-roster-normal-390-scrolled.png) | [Time column](Kit-roster-unavailable-390-scrolled.png) |
| Kit | Activity | [Time column](Kit-activity-normal-390-scrolled.png) | [Time column](Kit-activity-unavailable-390-scrolled.png) |

## Executed focused evidence

- Before implementation: the independent acceptance suite executed 76 cases;
  24 controls passed and 52 chronology assertions failed, with zero skips.
- After implementation: 95/95 focused acceptance/formatter cases passed in UTC
  and America/Los_Angeles, with zero skips. Tests retain exact wire instants,
  valid sibling rows, audit refusal, query budgets and list behavior.
- Chromium: all 16 after-state/viewport combinations returned 200 without
  JavaScript. Each labelled table region accepted keyboard focus. A browser
  range assertion first detected multiline time labels and then passed with
  every valid time on one line after the scoped style change.

- `npm run a11y`: 146 fixture pages, zero failures in the supported
  isolated-schema test mode.
- `npm run lighthouse` and `npm run lighthouse:quality`: both exited 0;
  24/24 reports collected and asserted per run. Initial local collection failed
  because a process utility was absent; using the existing utility and cleaning
  only this run's failed fixture process tree restored collection.

Hono accessibility and Lighthouse gates do not exercise the Kit routes.
Pinned-runner visual regression stays in CI; these screenshots do not replace
that gate, and no baseline, mask or threshold is changed here.
