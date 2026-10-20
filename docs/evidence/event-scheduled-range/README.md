# Scheduled event range: visual evidence

Synthetic “Community chess session”, `America/New_York`, crossing from
31 December 2026 to 1 January 2027. No live event or member data.

These are full-page captures at **1280×800** and **390×844** viewports,
opened individually by the implementation author. The before captures use the
accepted test-only history `77ff5f7469f24c1c8fa7806c65d5320c610e7152`;
the after captures use this PR's implementation. Both renderers retain their
existing theme; differences between their existing tokens are not a redesign.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono desktop | [Before](before-hono-1280.png) | [After](after-hono-1280.png) |
| Hono mobile | [Before](before-hono-390.png) | [After](after-hono-390.png) |
| Kit desktop | [Before](before-kit-1280.png) | [After](after-kit-1280.png) |
| Kit mobile | [Before](before-kit-390.png) | [After](after-kit-390.png) |

## Capture boundary

The actual Hono route and Svelte SSR component/model use the independent
acceptance fixtures. Browser requests receive those rendered documents and the
repository's real local stylesheet, font and logo bytes; off-origin requests are
refused. Kit's application CSS is compiled with its locked Tailwind dependency.
The screenshot/axe pass enables JavaScript for axe injection but serves empty
island scripts; it does not exercise enhanced interactions or Kit hydration.
The separate 24-case acceptance browser suite disables JavaScript entirely.

The author also captured and opened both widths of each renderer for same-day,
overnight, multi-day, spring DST gap, autumn repeated hour, invalid-zone UTC,
and a signed-in year-crossing view: **32 after images**, plus these four before
images. Every capture had no horizontal overflow, missing local assets or axe
violations. The complete matrix and capture report accompany the task evidence;
these eight comparison images are the small public review set.

This is local fixture evidence, not staging or production evidence. Hono's
accessibility, Lighthouse and pinned visual-regression gates do not exercise the
Kit route. Intentional CI baseline changes are accepted separately from a pinned
runner failure artifact, never from these local captures.

## Reviewed CI baselines

The [initial visual run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39453296985)
on implementation `5ed22073cb493539fbc1edc6596c90a1e9950acd` produced artifact
`e2e-failure-39453296985-1`. The author opened all four expected/actual/diff
triplets before running `node ci/visual-accept.mjs` on that artifact.

Only `event-desktop.png`, `event-mobile.png`, `event-paused-desktop.png` and
`event-paused-mobile.png` changed. The existing When cell becomes Starts, the
new Ends cell uses the existing metadata grid, and the extra cell/wrapped dates
move the following content down. The paused notice, sign-in action, calendar
links, related events and footer remain present. The cancelled page and all
non-detail baselines are unchanged. The helper accepted exactly four baselines;
no visual spec, mask or pixel threshold changed. These Hono baselines still mask
`time` elements; the unmasked local captures above and no-JavaScript acceptance
matrix provide the date-text evidence. Exact-head CI must confirm the new
baselines, not merely their acceptance.
