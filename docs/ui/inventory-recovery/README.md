# Event and featured inventory recovery

## Design contract

- **Audience and job:** moderators finding events or featured content after filters
  or a stale page URL return no rows.
- **Primary actions:** Clear filters beside Filter; First page of these results
  below an empty later-page table, outside its horizontal scroll region.
- **Content:** retain genuine-empty and no-match copy on page one. A later empty
  page says **No results on this page.** Search fixtures include `Café & "games"`.
- **References:** the existing admin filter form, paging links and shared shells.
  Reuse native anchors and wrapping fields, not a new component system or icons.
- **Layout and typography:** keep existing admin typography, surfaces, focus
  styling and spacing. Preserve Open Lobby, Logo 1 and all design tokens.
- **Responsive:** capture 1280×800 desktop and 390×844 mobile viewports. Keep table
  scrolling; recovery links remain outside the wide table and within the viewport.
- **States:** genuine first-page empty, filtered first-page no-match, filtered and
  unfiltered past-end, and populated filtered results on both renderer twins.
- **Non-goals:** no filter redesign, count query, extra read, outage retry, row
  mutation, authorization change, route cutover or threshold/budget change.

## Opened before/after screenshots

These PNGs show the filtered past-end state. Full-page captures preserve the
content below the original viewport. All five states above were also captured
and opened in full-width inspection sheets in the accompanying QA evidence bundle.
The renders execute the real Hono routes or Kit loaders and compiled Svelte
components, with synthetic database fixtures, actual public stylesheets and the
built Kit root stylesheet. They do not exercise deployment or production data.
The Kit capture explicitly includes the head stylesheet that standalone Svelte
body rendering omits. System-font rendering is from the local browser environment,
not the pinned visual-regression runner.

| Renderer / inventory | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Hono events | [Before](Hono-events-1280-before.png) | [After](Hono-events-1280-after.png) | [Before](Hono-events-390-before.png) | [After](Hono-events-390-after.png) |
| Hono featured | [Before](Hono-featured-1280-before.png) | [After](Hono-featured-1280-after.png) | [Before](Hono-featured-390-before.png) | [After](Hono-featured-390-after.png) |
| Kit events | [Before](Kit-events-1280-before.png) | [After](Kit-events-1280-after.png) | [Before](Kit-events-390-before.png) | [After](Kit-events-390-after.png) |
| Kit featured | [Before](Kit-featured-1280-before.png) | [After](Kit-featured-1280-after.png) | [Before](Kit-featured-390-before.png) | [After](Kit-featured-390-after.png) |

## Visual findings

- Clear filters stays beside Filter or wraps with its field; no new horizontal
  document overflow was observed at either width.
- First-page recovery remains readable outside the table scroll region. Existing
  Previous, page number and row actions remain present.
- Genuine first-page empty screens remain unchanged. Filtered page-one screens
  retain their no-match message and gain only Clear filters.
- Kit's existing dark admin canvas and low-contrast brand are also visible in the
  before captures. This change does not alter the shared chrome or its tokens.
- No visual-regression baseline was changed or accepted. The Hono accessibility
  and Lighthouse gates do not exercise Kit routes; the executed Kit SSR and
  browser matrix provide the twin-specific behavior evidence.
