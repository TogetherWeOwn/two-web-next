# Event device-timezone Ends visual evidence

Local synthetic **Chess night** fixture, end `2026-07-15T19:00:00.000Z`
(start two hours earlier), host `Europe/London`, browser
`America/New_York`. No database or external requests. The Hono images render
the real HTTP detail route with in-memory reads and run its shipped islands.
The Kit images render the real resolver/component and hydrate the real Svelte
component using the same fixture seam as the independent acceptance suite.
They are local-fixture proof, not staging or deployment proof.

Captured on 2026-10-21 in Chromium at viewport **1280×800** or **390×844**.
Every image was opened. The four before images render archived source from
the merge base (the Ends mount absent, no Starts testids), served with the
same styles and assets as the after captures. The no-JS before/after pairs
are byte-identical (`cmp`). These are evidence images, not visual-test
baselines.

| View / viewport | Before (no-JS) | After (no-JS) | Default (JS) | Ends converted |
| --- | --- | --- | --- | --- |
| Hono desktop | [Before](hono-1280-before.png) | [No-JS](hono-1280-nojs.png) | [Default](hono-1280-default.png) | [Converted](hono-1280-converted.png) |
| Hono mobile | [Before](hono-390-before.png) | [No-JS](hono-390-nojs.png) | [Default](hono-390-default.png) | [Converted](hono-390-converted.png) |
| Kit desktop | [Before](kit-1280-before.png) | [No-JS](kit-1280-nojs.png) | [Default](kit-1280-default.png) | [Converted](kit-1280-converted.png) |
| Kit mobile | [Before](kit-390-before.png) | [No-JS](kit-390-nojs.png) | [Default](kit-390-default.png) | [Converted](kit-390-converted.png) |

The host end clock remains **20:00 GMT+01:00 (Europe/London)**. The activated
Ends comparison is **15:00 GMT-04:00 (America/New_York)** on the same full
date, and the Starts comparison stays empty. Default shows both actions with
the Starts shape reused verbatim under Ends. The unavailable path reuses the
Starts copy and is covered by the browser suite's seven Intl-failure cases
per renderer, not by a separate shot.

All eight after captures also checked no horizontal overflow, no page errors
and zero serious/critical axe findings within `.event-meta`. The Kit captures
render without the built token stylesheet (the SSR harness serves the
component without the release CSS bundle), so they show the unthemed
structure; the mount markup, host text, comparison and activation behavior
match Hono. The broken header logo is a fixture asset-path artifact, identical
before and after.

For the design contract and member guidance, see
[Compare event times with your device timezone](../../event-device-timezone.md).
The independent browser proof is `test/event-device-timezone-ends.test.ts`,
executed with `A11Y_BROWSER_TESTS=true`; CI verifies all 30 browser cases
actually ran. The Starts proof lives in
[the Starts evidence](../event-device-timezone/README.md).
