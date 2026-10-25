# Schedule account chrome: browser evidence

## Design contract

- **Audience/job:** signed-in viewers who have not joined the Discord guild yet; regression states are guests and members. The `/events` header names the viewer correctly. No layout or flow change.
- **Primary action:** unchanged (browse the schedule). Side effect: Sign out becomes reachable on `/events` for non-members, as on every other session-aware page.
- **Real content:** the viewer's session username plus the existing Sign out form. Zero new markup: this reuses the `SiteHeader` session branch every other session-aware shell already renders.
- **References:** sibling `EventDetailShell` session threading; no new visual direction.
- **Layout/type/tokens:** unchanged. Reuses `.header-account` / `.who` / `.link` styles.
- **Responsive:** unchanged markup inherits existing responsive behavior; verified at 1280x800 and 390x844 for all three states.
- **Required states:** guest byte-identical (sign-in CTA); member byte-identical (`Open Discord`, no board link); non-member gets `Signed in` + username + Sign out.
- **Non-goals:** `/events/past` untouched (session-free shared cache by design); no `SiteHeader` redesign (type-only widening); no auth-flow, caching-posture, threshold, or route-ownership change; no new read or query.

## Captures

Real `/events` Hono route HTML served locally with production static assets and offline fixtures (`shots.example.test` origin); no production or staging database was used. Before captures use `b3fe9b2d2`; after captures use this change (later commits on the branch are test-only and change no rendered byte, verified by `git diff 9b665923b..HEAD --name-only`). Every image below was opened for visual inspection. These are review evidence, not regenerated visual-test baselines.

| Viewer | Desktop, 1280 x 800 | Mobile, 390 x 844 |
| --- | --- | --- |
| Before: guest | [PNG](before-guest-1280.png) | [PNG](before-guest-390.png) |
| Before: member | [PNG](before-member-1280.png) | [PNG](before-member-390.png) |
| Before: non-member | [PNG](before-nonmember-1280.png) | [PNG](before-nonmember-390.png) |
| After: guest | [PNG](after-guest-1280.png) | [PNG](after-guest-390.png) |
| After: member | [PNG](after-member-1280.png) | [PNG](after-member-390.png) |
| After: non-member | [PNG](after-nonmember-1280.png) | [PNG](after-nonmember-390.png) |

## Byte comparison

`cmp` on the PNG pairs: guest before/after identical at both widths, member before/after identical at both widths, non-member differs at both widths. The rendered HTML diff for the non-member page is confined to the `<nav class="header-account" aria-label="Account">` block: the guest `<div>` (Welcome caption + sign-in link) becomes the standard session `<form method="post" action="/logout">` (Signed in caption + username span + Sign out submit). Member and guest HTML are `cmp`-identical before/after.

## Keyboard, no-JS, labels

Sign out is a native POST form with a submit button, so it is keyboard-operable and works without JavaScript. The `Account` nav label, skip link, `aria-current`, and all other labelled controls are unchanged. No new markup means no new accessible names to audit.
