# Saved-event review: local visual evidence

## Design contract

**Audience and job:** moderators checking the persisted event before publication.
**Primary action:** Save successfully → Review saved event → Publish the saved draft.

Reuse the current featured-preview section hierarchy, event Status actions and
native field anchors. Unlike featured content's checked-at preview, this section
labels the record's actual update timestamp. There is no new visual direction:
the current admin shell, typography, paper/ink palette, headings and links remain.
One native section sits between Save and Status and wraps naturally on mobile.
No new CSS, framework, token, endpoint, sharing permission or mutation is added.

**Required states:** saved/new, draft/published/cancelled, missing location,
strict before/equal/after-end advice, unsaved edits and rejected saves. Readiness
is advisory; Publish remains a separate native form, validated under its existing
server lock. See the [moderator workflow](../../moderator-admin-guide.md#save--review--publish).

## Opened comparisons

Full-page Chromium captures use desktop **1280×800** and mobile **390×844**
viewports. Every comparison below was opened for visual inspection. All content
is synthetic. The actual Hono editor response and compiled Kit load/SSR page
were rendered with the served stylesheet; requests were fulfilled locally.
These images do not claim full Kit hydration, deployed traffic or a live Publish.

| Editor | Width | Before | After |
|---|---|---|---|
| Hono | Desktop | [Before](before-Hono-desktop.png) | [After](after-Hono-desktop.png) |
| Hono | Mobile | [Before](before-Hono-mobile.png) | [After](after-Hono-mobile.png) |
| Kit | Desktop | [Before](before-Kit-desktop.png) | [After](after-Kit-desktop.png) |
| Kit | Mobile | [Before](before-Kit-mobile.png) | [After](after-Kit-mobile.png) |

## Critique and scope

- The new heading/link follows Save and precedes Status; the primary Save/Publish
  actions stay distinct. No affordance appears on the new unsaved form.
- Timestamp and advisory paragraphs wrap within the existing mobile column;
  no horizontal document overflow was observed at either width.
- Blank-location and ended guidance has native links back to its existing input.
  Published/cancelled copy does not imply that another Publish is available.
- Rejected-save fields retain the attempted input while provenance still identifies
  the stored record. New and rejected-save routes remain Hono-owned even when
  reached from the Kit editor; these are not new Kit mutation implementations.
- Existing typography, spacing, navigation and roster layout are retained. No
  material visual issue was found in the opened local captures. Additional
  required-state captures and raw acceptance results accompany the delivery record.

The current a11y, Lighthouse and public-page visual specifications exercise Hono,
not this Kit editor. Kit has separate compiled-page fixture acceptance, screenshots,
Svelte checks and a production build. The public-page visual baselines are unchanged;
CI on the pinned runner remains authoritative for pixel comparisons.
