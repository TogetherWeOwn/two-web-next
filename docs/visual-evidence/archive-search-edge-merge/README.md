# Archive search and edge-link merge evidence

Captured and opened on 2026-10-22 from the merged Hono `PastEventsPage` and
compiled Svelte archive page, using synthetic public-event props and the real
served stylesheets. Kit includes the built root-layout CSS. JavaScript was off.
These are local SSR-renderer captures, not deployed-route or hydration evidence.

The merge preserves both the search form and page-position span from this branch
and the upcoming-schedule/recovery links and pager test IDs from main. It adds no
new visual direction, styles, reads or controls beyond those two reviewed slices.

| Renderer / state | Desktop (1280 × 800 viewport) | Mobile (390 × 844 viewport) |
| --- | --- | --- |
| Hono, populated | [Capture](hono-p1-1280.png) | [Capture](hono-p1-390.png) |
| Hono, out of range | [Capture](hono-oor-1280.png) | [Capture](hono-oor-390.png) |
| Kit, populated | [Capture](kit-p1-1280.png) | [Capture](kit-p1-390.png) |
| Kit, out of range | [Capture](kit-oor-1280.png) | [Capture](kit-oor-390.png) |

Before-search captures of these states are in
[archive-edge-links](../archive-edge-links/). Each merged capture has one search
form and one pinned pager, with no horizontal overflow. Both widths retain the
upcoming-schedule link and visible out-of-range recovery. All eight images were
opened for visual review.

The six conflicted visual baselines retain main's images as placeholders, not
accepted combined-UI baselines. The pinned `browser-smoke` run must produce failure
artifacts for the combined search and edge-link UI; review and accept those with
`ci/visual-accept.mjs` and `ci/kit-visual-accept.mjs`. No pixel budget, mask or audit
was changed. These local captures must not be used as replacement baselines.

Targeted acceptance and neighboring archive tests passed locally. Full
`npm run check`, Lighthouse, accessibility and pinned visual suites were not
rerun locally for this merge; exact-head CI remains required. The staging archive
was opened in a browser, but staging does not establish deployment of this head.
