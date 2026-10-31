# Native UTC-window inventory evidence

## Design contract

- Audience: moderators reviewing the saved event inventory, not attendees.
- Screen job: select an inclusive UTC start date and/or an exclusive UTC start
  date, then review the existing bounded table. Primary action: native GET
  **Filter**, with **Clear filters** as explicit recovery.
- Content: the existing search/status/RSVP/series/fill fields, **Starts from
  (UTC date, included)** and **Starts before (UTC date, excluded)**, an exact
  active interval or safe refusal, and the unchanged event actions.
- References/assumptions: the existing Hono inventory, its Kit twin, and the
  moderator guide's half-open planning interval. No new visual direction.
- Layout/type/tokens: retain the existing wrapping `.filters`/`.field` layout,
  native controls, typography and palettes. Pair the pale refusal notice with
  the existing dark `--ink` token; do not inherit Kit's light page foreground.
- Responsive: 1280×800 desktop and 390×844 mobile viewports; controls wrap and
  the table retains its labelled, keyboard-focusable horizontal scroll region.
- Required states: ordinary inventory, active window, refused window; native
  GET and keyboard behavior with JavaScript on and off.
- Non-goals: redesign, new framework/island, overlap scheduling, counts,
  attendance inference, writes, route cutover or altered display timezone.

## Narrow scope correction — 2026-10-31

The original design contract above is unchanged. Pre-existing filter fields and
Filter/Clear actions now remain inline in their native renderers; only UTC date
controls/feedback use shared server HTML. A hidden correction marker makes an
unchanged refused GET remain refused, with no JavaScript or visible new control.
The table, responsive wrapping, labels, palettes and explicit clear stay intact.

Fresh built-root/CSP browser run: **19 passed, zero skips**. Captured and opened
eight additional images at the same viewports; these are fixture evidence, not
visual-regression baselines or staging proof:

| Renderer | Ordinary inventory desktop / mobile | Refused desktop / mobile |
| --- | --- | --- |
| Hono | [desktop](scope-cut-hono-1280-inventory.png) / [mobile](scope-cut-hono-390-inventory.png) | [desktop](scope-cut-hono-1280-invalid.png) / [mobile](scope-cut-hono-390-invalid.png) |
| Kit | [desktop](scope-cut-kit-1280-inventory.png) / [mobile](scope-cut-kit-390-inventory.png) | [desktop](scope-cut-kit-1280-invalid.png) / [mobile](scope-cut-kit-390-invalid.png) |

Actual-form serialization and handler resubmission regressions were RED for 14
malformed/duplicate cases before the correction; the final focused selection is
**234 passed / five existing opt-in skips**, including the unchanged legacy Kit
source-contract test. These server round-trip cases are not a claim of a browser
click reproduction. Browser cases cover the existing native GET/keyboard/CSP
matrix. The pre-existing dark Kit header-brand contrast is outside this correction;
notice contrast remains 17.44:1. No palette or masking change was made for it.

This narrower composition needs the small same-feature raw/gzip allocations in
[the superseding decision](../../../ci/budgets/decisions/kit-perf/2026-10-31-admin-utc-window-scope-cut.md).
The original no-increase measurements below remain historical, not current
ceilings. Independent selected-state/retry and allocation-test corrections are
still pending; no complete-suite, exact-head CI, independent 5/5, staging or
production claim is made by these screenshots.

## Earlier captures and checks — historical

### Captured and opened

All twelve PNGs in this directory were opened for visual review. They use
synthetic data only. `before-main-*` renders main `a6b2ee88`; `after-*` renders
this feature. Filenames identify renderer, state and viewport width. Screenshots
are full-page, so image height can exceed the initial viewport height.

| Renderer | Before desktop / mobile | Active desktop / mobile | Refused desktop / mobile |
| --- | --- | --- | --- |
| Hono | [desktop](before-main-hono-inventory-1280.png) / [mobile](before-main-hono-inventory-390.png) | [desktop](after-hono-active-1280.png) / [mobile](after-hono-active-390.png) | [desktop](after-hono-invalid-1280.png) / [mobile](after-hono-invalid-390.png) |
| Kit | [desktop](before-main-kit-inventory-1280.png) / [mobile](before-main-kit-inventory-390.png) | [desktop](after-kit-active-1280.png) / [mobile](after-kit-active-390.png) | [desktop](after-kit-invalid-1280.png) / [mobile](after-kit-invalid-390.png) |

Hono uses the real EventsPage/Shell. Kit uses the actual built Server/respond,
manifest, root layout, admin shell, leaf and generated CSS, with only hooks and
load data replaced by read-free fixtures. Browser requests are intercepted;
there is no database, Discord, staging, production or mutation access. The
final HTML responses carry the actual `securityHeadersFor` policy, including
`style-src 'self'`; the notice foreground comes from the generated external
stylesheet, not a CSP-blocked inline attribute.

The final refused-state captures suppress sort/pager actions until dates are
corrected or explicitly cleared. Both stylesheet cascades measured the notice
foreground `rgb(22,19,15)` on `rgb(255,247,237)`: **17.44:1**, at both widths.
Existing shell palette differences and table overflow match the main controls;
they are not changes introduced by the shared server-renderer extraction.

## Executed checks and limitations

- `node --import tsx --test --test-timeout=60000 --test-reporter=tap ci/kit-admin-contrast.test.mjs`:
  **19/19 passed**, no skips, using the existing user-space Chromium libraries.
  Includes native UTC GET/keyboard cases at both widths, JavaScript on/off.
- Focused Vitest renderer, refusal and neighboring filter/scroll suites:
  **96 passed / 5 pre-existing browser-opt-in skips** across eight files.
- Root lint/typecheck, journey typecheck and the Kit Svelte check passed. The
  Kit check needed absolute rootDirs only in its run-owned generated `$app`
  configuration because dependencies live outside the checkout; no tracked
  configuration was changed. Final result: **0 errors / 0 warnings**.
- Kit build/performance budgets pass with all ceilings unchanged; see the
  [measurement record](../../../ci/budgets/decisions/kit-perf/2026-10-30-admin-utc-window-fit.md).
- The full local `npm run check` exceeded its 600-second bound and was stopped;
  no full-suite green is claimed. The approved disposable test DB failed DNS
  resolution, so the SQL-backed acceptance suite was not verified locally.
- Hono `npm run a11y`, `npm run lighthouse`, `npm run lighthouse:quality` and
  CI-pinned visual comparisons were not rerun in this environment. They do
  not exercise the Kit route. No baseline, audit, mask or threshold changed.
- No staging page, deployment, merge or production behavior is claimed here.
