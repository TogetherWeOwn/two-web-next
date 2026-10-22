# Cancelled-event alternatives fixture evidence

## Design contract

- **Audience and screen job:** members following a cancelled-event link need to find another upcoming event without confusing it with the cancelled one.
- **Primary action:** See upcoming events. Keep the calendar download and event back link.
- **Content:** Chess night is cancelled; alternatives are Chess finals (New York, with location) and Summer chess (Tokyo, no location). Millisecond start instants exercise the machine-readable contract.
- **References:** the existing [missing-event presentation](../../../web/src/lib/EventMissing.svelte), [gone presentation](../../../web/src/lib/EventGone.svelte) and [event theme](../../../public/event-theme.css). Reuse these rather than introduce a new visual direction.
- **Layout, typography and tokens:** keep the existing event hero, cards, theme tokens and type. Put the recovery actions before a labelled, second-level alternatives section; the new section inherits existing section spacing and divider rules. No stylesheet changes.
- **Responsive behavior:** use the current flowing card layout at 1280×800 and 390×844. Long date/location text wraps within the card.
- **Required states:** two alternatives, no alternatives, and missing-event recovery. Hide the alternatives heading and list when empty; retain the primary action and calendar download.
- **Non-goals:** changing displayed time zones, end times, Hono output, RSVP/access policy, routing, cache keys, or the 404 presentation.

## Capture method and limitations

Captured on 2026-10-20 in Chromium using the real SSR-compiled Svelte components, the built Kit stylesheet, and local copies of public styles, fonts and images. A bounded loopback fixture server returned the rendered documents. No live data or database was used. The fixture driver compared the active detail loader's gone model with the event-state resolver's model, including both full instants.

The before component source is from `ce1ade0c489e652e9debf5e476d1a40877daf6f7`. The after component uses this change. Each PNG is a full-page capture at the named viewport; all eight images were opened for visual review. These are component-fixture screenshots, not a deployed Kit Worker or hydration test. The shipped event-detail ownership remains Hono, so staging does not yet expose this Kit extension.

| State | Desktop | Mobile |
| --- | --- | --- |
| Before, two alternatives | [Before desktop](gone-before-desktop.png) | [Before mobile](gone-before-mobile.png) |
| After, two alternatives | [After desktop](gone-after-desktop.png) | [After mobile](gone-after-mobile.png) |
| After, empty alternatives | [Empty desktop](gone-empty-desktop.png) | [Empty mobile](gone-empty-mobile.png) |
| Unchanged missing-event recovery | [Missing desktop](gone-missing-desktop.png) | [Missing mobile](gone-missing-mobile.png) |

The [browser report](browser-report.json) records all eight fixture visits: no horizontal overflow, uncaught page errors or axe violations. The after fixture also checks the two link testids/destinations, full `<time datetime>` values, the region's accessible name, and programmatic link focus. It does not prove keyboard traversal or navigation after activation.

## Regression proof

The acceptance-owned `test/kit-gone-alternatives-acceptance.test.ts` was consumed at `9be20305` (SHA-256 `0a81ca9bb88441c9b015e325ce71ec5f3c639a67c9d3a4262654a11021ebabf3`). Its initial run had 5 expected failures and 3 passing controls; after implementation all 8 passed. A later helper-only edit replaced the regex tag-strip with an output-equivalent token-walk to clear CodeQL (assertions unchanged); a further pin-only edit re-captured the Hono 410 baseline after main's deliberate mirror (cases unchanged). The file now hashes to `d6fae8bb657d7d0f543b1ebabccead21d67888c32ed7e99399e728d407c47b12`. The Hono 410 fixture now hashes to `3eab9ef334293582d9ce31fb082e9c2dd0e97172e2f9e99da7e8af0f14b82792` (re-captured with main `71c0ec4e0` merged; Hono source unchanged from that main commit); missing suggestions and empty recovery controls pass.

Run the focused regression set with database variables unset:

```sh
npm test -- test/kit-gone-alternatives-acceptance.test.ts test/kit-event-states.test.ts test/kit-event-detail.test.ts test/kit-event-attendees-live-island-acceptance.test.ts
```

Observed result: 4 files, 89 tests passed. Existing Hono Lighthouse, accessibility and visual-baseline gates do not exercise the Kit error component. No visual baselines or quality budgets changed.
