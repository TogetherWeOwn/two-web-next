# Throttled admin writes: way back to the form — visual evidence

Captured and opened on 2026-10-21 using the actual Hono response path
(`app.request` against a spent throttle double, refused moderator POST) and
the actual Kit `ErrorShell.svelte` SSR output, with the repo's real public
assets served locally. No real member, session, database, or external
service was used.

| Surface | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- |
| Hono throttled admin write | [PNG](hono-admin-429-desktop.png) | [PNG](hono-admin-429-mobile.png) |
| Kit throttled admin write | [PNG](kit-admin-429-desktop.png) | [PNG](kit-admin-429-mobile.png) |
| Hono generic 429 (unchanged) | [PNG](hono-429-desktop.png) | — |
| Kit generic 429 (unchanged) | [PNG](kit-429-desktop.png) | — |

All captures reported zero horizontal document overflow and zero page
errors. The way-back link (`Back to the new event form` → `/admin/events/new`)
and the `Your submission was not saved` note render only on the admin-path
429s; the generic shells carry neither. These are manual visual evidence,
not replacements for the pinned-runner visual baseline comparisons.

## Design contract

- Audience: moderators whose admin write was refused by the shared
  `admin-write` throttle.
- Screen job: tell them the save did not happen and give them one step
  back to the form they came from.
- Primary action: the way-back link, first in the recovery row, named for
  the refused save (`Back to the new event form`, `… event editor`,
  `… featured form`, `… featured editor`, `… queue preview`,
  `… admin dashboard`).
- Real content: fixture invite URL, fixture support reference, refused
  `POST /admin/events` mapping to `/admin/events/new`.
- References: the existing 429 recovery shell (unchanged lead, invite and
  home recovery); no new visual direction.
- Layout/typography/tokens: shell defaults only — one plain paragraph for
  the honesty note, one text link ahead of the existing actions. No new
  CSS, no token changes.
- Responsive behavior: the recovery row wraps as it does today; verified
  at 390×844 with no overflow.
- Required states: way-back present (admin 429, both twins, both widths);
  way-back absent (generic 429, both twins).
- Non-goals: throttle budgets, retry/backoff, draft persistence or
  autosave, gate logic, the join flow.

The existing Hono accessibility and Lighthouse gates do not exercise the
admin 429 route; the Kit captures above are the visual evidence for the
`web/` change.
