# Admin section orientation: visual evidence

Before/after screenshots for the admin current-section styling and the
compact upper-page breadcrumb on event/featured editors.

- Renderers: Hono SSR and Kit SSR, real root CSS, local fixtures.
- Widths: 1280 (desktop) and 390 (mobile).
- States: dashboard, event edit, featured edit, family 404, keyboard-focus
  ring on the upper link, no-JS render.

Naming: `{before,after}-{hono,kit}-{page}-{width}.png`, plus
`after-hono-event-edit-focus-1280.png` (visible focus) and
`after-kit-event-edit-nojs-390.png` (identical bytes to the JS render,
proving the breadcrumb needs no JavaScript).

Capture: SSR bytes plus `public/` served from a static server and shot with
headless Chromium. Kit shots render the light theme because the SSR harness
omits the app-shell theme attribute; before/after pairs stay self-consistent.
