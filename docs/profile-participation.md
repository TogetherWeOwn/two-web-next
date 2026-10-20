# Profile to event navigation

## Short UI contract

- **Audience / screen job:** signed-in members viewing their own or another permitted member's profile. Make the existing event journey discoverable without losing a profile draft.
- **Primary action:** a native, server-rendered **Events** link to `/events` in primary navigation, beside Your profile. It remains outside the optional onboarding and editor panels.
- **Real content:** preserve the new-member heading, body and **Add profile details** edit anchor. Add a distinct **Find an event** link alongside it. Do not imply that profile completion is required to browse events or that an RSVP means attendance.
- **References / assumptions:** the [existing Hono profile shell](../src/profiles/pages.tsx), [Kit profile view](../web/src/lib/ProfileView.svelte) and [event destination](../src/events/pages.tsx) are the references. Reuse their visual direction rather than introduce a new one.
- **Layout / typography / tokens:** keep the profile theme, display headings, body text, colors and button treatments. Use secondary treatment for the new navigation and onboarding event links. Allow the existing primary-navigation flex row to wrap; group onboarding actions with a centered, wrapping row and the existing action gap.
- **Responsive / keyboard:** native anchors work without JavaScript at 1280×800 and 390×844, remain inside the viewport, retain visible keyboard focus and activate with Enter. Narrow onboarding actions wrap instead of shrinking targets.
- **Required states:** new owner, completed owner, permitted other member and moderator in both renderers; successful save, reopened editor, explicit Cancel/reset, invalid native save and refused dirty departure. Moderator shortcuts and sign-out remain unchanged. Only owners see onboarding/edit controls.
- **Non-goals:** profile redesign, completion scoring, personalization, tracking, new reads, new permissions, account-state rules, attendance inference, auth/session changes or new mutation routes.

## Opened Hono screenshots

Captured from the real Hono profile routes over a local socket with synthetic memory-store fixtures and shipped CSS/fonts/islands. Each image was opened for visual review. These are full-page captures with the stated viewport, not baseline replacements.

| State / viewport | Before | After |
| --- | --- | --- |
| New owner, 1280×800 | [Before](images/profile-participation/before-new-owner-1280.png) | [After](images/profile-participation/after-new-owner-1280.png) |
| New owner, 390×844 | [Before](images/profile-participation/before-new-owner-390.png) | [After](images/profile-participation/after-new-owner-390.png) |
| Completed owner, 1280×800 | [Before](images/profile-participation/before-completed-owner-1280.png) | [After](images/profile-participation/after-completed-owner-1280.png) |
| Completed owner, 390×844 | [Before](images/profile-participation/before-completed-owner-390.png) | [After](images/profile-participation/after-completed-owner-390.png) |

Events remains in the header in all four captures. The new-owner actions sit side by side on desktop and wrap into distinct centered targets on mobile. Completed profiles have no visible onboarding panel. Additional local captures cover other-member and moderator headers at both widths; all have no horizontal overflow. No screenshot baseline changed.

## Implementation and verification boundaries

The two profile renderers emit the links directly. The existing owner and `profileIsNewMember` rules still determine onboarding visibility. The primary Events link survives hidden onboarding/editor panels. Save never navigates automatically; the existing island owns draft-departure warnings and reset behavior.

Independent acceptance uses synthetic fixtures, real Hono routes, the Kit dispatcher/loaders and compiled Svelte SSR. Browser cases exercise native links, keyboard navigation, narrow layouts and the shipped profile island. They witness the existing keyed profile read and optional stats read, reject extra data fetches and preserve self-only writes and audited other-member reads.

Hono accessibility/Lighthouse/visual gates do not exercise a Kit route. Kit component/loader/browser evidence is separate; it is not proof that production serves Kit-owned profile reads. Profile route ownership and release configuration are unchanged. Record exact-head CI/review and staging/production release evidence separately from local fixture screenshots. No visual baseline or budget change is intended.

### Kit evidence and existing layout limitation

The local Kit fixture runs the actual dispatcher, profile server loaders and compiled Svelte SSR with memory dependencies. It is not the complete built SvelteKit Worker. The profile read entries remain disabled in the shipped ownership manifest; mutations still belong to Hono.

Separate captures below attach the **actual compiled Kit root-layout CSS**, served as an external stylesheet so the existing CSP remains effective. They expose a pre-existing limitation: `ProfileView` owns its head metadata and does not link the public profile sheets, while the root layout supplies tokens/canvas rather than profile layout rules. Native Events links render and fit at both widths, but these images are **not a styled-profile parity pass**. Restoring that existing stylesheet wiring before enabling Kit profile reads is separate work; this navigation change does not enable those reads or alter shared metadata.

| Kit SSR state | 1280×800 | 390×844 |
| --- | --- | --- |
| New owner | [Opened capture](images/profile-participation/kit-new-owner-1280.png) | [Opened capture](images/profile-participation/kit-new-owner-390.png) |
| Completed owner | [Opened capture](images/profile-participation/kit-completed-owner-1280.png) | [Opened capture](images/profile-participation/kit-completed-owner-390.png) |

Additional before/after Kit component images with deliberately supplemented public profile CSS were opened to inspect the shared action layout. Those are explicitly supplemental styling studies, not faithful current-route screenshots or deployed-runtime evidence.
