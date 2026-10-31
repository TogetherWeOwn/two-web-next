# Admin events: find saved nights by title or game

## Design contract

- **Audience and job:** moderators finding a generically titled saved night by
  its saved Game field on `/admin/events`, without opening every row.
- **Primary actions:** type into Search; scan the Title column for the game.
- **Content:** fixtures carry a generic title with a saved game
  ("Friday social" / "Terraforming Mars"), null/empty/whitespace games, and an
  HTML-shaped game (`<img src=x>`).
- **References/assumptions:** no external references; assumes the existing
  shared markup contract between `EventsPage` and the Kit page stays
  byte-similar, and reuses the existing `.hint` style for secondary text and
  help (`assets/styles.css`). No new tokens.
- **Layout and typography:** Title cell keeps the row link on line one; a
  nonblank saved game follows on its own line as secondary text. The search
  field gains a clarified label plus one line of help. Open Lobby/Logo 1 and
  semantic tokens untouched; no new CSS.
- **Responsive:** 1280x800 desktop and 390x844 mobile captures. The table keeps
  scrolling inside its labelled region; the game line and help wrap in place.
- **States:** nonblank game shown; null/empty/whitespace game renders no
  secondary text and no placeholder; HTML-shaped games escaped; search stays a
  native GET form with no page field; `q` preserved through sort (page reset)
  and paging links; `private, no-store` preserved.
- **Non-goals:** no new facet/parameter, game vocabulary, schema/index, counts,
  public schedule changes, bulk actions, mutations, route cutover, or
  budget/threshold changes.

## Before and after

These are synthetic local HTTP fixtures of the **real Hono `EventsPage`** and
the **real Kit `+page.svelte` compiled to SSR** (before components pinned to
their pre-change source), served through route interception with the real
`public/styles.css`, JavaScript disabled. Rows are an unfiltered five-row
fixture so every Title-cell state renders on one screen; the live
`GET /admin/events?q=<game>` filtering itself is proven by the disposable-DB
acceptance tests, not here. These are not live authenticated Worker or
deployment screenshots. All images below were opened.

| Renderer | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Hono events | [Before](before-Hono-1280.png) | [After](after-Hono-1280.png) | [Before](before-Hono-390.png) | [After](after-Hono-390.png) |
| Kit events | [Before](before-Kit-1280.png) | [After](after-Kit-1280.png) | [Before](before-Kit-390.png) | [After](after-Kit-390.png) |

Keyboard focus (Tab reaches the search input with a visible ring, JS
disabled): [Hono](after-Hono-390-focus.png), [Kit](after-Kit-390-focus.png).
The first Tab stop shows the skip link with a visible outline on both
twins (verified during capture).

## Critique and disposition

- The clarified label ("Search titles and games") plus help ("Matches event
  titles and saved games.") fits the existing filter row at both widths; the
  input keeps `type="search"`, its accessible name, and `aria-describedby`.
- The game line sits under the title link in the existing hint style; rows
  with null/blank games are byte-identical to before (no placeholder clutter).
- The HTML-shaped game renders as literal escaped text; no markup injection.
- Mobile: no new document overflow at either width; the game line wraps inside
  the scrolling table region exactly like the title link already did.
- Hono and Kit twins render the same label, help, and cell structure.
- No visual-regression baseline was changed or accepted: the visual specs do
  not cover `/admin/events`. The Hono a11y/Lighthouse gates do not exercise
  Kit routes; the executed Kit SSR, browser matrix, and focus captures above
  are the twin-specific behavior evidence.
