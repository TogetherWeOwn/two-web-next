# Schedule preview: after-state captures

Real Hono `EventFormPage` (preview and 422 states) and the real Kit
`admin/events/new` page (SSR through the repo's esbuild + svelte compiler),
served with the repo `public/` styles and shot with headless Chromium,
JavaScript disabled, at 1280x800 and 390x844. Every image was opened.

- `Hono-*-success.png`: weekly 4-count series across the BST to GMT change; the
  Not saved panel sits above the actions, the disclosure is closed.
- `Hono-*-long-52-open-top.png` / `-open-end.png`: 52-occurrence list, open.
- `Hono-*-one-off.png`: one-off preview, one occurrence.
- `Hono-*-invalid.png`: 53 occurrences, field errors, retained values, no panel.
- `Kit-*-new-form.png` / `Kit-*-invalid.png`: the Kit form carries the same
  Preview schedule action beside Create draft. A preview submit is answered by
  the Hono-owned POST /admin/events, so the panel itself is Hono markup.
