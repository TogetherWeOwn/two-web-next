# Saved featured preview: visual evidence

## Design contract

Audience: moderators inspecting an existing saved featured slot before
publication, while scheduled, live, or expired. Screen job: inspect the saved
card safely and read a point-in-time eligibility verdict separately. Primary
action stays the existing Save; the preview is read-only and never publishes.

Keep the Open Lobby/Logo 1 chrome, semantic tokens, typography, the
`Homepage preview` panel title and its intro copy. Inside the panel, render a
`Saved content preview` section with the public card article for every saved
status, then a `Homepage eligibility at this check time` section with the
status badge, a short reason and the saved UTC window bounds. On a
rejected redisplay, one draft note says the form holds the submitted draft
while the card and eligibility show the last saved row. References: the
existing public card, stored link/image admission and status authority; no new
visual direction. Required states: all four statuses, open bounds, clean and
error redisplay, minimal and maximum-length content, both twins, both widths.
Non-goals: unsaved live preview, autosave, visibility semantics, new policy,
simulated time, public preview URL, delivery guarantee, budget or threshold
changes.

## Captures

Real Chromium against real SSR bytes per twin at 1280x800 and 390x844. Hono
pages render through the checked-in page component; Kit pages render through
the checked-in route compiled with the Svelte compiler. Fixture row: saved
slot id 41, checked at 2034-05-20T12:00:00.123Z. Before shots render the same
fixtures on the pre-change tree. Every image in this directory was opened and
inspected.

Limits: the fixture image host is unreachable from the capture sandbox, so
cards show the image alt text instead of pixels; layout, headings, badge,
reason and bounds are unaffected. Container font fallback can differ from the
pinned CI runner, so these captures are implementation evidence, not
golden-baseline approval. Keyboard order (Headline Tab Body), no-JS presence,
accessible card/link/image names and no-overflow checks run in the acceptance
suites; `npm run a11y` passes on `/admin/featured/1` at both widths.

## Pairs

| Twin | Width | Before (unpublished) | After (unpublished) |
| --- | --- | --- | --- |
| Hono, desktop | 1280 | [before](before/Hono-1280-unpublished.png) | [after](after/Hono-1280-unpublished.png) |
| Hono, mobile | 390 | [before](before/Hono-390-unpublished.png) | [after](after/Hono-390-unpublished.png) |
| Kit, desktop | 1280 | [before](before/Kit-1280-unpublished.png) | [after](after/Kit-1280-unpublished.png) |
| Kit, mobile | 390 | [before](before/Kit-390-unpublished.png) | [after](after/Kit-390-unpublished.png) |

Live before/after: [Hono before](before/Hono-1280-live.png),
[Kit before](before/Kit-1280-live.png),
[Hono after, full page](after/Hono-1280-live-full.png),
[Kit after, full page](after/Kit-1280-live-full.png).

Required states (after): [scheduled, full page](after/Hono-1280-scheduled-full.png),
[expired, full page](after/Hono-1280-expired-full.png),
[error redisplay, desktop](after/Hono-1280-error-redisplay.png),
[error redisplay, mobile](after/Hono-390-error-redisplay.png),
[minimal card](after/Hono-1280-minimal.png),
[long content, mobile, no overflow](after/Kit-390-long.png).
