# Calendar week-start evidence

Monday-first (default) or Sunday-first month grid, chosen through a labelled
native GET select. Every PNG below was captured by the week-start browser
acceptance suite against local fixtures (no server, database or network) and
opened during review.

## Design contract

- Audience: members and moderators reading the schedule month grid.
- Screen job: pick a familiar week layout. Primary action: choose
  Monday-first or Sunday-first and Apply; the same month re-renders.
- Real content: the existing month toolbar (previous/This month/next, month
  jump). The week form sits directly below the jump form.
- References: no external references; follows the in-repo native GET
  month-jump pattern (hidden month-scope fields, `.btn` submit). Explicit
  Apply matches the existing game-facet submit UX; no auto-submit on change.
- Layout/type/tokens: inline label + select + Apply; inherits existing form
  and button styles. No new tokens, no new CSS.
- Responsive: the toolbar wraps inline on narrow screens; the grid keeps its
  existing horizontal-scroll region on mobile.
- Required states: default Monday (parameter omitted); selected Sunday
  (headings, cells and read window move together); invalid/missing/duplicate
  input renders Monday; no-JS full navigation; island fragment swap with
  Back/Forward control sync; failed fragments retain the committed layout;
  search still forces the list.
- Non-goals: locale inference, persisted preference, cookies/schema,
  recurrence, timezones, a new island/renderer, feed/export changes.

## Captures

Hono and Kit twins render byte-identical PNGs (the Kit route serves the same
Hono calendar HTML through its endpoint), so both twins are listed.

- `hono-before-1280.png`, `hono-before-390.png`: default Monday grid,
  February 2027, desktop and mobile.
- `hono-sunday-1280.png`, `hono-sunday-390.png`: Sunday layout after the
  native no-JS choice. The leading January 31 cell carries the spillover
  events and the trailing March 6 cell the March event: the read window
  moves with the headings, not just the labels.
- `hono-before-0001-01-{1280,390}.png`: January year 1 boundary, Monday.
- `hono-before-9999-12-{1280,390}.png`: December 9999 boundary, Monday.
- `kit-*.png`: Kit-twin equivalents, byte-identical to the Hono shots.

Keyboard/native/no-JS: the suite drives the real submit button with keyboard
Enter, submits the native GET with JavaScript disabled, and asserts history,
failed (503/malformed) and superseded fragments. Axe (`npm run a11y`) audited
146 pages with zero failures, including `/events?view=calendar`.
