# Host/join stale-save correction

## Design contract

Audience: moderators editing an existing event. Screen job: review and save all
twelve editable values without overwriting another moderator's changes. Save
remains the primary action; a refused save keeps the typed draft and links to the
current values.

References: the existing [Hono event fields](../../../src/admin/pages/event-form-fields.tsx),
[shared field renderer](../../../src/admin/pages/event-host-join-fields.tsx), and
[Kit edit page](../../../web/src/routes/admin/events/%5Bkey%5D/+page.svelte).
No new visual direction. Organizer display name, Public joining link and Public
joining instructions use the Hono labels, privacy hints, native input types and
text-limit hooks, between Location and Capacity. Existing `.field`, `.hint` and
`.error` rules supply layout and typography. The single-column form wraps at
1280×800 and 390×844 with no new width rules.

Required states: stored values, null/empty values, escaped untrusted text,
validation errors, and stale refusal with the host/join draft retained. No new
framework, Kit mutation route, hydration, schema, grant, or validation policy.

## Implementation boundary

The content-derived baseline covers organizer name, joining URL and joining
instructions as well as the original nine fields. Missing optional fixture
columns normalize to null, just as stored defaults do. The compare still runs
inside the committing row lock.

Both renderers use the same Hono `EventHostJoinFields` component. The Kit read
model retains the raw field values and supplies an application-generated escaped
HTML fragment to the Svelte form. The fragment is not stored or caller-supplied
HTML. Reusing the server renderer avoids compiling duplicate field templates into
Kit's unhydrated structural client node. Hono owns every write and error render.

## Opened browser evidence

All six images were opened for visual review. Kit pairs compile the real Svelte
page and AdminShell using the locked compiler, with the same root CSS produced by
the Kit build and the public author sheet. The before page uses the pre-correction
source. The conflict page is the actual Hono 409 response against an isolated,
disposable Postgres fixture. Content and identities are synthetic. These are
local-fixture screenshots, not deployment proof or visual-test baselines.

| State | Desktop, 1280×800 | Mobile, 390×844 |
| --- | --- | --- |
| Kit before: host/join fields absent | [Before](before-1280.png) | [Before](before-390.png) |
| Kit after: all stored values visible | [After](after-1280.png) | [After](after-390.png) |
| Hono conflict: typed draft kept | [Conflict](conflict-1280.png) | [Conflict](conflict-390.png) |

The actual rendered Kit form was serialized with browser `FormData` and submitted
to Hono: 303, with all three stored fields preserved. After another save changed
only the joining URL, submitting the stale form returned 409; the complete stored
row was unchanged and the typed organizer/instructions remained in the response.
The three new controls are focusable. All six captures have no horizontal overflow.

## Accessibility and budget observations

The Hono conflict response has zero axe violations at both widths. The Kit
before **and** after captures expose a pre-existing `color-contrast` violation
under the root dark canvas: the brand, hints, footer and Cancel event link use
legacy light-canvas colors. The new hints inherit the same issue. This is not
reported as an axe pass, and no axe rule is disabled. A separate admin-theme
follow-up owns that existing problem; this correction changes no stylesheet.
Hono accessibility/Lighthouse/visual gates do not exercise the Kit route.

The locked Kit build fits every existing ceiling without a budget edit: client
JavaScript 51/51 files, raw 241874/242176 bytes, gzip 97279/97536; server JavaScript
120/120 files, raw 1077583/1203200, gzip 317517/327680. No baseline, mask, audit or
threshold is changed. Exact-head CI remains authoritative for the pinned-runner
visual comparisons and merge gates. The corrected revision has not been opened
on staging; staging verification follows deployment.
