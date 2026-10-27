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

Hono accessibility and Lighthouse gates do not exercise the Kit routes.
Pinned-runner visual regression stays in CI; these screenshots do not replace
that gate, and no baseline, mask or threshold is changed here.
