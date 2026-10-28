# Expired RSVP recovery evidence

## Design contract

- **Audience and screen job:** a member submitting an RSVP from a page whose session has expired must understand the refusal and recover without believing the answer saved.
- **Primary action:** follow the existing sign-in recovery, return to the event, review and explicitly submit again. A guest keeps the existing join link.
- **Content and references:** the real fixture event is “Friday night games.” Reuse the [shared recovery journey](../../../src/write-recovery.tsx), [RSVP component](../../../src/events/rsvp-button.tsx) and [existing event shell](../../../src/events/pages-detail.tsx); no new visual direction.
- **Layout, typography and tokens:** unchanged. Retain the event shell, existing alert, link text, focus ownership and theme tokens. At 1280×800 and 390×844, the existing responsive flow must remain usable without horizontal overflow.
- **Required states:** expired island refusal, recovery explanation, restored-session resubmit banner, native-form recovery and bare guest refusal.
- **Non-goals:** new RSVP semantics, automatic replay, new notifications, session-lifetime changes or layout redesign.

## Captures

Full-page captures use the real Hono app through the existing local accessibility fixture worker, an owned disposable schema, synthetic identities and blocked off-origin browser requests. Desktop viewport: 1280×800. Mobile viewport: 390×844.

| State | Desktop | Mobile |
| --- | --- | --- |
| Before: baseline island | [Image](before-expired-1280.png) | [Image](before-expired-390.png) |
| After: recovery-aware island | [Image](after-expired-1280.png) | [Image](after-expired-390.png) |
| Shared recovery landing | [Image](recovery-landing-1280.png) | [Image](recovery-landing-390.png) |
| Restored-session banner | [Image](restored-banner-1280.png) | [Image](restored-banner-390.png) |

Before and after refusal images are intentionally visually identical: this change fixes the link destination, not its styling. The before image runs the baseline shipped island from `ce1ade0c4` on the same fixture app. The after image runs this change's shipped island. [Browser assertions](capture-report.json) record the join-to-recovery link difference, exactly one mutation request per activation and no confirmed RSVP. The no-JavaScript form also reaches the recovery landing with exactly one POST at both widths.

The restored banner uses the callback's signed restored-cookie fixture and a fresh fixture session. It is **not** a live Discord OAuth exchange. The landing is reached by clicking the real recovery link and sets the pending notice; the application consumes the restored notice on the event GET. Both widths were opened and visually reviewed. No visual-regression baseline was changed.

Repeatable automated behavior proofs live in `test/rsvp-expired-session-acceptance.test.ts`, `test/rsvp-expired-write-destination-acceptance.test.ts`, `test/islands-rsvp-expired-session-acceptance.test.ts` and `ci/rsvp-focus-browser.test.mjs`. The separate screenshot driver reuses `ci/a11y.mjs` fixture setup; the capture report distinguishes the simulated callback from real route interactions.
