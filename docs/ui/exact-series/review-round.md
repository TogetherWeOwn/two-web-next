# Exact-series review follow-up evidence

## Design contract

Audience: moderators reviewing a saved recurrence after an edit. Job: inspect
that saved parent and its occurrences, including draft and cancelled siblings.
Primary action: the existing **Review occurrences in this series** editor link.
Content is synthetic: one seed parent, two children and a same-title standalone
decoy. The existing editor, inventory and moderator guide are the references;
no new visual direction, layout, typography, CSS or semantic token is introduced.
Open Lobby / Logo 1 stays unchanged. Desktop is 1280×800 and mobile is 390×844;
the existing inventory table scrolls horizontally on narrow screens.

Required states: the original seed-key failure, the corrected saved family, and
empty/overlong scopes after native GET-form submission without JavaScript.
Non-goals: a new screen, member projection, mutation, public visibility change,
production seed admission, route-ownership change or quality-budget relaxation.

## Rendered evidence

Each image below was captured and opened. **Before** replays the original
canonical-only scope expression against the same local fixture and bindings;
the corrected source was restored byte-for-byte immediately after capture.
**After** follows the saved seed-parent editor action and shows only its published
parent, draft child and cancelled child, not the same-title standalone decoy.
Recovery images were captured after submitting the actual native GET form: the
empty carrier remains present, recovery remains explicit and unrelated rows stay
absent. No application write or off-origin browser request occurred.

| Renderer / width | Before seed | After seed | Empty scope after Filter | Overlong scope after Filter |
| --- | --- | --- | --- | --- |
| Hono 1280 | [image](round-Hono-1280-before-seed.png) | [image](round-Hono-1280-after-seed.png) | [image](round-Hono-1280-after-empty.png) | [image](round-Hono-1280-after-overlong.png) |
| Hono 390 | [image](round-Hono-390-before-seed.png) | [image](round-Hono-390-after-seed.png) | [image](round-Hono-390-after-empty.png) | [image](round-Hono-390-after-overlong.png) |
| Kit 1280 | [image](round-Kit-1280-before-seed.png) | [image](round-Kit-1280-after-seed.png) | [image](round-Kit-1280-after-empty.png) | [image](round-Kit-1280-after-overlong.png) |
| Kit 390 | [image](round-Kit-390-before-seed.png) | [image](round-Kit-390-after-seed.png) | [image](round-Kit-390-after-empty.png) | [image](round-Kit-390-after-overlong.png) |

## Inspection and limits

The corrected heading names the saved series and the three stored statuses remain
legible. Filters, the recovery message and All events escape keep their existing
hierarchy at both widths. Mobile table clipping is the existing scrollable-table
behavior, with its visible scrolling hint; no new layout difference was found.
The Kit leaf-render fixture uses the existing dark canvas and built root CSS,
not a full Kit layout. Its low-contrast admin wordmark is visible in both before
and after evidence; these images do not certify full-layout contrast. No style
change is hidden by the seed fix.

The Hono accessibility and Lighthouse gates do not exercise Kit routes. These
fixture renders and native-form checks are not pinned-runner pixel comparisons,
staging tests or deployment proof. No visual baseline, mask, score floor, bundle
allowance or route-ownership flag changed.
