# Homepage failure-notice and empty-schedule recovery: visual evidence

Captured and opened on 2026-10-21 using the actual Hono `Home` screen and the
actual Kit `+page.svelte` SSR, guest fixtures (54 members, 3 online, no
upcoming events), and local assets only. No real member, Discord request, or
external service was used. Before captures render base `fd286626`; after
captures render this change.

State A pairs `?n=signin_failed` with the empty schedule; state B pairs
`?n=signin_unavailable` with the unavailable schedule. Every capture is a
full-page shot at the named viewport. All twelve images were opened: the
before pair shows the bare notice and the plain card sentence; the after
captures show the "Try signing in again" retry link under the notice, the
linked "Join the Discord" (empty) or "The Discord" (unavailable) phrase inside
the card, and the unchanged guest CTA below the card. No horizontal document
overflow in any capture. These are manual visual evidence, not replacements
for the pinned-runner visual baseline comparisons.

| Surface | State | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- | --- |
| Hono | A before | [Sheet](hono-signin-failed-empty-desktop-before.png) | [Sheet](hono-signin-failed-empty-mobile-before.png) |
| Hono | A after | [Sheet](hono-signin-failed-empty-desktop.png) | [Sheet](hono-signin-failed-empty-mobile.png) |
| Hono | B after | [Sheet](hono-signin-unavailable-unavailable-desktop.png) | [Sheet](hono-signin-unavailable-unavailable-mobile.png) |
| Kit | A before | [Sheet](kit-signin-failed-empty-desktop-before.png) | [Sheet](kit-signin-failed-empty-mobile-before.png) |
| Kit | A after | [Sheet](kit-signin-failed-empty-desktop.png) | [Sheet](kit-signin-failed-empty-mobile.png) |
| Kit | B after | [Sheet](kit-signin-unavailable-unavailable-desktop.png) | [Sheet](kit-signin-unavailable-unavailable-mobile.png) |

Kit captures include the built Kit app stylesheet (identical hash before and
after: no style change) plus the charset from its real document shell. The
existing Hono accessibility and Lighthouse gates do not exercise the Kit home
route; Kit parity for the new links is pinned by the acceptance suite's real
`+page.svelte` SSR renders. No changed staging or production behavior is
claimed by these local images.
