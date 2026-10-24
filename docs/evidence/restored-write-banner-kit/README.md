# Restored-write banner on Kit pages — visual evidence

## Design contract

- Audience: a member who re-signed in after their session expired mid-write.
- Screen job: tell them the earlier changes were not saved, on whichever page
  they land — including Kit-owned pages, which never showed the banner before.
- Primary action: none. The banner is informational and keeps its copy with no
  link, exactly like the Hono twin.
- Real content: `You signed in again. Your earlier changes were not saved.
  Review and submit them again.` inside
  `<div role="status" tabindex="-1" data-testid="auth-error">`, first inside
  `<main>`.
- References: the Hono `expiredWriteBanner` render (`src/write-recovery.tsx`)
  is the single visual authority — this slice is a byte-twin, not a new
  direction, so no new tokens, type, or layout were designed. Assumed: the
  bare-div treatment stays unstyled on both renderers.
- Layout: banner first inside `<main>`, ahead of page content and ahead of the
  join banner where both render. Full-width text flow at every viewport.
- Typography/tokens: inherited page text. No new classes, colors, or spacing.
- Responsive: the sentence wraps naturally; verified at 1280×800 and 390×844.
- Required states: banner on first visible GET; no banner on reload (one-shot
  spent); no banner without the notice; error/HEAD/POST responses leave the
  notice pending (covered by automated tests, not screenshots).
- Non-goals: new copy, new styling, new journeys, predecessor grace, the join
  flow, Hono output changes.

## Capture method

Real adapter-built Kit worker (`npm run build --prefix web`, served with
`wrangler dev --local` on loopback) rendering the real `/about` leaf. The
notice cookie is signed with the worker's own session secret via the same
`serializeSigned` primitive the OAuth callback uses, installed in a real
Chromium jar, and the worker's `Set-Cookie` deletion is applied by that jar —
so the reload frame proves the one-shot through the actual browser flow.
`x-two-renderer: kit` asserted on every capture. Captured 2026-10-21 in
Chromium at viewport 1280×800 or 390×844. Every image was opened.

Banner response headers (curl, same signed cookie):

```http
HTTP/1.1 200 OK
x-two-renderer: kit
Cache-Control: no-store, private
Set-Cookie: __Host-two_expired_write=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
Vary: Cookie
```

The clean load keeps `Cache-Control: public, max-age=3600` with no `Set-Cookie`.

| Viewport | Banner (first GET) | Reload (spent) | No notice (clean) |
| --- | --- | --- | --- |
| Desktop 1280×800 | [Banner](kit-1280-banner.png) | [Reload](kit-1280-consumed.png) | [Clean](kit-1280-clean.png) |
| Mobile 390×844 | [Banner](kit-390-banner.png) | — | — |

These are evidence images, not visual-test baselines. The Hono `a11y` and
Lighthouse gates do not exercise Kit routes; the banner markup is
byte-identical to the Hono banner, which passes those gates.
