# Admin failed-read recovery fixtures

## Design contract

Authenticated moderators need to retry the current filtered/paged admin read,
not reconstruct it. Add one native **Retry loading** link after the existing
503/500 explanation. Keep the current list/dashboard exits, titles, hints,
noindex and server-only rendering. Missing-row 404s and unusable URL state keep
only the existing exits. No form submission, automatic retry or new route cohort.

References are the existing `AdminShell.svelte`, both admin error boundaries,
`web/src/app.css` and `public/styles.css`: retain their heading, hint, paragraph,
link and responsive wrapping conventions. No new visual direction, dependency or
budget allowance. Use the existing focus-color token for the new link's outline.

## Before and after

These are synthetic local HTTP fixtures of the **real Svelte error components**,
compiled with `svelte/server`, the real `app.html` template, built Kit CSS and
`public/styles.css`. The root and admin layouts add only a children outlet and
the root stylesheet. The before components are pinned to their pre-change source;
the same built styles are used for both sides. JavaScript is disabled. These are
not live authenticated Worker or deployment screenshots and do not claim full
application accessibility certification.

The captured read uses page 2 and a status filter. Desktop is 1280×800; mobile is
390×844. All images below were opened. Additional 500, missing-detail 404 and
missing-URL captures were also opened during verification.

| Boundary | Width | Before | After |
| --- | --- | --- | --- |
| Admin | Desktop | [Before](before-admin-503-1280.png) | [After](after-admin-503-1280.png) |
| Admin | Mobile | [Before](before-admin-503-390.png) | [After](after-admin-503-390.png) |
| Join attempts | Desktop | [Before](before-join-attempts-503-1280.png) | [After](after-join-attempts-503-1280.png) |
| Join attempts | Mobile | [Before](before-join-attempts-503-390.png) | [After](after-join-attempts-503-390.png) |

Keyboard focus: [Admin](admin-503-390-focus.png),
[join attempts](join-attempts-503-390-focus.png).

## Critique and disposition

- Recovery hierarchy: a single underlined link follows the existing explanation;
  exits remain above it. No new heading or competing action.
- Mobile wrapping: no horizontal overflow in either boundary at either width;
  the new link is visible and reachable without JavaScript.
- Focus: the inherited dark outline was unclear on the dark fixture canvas.
  The new link now uses `--color-lobby-focus`; its final focused images were
  opened again with the actual built stylesheet.
- Existing chrome: low-contrast brand/hint/footer styling is visible in both
  before and after fixtures. This patch does not restyle that shared chrome or
  represent these captures as a whole-app visual approval.
- No screenshot-regression baseline is changed. Hono visual comparisons remain
  owned by the pinned CI runner; they do not exercise these Kit-only boundaries.

## Functional evidence

Independent tests were consumed unchanged. Before implementation, the combined
SSR/browser acceptance had **28 missing-link failures, 95 passes and zero skips**.
After implementation and final hardening, the following command passed
**348 tests, zero failures and zero skips**:

```sh
KIT_ERROR_SHELL_BROWSER_TESTS=true npx vitest run \
  test/admin-read-retry-url.test.ts \
  test/kit-admin-read-retry-acceptance.test.ts \
  test/kit-error-shell-render.test.ts \
  test/kit-admin-chrome-acceptance.test.ts \
  test/kit-join-attempt-detail-error-acceptance.test.ts \
  test/kit-join-attempt-error-chrome.test.ts \
  test/kit-admin-dispatch.test.ts \
  test/kit-admin-session-renewal.test.ts \
  test/kit-errors-outcome.test.ts \
  test/kit-errors-negotiation.test.ts \
  test/error-support-reference.test.ts \
  test/refusal-correlation-acceptance.test.ts
```

The twelve no-JavaScript browser cases exercise both boundaries at both widths
on 503/500/404. Tab and Enter produce exactly one additional same-origin GET,
retain the query and send no request body. The 404 cases use the existing list
exit instead. SSR cases cover list/detail URLs, hostile escaped queries,
fragments, malformed/unavailable URL state, fixed exits, distinct titles and
noindex. Neighboring suites cover the unchanged auth/cache/header/correlation
contracts. Rendering imports no database/session helper and performs no fetch.

`npm run lint`, `npm run typecheck`, `npm run check --prefix web`,
`npm run build --prefix web` and `npm run kit-perf` passed. Kit measurements stay
within the unchanged ceilings: server gzip 328679/329472 B, client JavaScript
gzip 99398/101632 B and client CSS gzip 1000/1024 B.

Hono-only checks: `npm run a11y` passed 146 fixture rows, and
`npm run lighthouse:quality` passed with 24/24 reports. Those results do not
exercise the Kit error routes. Mobile Lighthouse initially failed before content
admission because its fixed fixture port was occupied; no page was measured in
that attempt. Full-suite, mobile-performance and pinned visual-gate outcomes
belong in the PR's current Verification section, not an inferred green verdict.
