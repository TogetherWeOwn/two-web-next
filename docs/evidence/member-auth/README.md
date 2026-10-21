# Member-document liveness UI evidence

## Contract

Authenticated members must retain a readable member board and a reachable
self-profile draft when sign-out is refused or cannot be confirmed. Reuse the
existing auth-status controller, copy, focused alerts and ten-second deadline.
Keep the existing shell, typography, colors, responsive behavior and route holds.
The primary action remains **Sign out**, with an honest retry after failure.
No redesign, new controller, session renewal or public-layout session read.

References: [existing controller](../../../assets/islands/auth-status.js),
[Kit shell](../../../web/src/lib/Shell.svelte),
[held profile view](../../../web/src/lib/ProfileView.svelte).
These are implementation references, not new visual-direction approval.

## Capture and limitations

All 20 images were captured and opened at 1280×800 and 390×844, using real Svelte
SSR components, the real dispatch/session/audit plumbing, hermetic memory data,
and the shipped minified islands. Browser routes fulfilled local assets and
fixture responses only; every capture asserts no external request or page error.
`capture-receipt.json` records each state and the compiled Kit root stylesheet.

The native Kit root layout adds only its compiled `app.css`. Captures append
that generated stylesheet after the component head, matching Kit's ordering.
The fixture's extra `/styles.css` link was removed: the board retains its own
native CSS links; the held profiles do not acquire theme/profile CSS absent from
the authored component. Their sparse styling is pre-existing and is not repaired
or concealed by this change. Profile rollout stays held.

Before images execute the historical dispatcher and signer from
`1ac4be794887e97a185003b204836c122ca58b00`; Svelte components and styles are unchanged
between before and after. Healthy documents are visually identical. Changed
images execute the added member-document integration. Refusal uses a synthetic
503; uncertainty holds response headers past 10 seconds; the expired-draft state
revokes the memory session and executes the real probe and dirty-draft veto.

This is **real Kit SSR/component evidence with native compiled CSS**, not a
full adapter-built Worker, staging or production observation. Hono-only
Lighthouse, accessibility and visual-baseline gates do not exercise Kit pages.
No regression baseline was accepted, replaced or regenerated.

## Screenshots

| State | Desktop | Mobile |
| --- | --- | --- |
| Board before | [1280](before-board-1280.png) | [390](before-board-390.png) |
| Board healthy after | [1280](after-board-1280.png) | [390](after-board-390.png) |
| Board refused sign-out | [1280](board-logout-refused-1280.png) | [390](board-logout-refused-390.png) |
| Board unconfirmed sign-out | [1280](board-logout-unconfirmed-1280.png) | [390](board-logout-unconfirmed-390.png) |
| Held self profile before, dirty draft | [1280](before-self-1280.png) | [390](before-self-390.png) |
| Held self profile healthy after, dirty draft | [1280](after-self-1280.png) | [390](after-self-390.png) |
| Held self profile refused sign-out | [1280](self-logout-refused-1280.png) | [390](self-logout-refused-390.png) |
| Held self profile unconfirmed sign-out | [1280](self-logout-unconfirmed-1280.png) | [390](self-logout-unconfirmed-390.png) |
| Held self profile expired, retained draft | [1280](self-expired-draft-1280.png) | [390](self-expired-draft-390.png) |
| Held other profile healthy after | [1280](after-other-1280.png) | [390](after-other-390.png) |

Observed: feedback is readable at both widths; the board header grows without
covering its content; focused refusal/uncertainty alerts do not navigate; the
profile draft remains visible and unchanged. Native profile styling remains a
separate held-route concern, not a visual-parity claim here.
