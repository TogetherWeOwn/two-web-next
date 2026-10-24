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

Both renderers use the same Hono `EventHostJoinFields` and `EventNotesField`
components. The Kit read model retains the raw field values and supplies
application-generated escaped HTML fragments to the Svelte form. These are not
stored or caller-supplied HTML. Reusing the server renderer avoids compiling
duplicate field templates into Kit's unhydrated structural client node. Hono owns
every write and error render. The required view bindings are direct, the fixed
hidden carrier is a static attribute, and the two progressive scripts share one
HTML slot without changing their order. The real rendered-form POST tests pin the
carrier name against the shared Hono constant.

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

The initial correction's locked Kit build fits the existing ceilings: client
JavaScript 51/51 files, raw 241874/242176 bytes, gzip 97279/97536; server JavaScript
120/120 files, raw 1077583/1203200, gzip 317517/327680.

A subsequently confirmed base conflict brings in the admin 429 recovery UI.
Copying current main's numeric ceilings unchanged, the combined tree initially
fails at client raw 243099/242176 and gzip 97801/97792. Instead of adding an
allowance, the notes field now also reuses the Hono server renderer, and redundant
client binding/slot overhead is removed as described above. Two locked builds
measure client 51/51 files, raw **242175/242176**, gzip **97551/97792**; server
120/120 files, raw 1081782–1081814/1203200, gzip 318685–318693/327680. The raw
margin is only one byte; it is reported, not padded with a ceiling increase.
Every numeric ceiling equals current main's values. All six refreshed screenshots
are byte-identical to the opened captures above, and the actual serialized form
save/conflict proof passes again.

No baseline, mask, audit or threshold is changed. Exact-head CI remains
authoritative for the pinned-runner visual comparisons and merge gates. The
corrected revision has not been opened on staging; staging verification follows
deployment.
