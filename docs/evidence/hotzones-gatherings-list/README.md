# Hotzone gatherings list — visual evidence

## Design contract

- **Audience and job:** members browsing aggregate activity need to identify the
  published gatherings included in the selected period's count.
- **Primary action:** follow a gathering title to its existing `/e/:key` page.
- **Content:** title and UTC start instant, soonest first; at most five items.
  More than five adds `showing 5 of M scheduled gatherings`. A genuine zero adds
  no section. Voice and games remain aggregate estimates without a list.
- **References and assumptions:** preserve the existing
  [Hono hotzone layout](../../../src/hotzones/pages.tsx),
  [Kit hotzone shell](../../../web/src/routes/hotzones/+page.svelte), and
  [schedule theme](../../../public/schedule-theme.css). This is an additive list,
  not a new visual direction.
- **Layout and tokens:** a semantic section after the joins grid, an `h2`, and a
  plain list of underlined title links with adjacent `time` elements. Existing
  display/body typography, spacing, borders and schedule-theme tokens apply.
- **Responsive behavior:** the list remains in normal document flow. Titles and
  timestamps wrap at mobile widths; no new fixed width or horizontal scroller.
- **Required states:** truncated index (five of seven), untruncated joins (three),
  and zero index. Capture desktop 1280×800 and mobile 390×844 in both renderers.
- **Non-goals:** new statistics, grid restyling, peak callouts, localization,
  member data, changes to filtering, cache policy, or authentication.

## Capture method and scope

Captured on 2026-10-22 in Chromium using synthetic fixture data only. Before
renders use commit `50079058f`; after renders use this branch's page components.
The Hono pages render their real layout/header/footer. The Svelte pages compile
with Svelte's server compiler and render their real Shell, with the existing
public sheets and compiled `web/src/app.css` utilities. A bounded loopback
fixture server serves the rendered pages and local assets, then shuts down.
No staging or production data was used.

Populated after captures scroll the gatherings section into view. Populated
before captures show the pre-existing joins grid. Zero captures remain at the
page top. These are component-fixture screenshots, not deployed-route evidence,
not hydration tests, and not accepted CI visual baselines. All 24 captures in
the table below were opened for visual inspection. The six original captures
without a before/after prefix are retained from the first implementation pass.

| Renderer / state | Before desktop | After desktop | Before mobile | After mobile |
| --- | --- | --- | --- | --- |
| Hono / truncated index | [before](before-hono-index-truncated-1280.png) | [after](after-hono-index-truncated-1280.png) | [before](before-hono-index-truncated-390.png) | [after](after-hono-index-truncated-390.png) |
| Hono / full joins | [before](before-hono-joins-full-1280.png) | [after](after-hono-joins-full-1280.png) | [before](before-hono-joins-full-390.png) | [after](after-hono-joins-full-390.png) |
| Hono / zero index | [before](before-hono-index-zero-1280.png) | [after](after-hono-index-zero-1280.png) | [before](before-hono-index-zero-390.png) | [after](after-hono-index-zero-390.png) |
| Kit / truncated index | [before](before-kit-index-truncated-1280.png) | [after](after-kit-index-truncated-1280.png) | [before](before-kit-index-truncated-390.png) | [after](after-kit-index-truncated-390.png) |
| Kit / full joins | [before](before-kit-joins-full-1280.png) | [after](after-kit-joins-full-1280.png) | [before](before-kit-joins-full-390.png) | [after](after-kit-joins-full-390.png) |
| Kit / zero index | [before](before-kit-index-zero-1280.png) | [after](after-kit-index-zero-1280.png) | [before](before-kit-index-zero-390.png) | [after](after-kit-index-zero-390.png) |

The Hono accessibility and Lighthouse gates do not exercise the Kit routes.
Kit evidence here is the actual Svelte page/Shell SSR captures and its type/build
checks. No visual baselines or quality thresholds were changed.

## Read consistency

The count and bounded list use the same published-only season predicate and a
read-only repeatable-read transaction. A controlled disposable-schema probe
committed a new gathering after the count but before the list: before the
isolation fix the result was count=0/list=1; after it the result was count=0/list=0,
and a fresh request returned count=1/list=1. This prevents a concurrent publish
or cancellation from giving the count and list different snapshots.
