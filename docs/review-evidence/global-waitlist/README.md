# Global waitlist order: fixture visual evidence

These comparisons show the real Hono roster and compiled Svelte roster before
and after the global waitlist-position change. All content is synthetic. The
fixtures inject three read results into the real templates; they do not replace
the independent PostgreSQL ranking, search, count, pagination or audit proofs.

| Renderer | Desktop, 1280 × 800 | Mobile, 390 × 844 |
| --- | --- | --- |
| Hono | [Before / after](hono-1280.png) | [Before / after / focused queue column](hono-390.png) |
| Kit | [Before / after](kit-1280.png) | [Before / after / focused queue column](kit-390.png) |

Every original capture and comparison was opened for visual review. Mobile
captures include the normal left edge and the queue column revealed by focusing
its native sort link: the table scrolls 74px inside its 342px region, without
page overflow. JavaScript is disabled in these captures. No image is a new
baseline or a threshold waiver.

## Design contract

- Audience: authorized moderators deciding who is next in line.
- Screen job and primary action: distinguish FIFO queue order from answer
  recency; sort **Waitlist position** with an ordinary GET link.
- Content and states: positions 57 and 102, an unranked Going response, an
  Unknown member, retained search/status/paging controls, empty and past-end
  pages, and open, paused, cancelled and ended event fixtures.
- References: existing admin table and `TableSortHeader`, normalized roster
  query/URL helpers, and the exact FIFO keys in `src/events/waitlist.ts`.
- Layout and tokens: inherit the existing admin typography, spacing and contrast;
  add a fourth column, retain the labelled keyboard-focusable scroll region.
  No CSS, framework, breakpoint or visual direction changes.
- Guidance: queue order is not a promised seat or attendance. Searches and
  filters do not renumber it; paused or closed queues do not advance.
- Non-goals: no priority editing, promotion, seat assignment, export, schema,
  new authority, route ownership change or public roster.

## Capture conditions and limits

Chromium rendered local intercepted fixtures only, using the real template
output and repository styles. The Kit helper returns a body fragment, so the
capture wrapper supplies UTF-8, the viewport, the same public admin stylesheets
and built root CSS. The Hono and Kit outer fixture shells retain their existing
light/dark defaults; each before/after pair uses the same styling. The comparison
files only arrange the unscaled original screenshots with labels.

Separate original captures cover open, paused, cancelled, past, empty and
past-end states at both widths for each renderer. They are retained with the
execution evidence. No staging or production data was used. These pictures
prove rendering, not deployment. Hono accessibility/Lighthouse and public-page
visual gates do not exercise the Kit route; its compiled-template evidence and
native keyboard browser cases are separate.
