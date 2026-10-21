# Event device-timezone visual evidence

Local synthetic **Chess night** fixture, start `2026-07-15T19:00:00.000Z`, host
`Europe/London`, browser `America/New_York`. No database or external requests.
The Hono images render the real HTTP detail route with in-memory reads and run
its shipped islands. The Kit images render the real resolver/component and
hydrate the real Svelte component using the same fixture seam as the independent
acceptance suite. They are local-fixture proof, not staging or deployment proof.

Captured on 2026-10-20 in Chromium, full page at viewport **1280×800** or
**390×844**. Every image was opened. All 12 after states were recaptured and
reopened after the final compact-button CSS and script-position fixes. The four
before images render archived source from `4c904d1ff656aa88512fb90bb02018b95cf7778d`
(the integration merge did not change production source), not a DOM with the new
control hidden. Styles and assets are from that source for before captures.
These are evidence images, not visual-test baselines.

| View / viewport | Before | Default | Converted | Unavailable |
| --- | --- | --- | --- | --- |
| Hono desktop | [Before](hono-1280-before.png) | [Default](hono-1280-default.png) | [Converted](hono-1280-converted.png) | [Fallback](hono-1280-fallback.png) |
| Hono mobile | [Before](hono-390-before.png) | [Default](hono-390-default.png) | [Converted](hono-390-converted.png) | [Fallback](hono-390-fallback.png) |
| Kit desktop | [Before](kit-1280-before.png) | [Default](kit-1280-default.png) | [Converted](kit-1280-converted.png) | [Fallback](kit-1280-fallback.png) |
| Kit mobile | [Before](kit-390-before.png) | [Default](kit-390-default.png) | [Converted](kit-390-converted.png) | [Fallback](kit-390-fallback.png) |

The host clock remains **20:00 GMT+01:00 (Europe/London)**. The activated device
comparison is **15:00 GMT-04:00 (America/New_York)** on the same full date. Fallback
uses unavailable Intl and points to the host schedule/calendar without claiming
success. Default activation is keyboard-accessible, not automatic. The browser
fixture's fixed current date does not change the server's current-date RSVP
closure; this past synthetic event therefore retains its existing past notice.

All 12 after captures also checked no horizontal overflow and no serious or
critical axe findings within `.event-meta`. The full Hono accessibility gate
passed separately. Existing Hono/Kit shell and theme differences are retained;
this feature's host text, comparison, fallback and activation behavior match.

For the design contract and member guidance, see
[Compare an event start with your device timezone](../../event-device-timezone.md).
The independent browser proof is `test/event-device-timezone.test.ts`, executed
with `A11Y_BROWSER_TESTS=true`; CI verifies all 30 browser cases actually ran.

## Pinned-runner baseline acceptance

[Browser-smoke run 39470046957](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39470046957)
rendered head `ce93e312cb009f883f8e347322e76d8bca8c3d8f` on the pinned runner.
Its `e2e-failure-39470046957-1` artifact contains four intentional baseline
changes: `event-desktop.png`, `event-mobile.png`, `event-paused-desktop.png` and
`event-paused-mobile.png`. Each page grows by 52 pixels for the new explicit
comparison action under the unchanged host schedule. The content below moves
down without other layout or content changes. The cancelled-page baselines do
not change.

Opened all four expected, actual and diff image sets, then accepted only these
four actuals with `node ci/visual-accept.mjs <artifact-dir>`, as prescribed by the
[visual-regression guide](../../visual-regression.md#when-a-diff-is-intentional).
No local recapture, test-code edit, new mask or threshold change was used. This
acceptance updates expected screenshots; it is not a passing rerun, deployment
or independent approval.

## Integrated native-island proof

The original capture set above records the initial implementation. After
integrating the independently shipped Starts/Ends schedule and replacing the
Kit hydration handler with the shared native island, captured and opened the
following twelve states on 2026-10-20. Same synthetic event and viewports; Kit
runs **without hydration**, matching its `csr=false` route. Each state has zero
serious/critical axe violations in `.event-meta`, no horizontal overflow and no
page errors. Keyboard activation retains focus and changes only the comparison.
These are local-fixture evidence, not pinned visual baselines or deployment proof.

| View / viewport | Default | Converted | Unavailable |
| --- | --- | --- | --- |
| Hono desktop | [Default](integrated-hono-1280-default.png) | [Converted](integrated-hono-1280-converted.png) | [Fallback](integrated-hono-1280-fallback.png) |
| Hono mobile | [Default](integrated-hono-390-default.png) | [Converted](integrated-hono-390-converted.png) | [Fallback](integrated-hono-390-fallback.png) |
| Kit desktop | [Default](integrated-kit-1280-default.png) | [Converted](integrated-kit-1280-converted.png) | [Fallback](integrated-kit-1280-fallback.png) |
| Kit mobile | [Default](integrated-kit-390-default.png) | [Converted](integrated-kit-390-converted.png) | [Fallback](integrated-kit-390-fallback.png) |

The shared island is loaded once per full page, and five deferred island tags
share one markup block in their original execution order. The formatter is no
longer duplicated in Kit's structural client chunk. The adjacent polite status
region needs no document-global identifier; both renderers retain the same
button name, keyboard behavior and live announcement.

The merge conflict in the four visual baselines retained this branch's
previously artifact-accepted bytes. The new combined Starts/Ends layout still
needs exact-head pinned-runner comparison and, if intentional differences are
reported, acceptance through the failure artifact. No local image above was
copied into a test baseline, and no mask or ceiling changed.
