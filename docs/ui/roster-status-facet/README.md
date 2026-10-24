# RSVP roster answer-status facet

## Design contract

- **Audience and job:** moderators reviewing one event's recorded RSVP answers.
- **Primary actions:** pick an answer status in the native select, optionally
  combine a bounded member search, submit an ordinary GET.
- **Content:** recorded responses, never seats or observed attendance. The range
  line counts responses; zero states distinguish genuine emptiness from filtered
  no-match and past-end pages.
- **References:** the existing roster GET form, the events-list status select and
  the join-attempts outcome select on both twins. Query key `roster_status`,
  exact values `going`, `waitlisted`, `maybe`, `not_going`; empty or invalid
  reads as All. First value wins on duplicate keys.
- **Layout and typography:** keep existing admin typography, surfaces, focus
  styling and spacing. Preserve Open Lobby, Logo 1 and all design tokens. No
  new CSS. The select sits beside member search; changing either filter resets
  page one by omitting `roster_page`.
- **Responsive:** capture 1280x800 desktop and 390x844 mobile viewports. The
  form wraps via the existing flex row; the table keeps its labelled
  Tab-focusable scroll region; recovery links sit below the table.
- **States:** All plus each of the four statuses; combined Unicode and
  literal-wildcard search; filtered zero; status-only zero; past-end;
  genuinely empty event. The native control is keyboard-operable with JS
  disabled, carries an accessible name, and never dirties the event editor;
  dirty drafts still veto roster GET departures through beforeunload.
- **Non-goals:** no RSVP or event writes, exports, attendance inference, new
  member columns, authority expansion, route enablement, threshold, budget or
  flag changes, and no new dependencies.

## Opened before/after screenshots

Each pair shows the same fixture state before and after the slice. The renders
execute the real Hono route or the real Kit loader plus the compiled Svelte
page, against synthetic classified-read fixtures with the actual public
stylesheets. They do not exercise deployment or production data. The Kit
captures render unthemed because the standalone SSR harness omits the app
shell; the pairs stay self-consistent, so structure and copy still compare.
System-font rendering is from the local browser environment, not the pinned
visual-regression runner. Every image below was opened.

States: `all` (unfiltered roster), `going` (filtered to one answer),
`zero` (filtered to zero rows with recovery), `pastend` (page past the end
with recovery).

| Renderer / state | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Hono all | [Before](Hono-all-1280-before.png) | [After](Hono-all-1280-after.png) | [Before](Hono-all-390-before.png) | [After](Hono-all-390-after.png) |
| Hono going | [Before](Hono-going-1280-before.png) | [After](Hono-going-1280-after.png) | [Before](Hono-going-390-before.png) | [After](Hono-going-390-after.png) |
| Hono zero | [Before](Hono-zero-1280-before.png) | [After](Hono-zero-1280-after.png) | [Before](Hono-zero-390-before.png) | [After](Hono-zero-390-after.png) |
| Hono pastend | [Before](Hono-pastend-1280-before.png) | [After](Hono-pastend-1280-after.png) | [Before](Hono-pastend-390-before.png) | [After](Hono-pastend-390-after.png) |
| Kit all | [Before](Kit-all-1280-before.png) | [After](Kit-all-1280-after.png) | [Before](Kit-all-390-before.png) | [After](Kit-all-390-after.png) |
| Kit going | [Before](Kit-going-1280-before.png) | [After](Kit-going-1280-after.png) | [Before](Kit-going-390-before.png) | [After](Kit-going-390-after.png) |
| Kit zero | [Before](Kit-zero-1280-before.png) | [After](Kit-zero-1280-after.png) | [Before](Kit-zero-390-before.png) | [After](Kit-zero-390-after.png) |
| Kit pastend | [Before](Kit-pastend-1280-before.png) | [After](Kit-pastend-1280-after.png) | [Before](Kit-pastend-390-before.png) | [After](Kit-pastend-390-after.png) |

## Visual findings

- The facet select renders beside member search on both twins at both widths
  and wraps above the search field on narrow screens.
- Filtered states show only matching answers with the scoped range copy.
- Filtered zero shows the scoped empty copy plus Clear roster filters; the
  past-end state keeps No RSVPs on this page plus First page of these
  responses and Clear roster filters.
- No other pixel changed: sort headers, pagination, hint copy and the event
  editor above the section render identically before and after.
