# Featured-list unpublish visual evidence

Captured and opened on 2026-10-26. These are local fixtures, not a deployed-release claim.

## Design contract

- **Audience/job:** moderators inspecting the featured inventory and urgently withdrawing a slot, even when an unrelated saved field fails current validation.
- **Primary action:** native **Unpublish** POST below the published row's title; retain the title's edit link. Use the existing button, focus treatment, typography and shell tokens. No new JavaScript or CSS.
- **References:** the existing Hono featured inventory, its Kit twin, and the sibling single-record POST delete action. Existing layout and interaction conventions are the design assumptions.
- **Layout/responsiveness:** keep five columns, ordering, filters, windows and pagination. The action stays in the first column so it is reachable without horizontal scrolling at 390px. Secondary columns remain in the existing keyboard-scrollable table. No document-level horizontal overflow at either width.
- **States/content:** live community welcome, scheduled game night, expired announcement and unpublished draft. The fixture includes a saved unapproved image host. All three stored-published rows offer the action; the draft does not. A successful withdrawal removes that row's action and changes its badge to unpublished. Empty filtered results retain their recovery link.
- **Non-goals:** publish/republish, bulk actions, scheduling, reordering, edit validation, stylesheet changes or budget allowances.

## Captures

Every linked image was captured and opened, not inferred from a DOM snapshot.

| Stack/state | 1280×800 viewport | 390×844 viewport |
| --- | --- | --- |
| Hono before | [Before](hono-before-mixed-1280x800.png) | [Before](hono-before-mixed-390x844.png) |
| Hono after, mixed publication/window states | [After](hono-after-mixed-1280x800.png) | [After](hono-after-mixed-390x844.png) |
| Hono after native withdrawal | [Withdrawn](hono-after-withdrawn-1280x800.png) | [Withdrawn](hono-after-withdrawn-390x844.png) |
| Hono empty filtered results | [Empty](hono-after-empty-1280x800.png) | [Empty](hono-after-empty-390x844.png) |
| Kit before | [Before](kit-before-mixed-1280x800.png) | [Before](kit-before-mixed-390x844.png) |
| Kit after, mixed publication/window states | [After](kit-after-mixed-1280x800.png) | [After](kit-after-mixed-390x844.png) |
| Kit after native withdrawal | [Withdrawn](kit-after-withdrawn-1280x800.png) | [Withdrawn](kit-after-withdrawn-390x844.png) |
| Kit empty filtered results | [Empty](kit-after-empty-1280x800.png) | [Empty](kit-after-empty-390x844.png) |

Screenshots are full-page captures at the named viewport sizes. No visual baselines or masks were changed.

## Execution and limitations

A bounded local HTTPS fixture server served the real Hono `adminApp`, a memory moderator session and an isolated disposable Postgres schema. Kit used its real built `Server/respond`, root/admin layouts, leaf component and emitted styles; only hooks and data-load bindings were fixture seams. List data came from the shared inventory read model. Both native buttons POSTed through the real Hono action and followed its 303 back to their list. The secure cookie jar retained session rotation. Browser fixtures do not prove deployed routing or the production environment.

The Hono pages had zero serious/critical axe findings at both widths, before and after. The new action forms also had zero serious/critical findings in either stack. Whole-page Kit scans found the same pre-existing `color-contrast` rule failure before and after, on the admin brand and status badges against the Kit dark background. This change does not alter those surfaces; no rule was disabled or threshold lowered. It is not a claim that the whole Kit page passes accessibility.

Hono a11y/Lighthouse gates do not exercise the Kit route. The committed visual regression configurations refuse execution outside the pinned GitHub Actions runner; that guard was preserved, not forged. CI must execute those suites on the exact implementation head. Local screenshots are additional evidence, not substitutes for those gates or staging verification.
