# Event schedule preview: visual evidence

## Before (acceptance handoff; no preview exists yet)

Rendered the real Hono `EventFormPage` mode=new to HTML, served it with the
repo `public/` styles, and captured with headless Chromium, JavaScript
disabled, full page:

- `before/Hono-1280-new-form-no-preview.png`: recurrence inputs lead straight
  to Create draft; no Preview schedule action anywhere.
- `before/Hono-390-new-form-no-preview.png`: same at mobile width; no
  horizontal overflow.

Both images were opened and inspected. Kit before-state is the same contract
via source pins (`PG02` in
`test/admin-event-schedule-preview-admission.test.ts`); Kit pixels are the
Builder's after-evidence alongside Hono.

## After (required from the Builder)

Capture AND open, no-JS, at 1280x800 and 390x844, on both twins:

- success: weekly series preview (count, first/last, open disclosure)
- long series: 52-item disclosure (page stays usable)
- invalid: field errors with values retained and no preview panel
- one-off preview (single meeting)

Keep `npm run a11y`, Lighthouse quality and the visual specs green; disclose
Hono-vs-Kit coverage in the PR body.
