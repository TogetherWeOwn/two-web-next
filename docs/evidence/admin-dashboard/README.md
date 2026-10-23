# Dashboard table/card parity evidence

## Design contract

Moderators need the same four resource destinations on both renderers and readable,
keyboard-reachable diagnostic tables. The primary action is opening Events,
Featured content, Activity log or Join attempts. Keep the existing descriptions,
counts, ISO timestamps, card stack, typography and shared stylesheet. This is not
a new visual direction, chart, query, authentication change or widget.

References and decisions:

- [Sibling Hono event list](../../../src/admin/pages/events-list.tsx): adapt its
  labelled scroll region, hint and keyboard focusability, not its filters.
- [Kit dashboard](../../../web/src/routes/admin/+page.svelte): retain the fourth
  card and heading-linked sections; align Hono with those destinations.
- [Shared styles](../../../assets/styles.css): preserve `facts`, `card`,
  `admin-table` and `admin-table-scroll`. Kit also loads its real
  [global stylesheet](../../../web/src/app.css); omitting it would conceal the
  existing theme contrast problem. A dashboard-scoped `currentColor` outline
  keeps the newly focusable Kit regions visible on that canvas.

## Screenshots opened

Synthetic actor, outcome counts and queries only. Viewports are 1280×800 and
390×844; images capture the full document. Before is commit `51415e1bb`.
After images show keyboard focus on the missed-search region.

| Renderer | Desktop before / after | Phone before / after |
| --- | --- | --- |
| Hono | [Before](before-hono-populated-desktop.png) / [After](after-hono-populated-desktop.png) | [Before](before-hono-populated-mobile.png) / [After](after-hono-populated-mobile.png) |
| Kit | [Before](before-kit-populated-desktop.png) / [After](after-kit-populated-desktop.png) | [Before](before-kit-populated-mobile.png) / [After](after-kit-populated-mobile.png) |

The fixture harness renders the real `AdminDashboard` with Hono's JSX runtime and
the real Svelte dashboard/AdminShell with Svelte's server compiler. Kit includes
`app.html`, compiled root `app.css`, component CSS and the shared author sheet.
Chromium intercepts every request; nothing reaches a live service. This is real
component rendering with supplied local rows, not a deployed route/load or
hydration proof. The existing paired acceptance test documents the SSR recipe.

Additional opened images cover empty analytics, unavailable analytics and a
255-character unbroken query on both renderers at both widths. Sixteen focus
checks passed; four overflowing missed-search tables also moved horizontally on
ArrowRight. Document width stayed within the viewport. The complete render
script, images and machine-readable measurements are retained with the task's
engineering evidence, not installed as a new visual baseline.

## Visual critique and disposition

- Card order, copy, spacing and heading hierarchy now agree. The extra Hono card
  intentionally moves its diagnostics down by one existing card height.
- Empty messages remain distinct from omitted/unavailable widgets. All four
  cards remain present in every state. No empty scroll regions appear.
- Long ordinary queries wrap; an unbroken maximum-length query stays inside its
  horizontal scroller. Column names remain scoped in the semantic table.
- Kit focus previously inherited a dark outline on its dark root canvas. The
  dashboard-only outline now follows its foreground color; both widths were
  reopened after this correction.
- **Existing limitation, not repaired here:** Kit's root dark canvas conflicts
  with legacy admin brand/card/footer colors. It is visible in both before and
  after images. These screenshots do not constitute an all-clear for Kit theme
  contrast or a staging release.
- **Resolved hold:** Svelte reported `a11y_no_noninteractive_tabindex` on the two
  required scroll regions. Premise checked: the enforced floor is
  `ci/floor-guard.mjs`, whose silenced-checker list names only the TypeScript,
  ESLint, Biome and coverage ignore forms, not the Svelte one; and no valid
  HTML table scroller is Svelte-interactive, so the sibling-standard scoped
  ignore is the endorsed path, not an evasion. Both regions now carry the same
  reasoned one-line ignore as the sibling admin pages. No hidden attribute or
  checker relaxation was added.

## Verification boundaries

The protected twin acceptance suite passed after 13 observed expected failures
before production edits. Its SHA-256 at this head is
`6f993bec53d19e8494f1302ba282d21ef18969bc6aa53f30c3571186794b66dd`:
commit 865fab12 rewrote only the `text()` extraction helper as a token walk
for the CodeQL incomplete-sanitization alert, and the diff touches no
assertion. All 26 cases pass with the helper.
The focused guide/dashboard/table/load/dispatch command ran 64 tests, all passing.
The two builder-owned guide tests also failed against the baseline guide before
being rerun successfully with both documentation fixes restored.
`npm run a11y` passed 146 Hono fixture scans, including both dashboard widths.
`npm run kit-parity:test` passed 67 runner/contract selftests; it is not a live
Kit/Hono parity journey. Floor and asset drift checks passed; the CI test inventory
was rechecked after adding the guide suite.

`npm run check --prefix web` passes with the sibling-standard ignores above:
1203 files, 0 errors, 0 warnings. `npm run build --prefix web` passed before
and after; the passing warning-enforcing check is the clearance.
Initial mobile Lighthouse collection encountered an occupied fixed local port.
Desktop quality collected 24 reports before autorun failed during process cleanup
with `spawn ps ENOENT`; the separate official quality assertion passed against all
24 reports. Full reruns use the verified real process utility, not a shim; their
outcomes are recorded separately in the PR. Pinned screenshot comparison and
admin browser journeys require the actual CI runner and were not spoofed locally.
No baseline was regenerated. Merge, independent review, deployed staging acceptance
and production promotion are separate gates and are not claimed here.
