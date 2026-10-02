# Event detail theme

`/e/:key` opts into the existing self-hosted base theme and a detail-only stylesheet, `public/event-theme.css`. Calendar and past-event listings stay on their existing shell. The purchased match overview's centered heading, compact metadata strip and lineup treatment map to event title/game, When/Where/going count, and member-only attendee links. No template artwork, third-party assets, framework or new island ships.

The shared `SiteHeader` retains the homepage's sign-in/logout controls. The cancelled route still returns before session reads: its themed header deliberately omits account controls. Route statuses, cache headers, authorization and attendee access logging are unchanged. Normal detail still renders JSON-LD, share metadata, calendar links, copy-link/toast and going-count mounts. Cancelled detail retains 410, noindex and EventCancelled JSON-LD without sharing, RSVP actions or attendee UI.

Existing previous/next and related-event behavior had already landed on main when this slice started. It is preserved and styled, not reimplemented. Empty discovery data renders no fake links or content. No RSVP behavior is added; the pre-existing implementation-dependent RSVP tests remain explicitly skipped.

## Verification

- `test/event-theme.test.ts`: scoped assets, shell landmarks, guest/member/waitlist rendering, escaped attendee links, decorative initials, cancelled exclusions and a 6 KB uncompressed detail-CSS cap.
- Existing event-page, attendee, navigation, session and island suites continue to exercise route/security contracts; attendee integration tests require the designated agent-testdb or CI service.
- `ci/a11y-cases.mjs` now includes going and waitlisted synthetic member journeys at both existing audit viewports. The isolated fixture seeds an actual full event and waitlist row; content assertions check the waitlist-position mount and attendee visibility before axe.
- `ci/a11y-interactions.mjs` checks first-Tab skip focus and hover contrast on normal/cancelled detail as well as home. It retains the existing 4.5:1 minimum. All fixture/browser requests remain local and off-origin requests are blocked.

Run `DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next npm run a11y` in a worker with the required Playwright system libraries. A browser launch failure is not an axe pass. The repository has no numerical Lighthouse budget configuration; do not describe CSS size checks or axe results as a Lighthouse pass.

Staging acceptance requires a verified deployed revision at `https://next.togetherweown.com`, isolated DB/guild targets and authorized synthetic event URLs. Local fixture screenshots are not staging evidence. The existing staging-isolation/restoration handoff must clear before authenticated staging journeys. Obtain independent exact-head review and green CI, and squash-merge; an opened PR alone is not delivery.
