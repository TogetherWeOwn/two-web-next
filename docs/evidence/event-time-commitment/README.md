# Event duration and calendar clock evidence

## Design contract

Members and moderators need to judge the time commitment before RSVP and identify
mixed host-zone clocks without opening every event. Keep the existing Open Lobby /
Logo 1 layout, typography, tokens and primary actions. References are the
[Hono detail](../../../src/events/pages-detail.tsx),
[Kit detail](../../../web/src/lib/EventDetail.svelte) and
[shared month grid](../../../src/events/pages-calendar-grid.tsx).

Add **Duration** after Ends in the existing definition list, before RSVP. Format
elapsed milliseconds with one shared deterministic English formatter; do not
subtract host-clock strings. Positive sub-minute intervals say **Less than a
minute**; unusable/nonpositive intervals have no entry. Whole hours/minutes omit
zero units and residual seconds round down. Starts, Ends and exports do not change.

Timed grid links lead with **HH:mm IANA/Zone**, then the existing title and
cancellation badge. Invalid zones use the clock's UTC fallback. Accessible names
retain the visible prefix, full title and existing day wording. Continuations
retain their day/cancellation words without gaining a clock or zone. At mobile
widths, labels wrap inside the existing horizontal grid scroller; CSS does not
hide or ellipsize the title. No new island, setting, query or route ownership.

## Captures opened during implementation

All 24 images below were captured and opened, using real server-rendered local
fixtures and shipped local assets, with 1280×800 and 390×844 viewports. Full-page
image heights exceed the viewport. The before captures have no Duration or grid
zone; the after captures show the requested additions.

The grid fixture includes London/New York clocks, invalid-zone UTC fallback,
a cancelled long title, multi-day continuations, and a Discord-only row using the
page fallback zone. Mobile captures scroll horizontally to expose the occupied
cells rather than photographing empty weekdays. The native no-JS document and the
keyboard-triggered fragment result agree. The shared grid serves both entry paths;
it is not a separately reimplemented Kit calendar.

| Screen | Width | Before | After |
| --- | --- | --- | --- |
| Hono detail, no JS | 1280 | [Before](before/Hono-1280-detail-no-js.png) | [After](after/Hono-1280-detail-no-js.png) |
| Hono detail, no JS | 390 | [Before](before/Hono-390-detail-no-js.png) | [After](after/Hono-390-detail-no-js.png) |
| Kit detail, no JS | 1280 | [Before](before/Kit-1280-detail-no-js.png) | [After](after/Kit-1280-detail-no-js.png) |
| Kit detail, no JS | 390 | [Before](before/Kit-390-detail-no-js.png) | [After](after/Kit-390-detail-no-js.png) |
| Hono grid, no JS | 1280 | [Before](before/Hono-1280-grid-js-false.png) | [After](after/Hono-1280-grid-js-false.png) |
| Hono grid, no JS | 390 | [Before](before/Hono-390-grid-js-false.png) | [After](after/Hono-390-grid-js-false.png) |
| Hono grid, fragment | 1280 | [Before](before/Hono-1280-grid-js-true.png) | [After](after/Hono-1280-grid-js-true.png) |
| Hono grid, fragment | 390 | [Before](before/Hono-390-grid-js-true.png) | [After](after/Hono-390-grid-js-true.png) |
| Kit grid, no JS | 1280 | [Before](before/Kit-1280-grid-js-false.png) | [After](after/Kit-1280-grid-js-false.png) |
| Kit grid, no JS | 390 | [Before](before/Kit-390-grid-js-false.png) | [After](after/Kit-390-grid-js-false.png) |
| Kit grid, fragment | 1280 | [Before](before/Kit-1280-grid-js-true.png) | [After](after/Kit-1280-grid-js-true.png) |
| Kit grid, fragment | 390 | [Before](before/Kit-390-grid-js-true.png) | [After](after/Kit-390-grid-js-true.png) |

## Reproduce the fixture browser proof

```sh
NODE_OPTIONS=--import=tsx EVENT_TIME_SCREENSHOT_DIR=/path/to/captures \
  npx playwright test --config=e2e event-time-commitment.spec.ts --workers=1
```

Observed before: 12 expected feature failures. Observed after: 12 passed. The first
browser launch lacked local Chromium libraries and failed before rendering; the
counts above are from the subsequent render-capable runs, not that setup failure.
The browser fixture asserts accessible names, visible title/zone wrapping, no-JS
metadata before RSVP, unchanged instant attributes, keyboard view switching and
one real fragment request versus one native document.

This fixture runs the actual Hono renderer and Kit resolver/component SSR; it does
not prove the full built Kit Worker/HTTP pipeline or a deployed revision. Hono
accessibility, Lighthouse and visual-baseline gates do not exercise Kit detail.
No staging/production test or deployment is claimed. No mask, threshold or asset
budget is changed here.

## Pinned CI visual-baseline review

[Run 40233604945](https://github.com/TogetherWeOwn/two-web-next/actions/runs/40233604945)
on implementation head `318472baa` passed 14 visual cases and failed three cases
covering four images. Each mismatch is the intended Duration entry: desktop adds
a fifth metadata column and wraps existing text; mobile adds a stacked row.
The content below moves down with the taller metadata block. All four expected,
actual and diff images were opened; the sign-in action, paused notice, calendar
links, neighboring events and footer remain present and readable.

Accepted the four CI actuals with `node ci/visual-accept.mjs --format json` from
the extracted `e2e-failure-40233604945-1` artifact, then verified all four checkout
images match those CI actuals byte-for-byte. Only these baselines change; the
other 14 baseline images remain identical:

| Baseline | Before size | Accepted size |
| --- | --- | --- |
| [Guest desktop](../../../e2e/visual/__screenshots__/event-desktop.png) | 1280×1852 | 1280×1924 |
| [Guest mobile](../../../e2e/visual/__screenshots__/event-mobile.png) | 390×2686 | 390×2784 |
| [Paused member desktop](../../../e2e/visual/__screenshots__/event-paused-desktop.png) | 1280×1693 | 1280×1765 |
| [Paused member mobile](../../../e2e/visual/__screenshots__/event-paused-mobile.png) | 390×2459 | 390×2556 |

No test source, independently authored acceptance oracle, screenshot mask or pixel
budget changes. The next exact-head CI run must verify these baselines; accepting
the reviewed artifact is not itself a passing browser-smoke verdict.
