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
**356 tests, zero failures and zero skips**:

```sh
KIT_ERROR_SHELL_BROWSER_TESTS=true npx vitest run \
  test/admin-read-retry-url.test.ts \
  test/admin-read-retry-malformed-native-render.test.ts \
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
fragments, malformed/unavailable URL state, non-string native URL properties,
fixed exits, distinct titles and noindex. Neighboring suites cover the unchanged auth/cache/header/correlation
contracts. Rendering imports no database/session helper and performs no fetch.

At the initial implementation head, `npm run lint`, `npm run typecheck`,
`npm run check --prefix web`, `npm run build --prefix web` and `npm run kit-perf`
passed. Those pre-integration measurements were server gzip 328679/329472 B, client JavaScript
gzip 99398/101632 B and client CSS gzip 1000/1024 B.

Hono-only checks: `npm run a11y` passed 146 fixture rows, and
`npm run lighthouse:quality` passed with 24/24 reports. Those results do not
exercise the Kit error routes. Mobile Lighthouse initially failed before content
admission because its fixed fixture port was occupied; no page was measured in
that attempt. Full-suite, mobile-performance and pinned visual-gate outcomes
belong in the PR's current Verification section, not an inferred green verdict.

## Integrated-head server compression repair

After the automated main integration, head `12065f074252544c3030f52ac3eec27f05a2f115`
failed the Kit server gzip gate by **483 B**. [The failing check](https://github.com/TogetherWeOwn/two-web-next/actions/runs/40007046058/job/120597618796)
reports 329955/329472 B; `ci-ok` correctly propagates that failure. The incorporated
main parent `46332992e` had passing CI. This is a real, reproduced branch-specific
budget failure, not a flake; no rerun or additional main merge is used as a fix.

The repair adds one SSR-only `admin-errors` group in `web/vite.config.ts`. It
co-compresses both admin error components, `AdminShell.svelte` and the retry URL
helper. Rolldown's recursive grouping also relocates the existing page-state and
Kit error-function definitions; those define functions/getters without a request,
session or database read at module initialization. Existing groups, conservative
minification, constructor names, legal comments and every budget stay unchanged.
No renderer, helper implementation or acceptance file changes.

Node 24.22.1, locked root/web dependencies, `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`:

| Tree | Server JS files | Server raw B | Server gzip B | Gzip ceiling B | Checker exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Failed integrated head | 119 | 1129582 | 329955 | 329472 | 1 |
| SSR group, build 1 | 116 | 1128917 | 328917 | 329472 | 0 |
| SSR group, clean build 2 | 116 | 1128917 | 328916 | 329472 | 0 |

Savings are **1038 / 1039 B**, leaving **555 / 556 B** margin, not a new growth
allowance. Both repaired builds have byte-identical client JS/CSS path/SHA-256
inventories and Worker entry bytes versus the failed head. Client JS remains
54 files, 246399/99897 B raw/gzip; CSS remains 2 files, 2784/1000 B; Worker remains
2551/1219 B. No client chunking setting changes.

For each repaired build, direct imports of each tree's own emitted admin error
entry and emitted SSR `render` produce byte-identical head/body output across
**43 fixtures**: list/detail and filtered reads, 404/500/503, missing/forged URL
state, mutation paths and an encoded hostile query. The comparator supplies
request-local page context, checks real dashboard/noindex output and rejects
error reflection. It does not replace emitted modules with source compilations.

`test/kit-admin-error-chunking.test.ts` parses the actual SSR configuration with
the existing Babel parser. Two tests fail on the old configuration with
`missing server group: admin-errors`; all three pass with the repair. The tests
exercise the real inclusion/exclusion regex and pin SSR-only placement and the
existing minification settings. The unchanged size gate proves actual bytes.
An initial scratch test draft used the unavailable TypeScript compiler API;
that harness error is not the red-before proof.

The targeted command above, plus `test/kit-admin-error-chunking.test.ts`, passes
**359/359 tests in 14 files, zero skips**. A separate Chromium run passes 41/41,
including all twelve admin keyboard/no-JS cases. The first browser attempt lacked
shared libraries and failed its launch hook (318 passed, 41 skipped); after
verifying the existing local Chromium library paths, the full targeted run passes.
No host installation or browser/test gate is weakened.

Fresh root lint/typecheck, Kit check, 26 budget/browser-wiring tests, six budget
selftests, floor guard, 1150/1150 test inventory and diff checks pass. Full
`npm run check`, Hono UI gates, screenshots and deployed routes are not rechecked
for this configuration-only repair. Their earlier evidence is not a current
whole-app or deployment PASS. Exact-head CI and independent review remain required.
Undo is to revert the SSR grouping repair; no data rollback is involved.
