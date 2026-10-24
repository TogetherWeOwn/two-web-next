# Auth failure-notice recovery: visual evidence

## Design contract (written before implementation)

- **Audience:** a member whose Discord approval start failed (join) or who
  cancelled sign-in (home); desktop and mobile, keyboard and no-JS included.
- **Screen job:** explain the failure in place and offer the retry path —
  no silent bounce, no dead end.
- **Primary action:** join banner → the unchanged one-click "Join with
  Discord" below it; denied notice → the same "Try signing in again" link
  (`/auth/discord`) the failed/unavailable notices already carry.
- **Real content:** join banner "The Discord approval failed to start — try
  again below." (byte-identical to the Hono sentence); denied sentence
  unchanged, existing retry copy reused verbatim.
- **References:** Hono `/join` banner bytes (`src/screens/join.tsx`) as the
  reference implementation; the existing `notice-retry` link under
  `signin_failed` (see `docs/evidence/home-failure-recovery/`) as the
  reference treatment. No new visual direction.
- **Layout, typography, tokens:** reuse `.notice` + `role="status"` exactly;
  no new CSS, tokens, or layout — the inserted banner row/paragraph is the
  same pattern sibling notices already use.
- **Responsive:** banner is a plain in-flow `<p>`; verified 1280×800 and
  390×844 on both states and both renderers with no overflow.
- **Required states:** (1) Kit `/join?notice=start-failed` renders the
  banner; plain/hostile values render the byte-identical plain page.
  (2) `?n=signin_denied` renders notice + retry link on both renderers;
  all sibling notices unchanged.
- **Non-goals:** no new notice kinds, no copy rewrite, no OAuth/session/
  cookie/redirect/cache change, no route-ownership change, no threshold
  change.
- **Accessibility:** `role="status"` announces the banner on load; the retry
  is a plain anchor (keyboard-focusable, works with scripts disabled).

## Captures

Captured and opened on <DATE> using the actual Hono screens and the actual
Kit SSR, guest fixtures and local assets only. No real member, Discord
request, or external service was used. Before captures render base
<BASE>; after captures render this change.

State A is Kit `/join?notice=start-failed`; state B is `?n=signin_denied`
on both home twins. Every capture is a full-page shot at the named
viewport. All images were opened: the before pair shows the plain join
page and the bare denied notice; the after captures show the
`join-start-notice` banner above the join layout and the "Try signing in
again" retry link under the denied notice. No horizontal document
overflow in any capture.

| Surface | State | Desktop (1280×800) | Mobile (390×844) |
| --- | --- | --- | --- |
| Kit join | A before | [Sheet](kit-join-start-failed-desktop-before.png) | [Sheet](kit-join-start-failed-mobile-before.png) |
| Kit join | A after | [Sheet](kit-join-start-failed-desktop.png) | [Sheet](kit-join-start-failed-mobile.png) |
| Hono home | B before | [Sheet](hono-signin-denied-desktop-before.png) | [Sheet](hono-signin-denied-mobile-before.png) |
| Hono home | B after | [Sheet](hono-signin-denied-desktop.png) | [Sheet](hono-signin-denied-mobile.png) |
| Kit home | B before | [Sheet](kit-signin-denied-desktop-before.png) | [Sheet](kit-signin-denied-mobile-before.png) |
| Kit home | B after | [Sheet](kit-signin-denied-desktop.png) | [Sheet](kit-signin-denied-mobile.png) |

The existing Hono accessibility and Lighthouse gates do not exercise the
Kit routes; Kit parity for the new markup is pinned by the acceptance
suites' real-load and real-SSR renders. No changed staging or production
behavior is claimed by these local images.
