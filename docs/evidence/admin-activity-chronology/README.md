# Activity-log chronology fixture evidence

Synthetic local fixtures only, not member data or release proof. The real Hono
activity-log page (`ActivityLogPage`) and the real compiled Kit activity-log
page rendered against the same in-memory fixtures; JavaScript was disabled and
no request left the local route interception.

## Design contract

- Audience/job: moderators reading "who changed what, when" in the activity
  log. Search, filter and paging stay the primary actions.
- References: the existing Hono admin tables and their Kit twin, semantic
  HTML `time`, and the events-inventory "Unrenderable time" placeholder. Kept
  established type, colors, spacing and labels; no visual redesign.
- Content: readable UTC labels with seconds, exact ISO machine instants in
  `<time datetime>`, and **Unrenderable time** for unusable values. The When
  column is marked UTC.
- Responsive/state contract: normal and one-unrenderable-row states, both
  renderers, desktop 1280x800 and mobile 390x844. The time column never wraps
  (`admin-chronology`, shipped in the admin-only `admin-rsvp-review.css` so the
  shared inlined bundle and the homepage LCP ratchets stay untouched); on
  narrow screens the labelled scroll region scrolls
  horizontally, so an unscrolled capture clips the column edge.
- Non-goals: data repair, extra reads, changed ordering/pagination, public
  time surfaces, and new client interactions.

## Opened captures

| Renderer | State | Desktop 1280 | Mobile 390 |
| --- | --- | --- | --- |
| Hono | Normal | [PNG](Hono-activity-normal-1280.png) | [PNG](Hono-activity-normal-390.png) |
| Hono | One unrenderable row | [PNG](Hono-activity-unavailable-1280.png) | [PNG](Hono-activity-unavailable-390.png) |
| Kit | Normal | [PNG](Kit-activity-normal-1280.png) | [PNG](Kit-activity-normal-390.png) |
| Kit | One unrenderable row | [PNG](Kit-activity-unavailable-1280.png) | [PNG](Kit-activity-unavailable-390.png) |

Fixture instants straddle the 2026 US DST transitions (2026-03-08 spring
forward, 2026-11-01 fall back); every shot was opened and shows the same UTC
labels. The unavailable states previously threw `RangeError` on the unusable
row; now all rows render and only that cell reads "Unrenderable time".

These are inspectable fixture screenshots, not accepted visual-regression
baselines or deployment proof. No regression baselines, masks or thresholds
were changed. The repository Hono accessibility/Lighthouse gates and the
pinned Hono/Kit visual checks remain separate required checks; the a11y and
Lighthouse gates exercise the Hono site only and did not exercise the Kit
route.
