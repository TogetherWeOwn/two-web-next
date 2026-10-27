# Event chosen-timezone range visual evidence

Local synthetic **Chess night** fixture, start `2026-07-15T19:00:00.000Z`, end
`2026-07-15T21:00:00.000Z`, host `Europe/London`, browser device
`America/New_York`. No database or external requests. The Hono images render the
real HTTP detail route with in-memory reads and run its shipped islands. The Kit
images render the real resolver/component and hydrate the real Svelte component
using the same fixture seam as the independent acceptance suite. They are
local-fixture proof, not staging or deployment proof.

Captured on 2026-10-24 in Chromium, full page at viewport **1280×800** or
**390×844**. Every image was opened. The four before images render archived
source from `898f6427815dc5fcf73d3e4edf4e91bf0b7c5849` (pre-change HEAD; the
acceptance merge added test files only), not a DOM with the new control hidden.
Styles and assets are from that source for before captures. These are evidence
images, not visual-test baselines.

| View / viewport | Before | Default | Converted | Fallback | No-JS |
| --- | --- | --- | --- | --- | --- |
| Hono desktop | [Before](hono-1280-before.png) | [Default](hono-1280-default.png) | [Converted](hono-1280-converted.png) | [Fallback](hono-1280-fallback.png) | [No-JS](hono-1280-nojs.png) |
| Hono mobile | [Before](hono-390-before.png) | [Default](hono-390-default.png) | [Converted](hono-390-converted.png) | [Fallback](hono-390-fallback.png) | [No-JS](hono-390-nojs.png) |
| Kit desktop | [Before](kit-1280-before.png) | [Default](kit-1280-default.png) | [Converted](kit-1280-converted.png) | [Fallback](kit-1280-fallback.png) | [No-JS](kit-1280-nojs.png) |
| Kit mobile | [Before](kit-390-before.png) | [Default](kit-390-default.png) | [Converted](kit-390-converted.png) | [Fallback](kit-390-fallback.png) | [No-JS](kit-390-nojs.png) |

The host clock remains **20:00–22:00 GMT+01:00 (Europe/London)**. Converted
captures type `Asia/Tokyo` and activate **Compare times**: both instants render
**Thursday, 16 July 2026 at 04:00/06:00 GMT+09:00**, proving rollover, an
explicit zone identifier and per-instant offsets with no device-zone leak (the
device reads New York). Fallback captures type `Mars/Olympus_Mons` and show
honest guidance pointing back at the host schedule and calendar links without
claiming success. Default captures convert nothing on load or typing. No-JS
captures keep the complete host schedule and calendar links with the mount
hidden. Keyboard activation (Tab to Compare, Enter) is proven by the browser
acceptance suite; focus stays on the button and the polite status announces the
result.

All 16 scripted captures checked no horizontal overflow and no page errors.
With JavaScript enabled, each capture also ran axe over `.event-meta` with zero
serious or critical findings. (No-JS states cannot run axe; their check is the
screenshot plus the empty page-error list.) The full Hono accessibility gate
passed separately. Existing Hono/Kit shell and theme differences are retained;
this feature's host text, comparison, fallback and activation behavior match.

For the member guidance, see
[Compare event times with your device timezone](../../event-device-timezone.md).
The independent browser proof is `test/event-chosen-timezone.test.ts`, executed
with `A11Y_BROWSER_TESTS=true`; CI verifies all 38 browser cases actually ran
(minimum 30).

## Pinned-runner baseline acceptance

The new compare row changes the event detail baselines on the pinned runner.
Accept the intentional `event-desktop`, `event-mobile`, `event-paused-desktop`
and `event-paused-mobile` diffs only through the browser-smoke failure artifact
with `node ci/visual-accept.mjs`, as prescribed by the
[visual-regression guide](../../visual-regression.md#when-a-diff-is-intentional).
No local image above was copied into a test baseline, and no mask or ceiling
changed.
