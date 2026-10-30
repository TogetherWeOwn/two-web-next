# Operator override panel visual evidence

Local fixture render, captured and opened on 2026-10-22. These images are
review evidence, **not** replacements for the pinned visual-regression
baselines. No production or staging system was contacted and no live
credential or record appears in them.

The real Hono admin router was served over an ephemeral loopback socket,
with a memory moderator session and a synthetic bot `/ops/config` response.
Only the bot transport was stubbed; the actual page renderer, shared admin
shell and built `public/styles.css` supplied the output. The browser
blocked all off-origin requests. The fixture includes a long setting key
and 200-character value to exercise wrapping.

| State | Desktop, 1280 × 800 | Mobile, 390 × 844 |
| --- | --- | --- |
| Before: route absent, branded 404 | [Before desktop](before-desktop.png) | [Before mobile](before-mobile.png) |
| Populated record, 200 | [Record desktop](populated-desktop.png) | [Record mobile](populated-mobile.png) |
| Empty override map, 200 | [Empty desktop](empty-desktop.png) | [Empty mobile](empty-mobile.png) |
| Upstream failure, 503 | [Unavailable desktop](unavailable-desktop.png) | [Unavailable mobile](unavailable-mobile.png) |
| Missing bearer, 401 | [Refused desktop](refused-desktop.png) | [Refused mobile](refused-mobile.png) |

Screenshots are full-page, so their image height can exceed the viewport.
Every after-state at both widths has zero viewport overflow and zero axe
violations in [report.json](report.json). The first refusal capture exposed
a plain-text browser document without title/language; the final refusal
uses the accessible admin shell. No score threshold was changed.

The fixture browser driver is preserved with the uploaded verification
bundle. Re-run the acceptance contract with:

```sh
npx vitest run test/dashboard-operator-override-panel-acceptance.test.ts
```

## Route-only stylesheet follow-up

Captured and opened all eight state/viewport images again on 2026-10-23 after moving the
same four panel rules into `/operator-overrides-theme.css`, outside the
public-page inlined bundle. The optional admin-shell stylesheet link does
not change other screens. These captures also consume the current main
admin shell/styles after conflict resolution.

| State | Desktop, 1280 × 800 | Mobile, 390 × 844 |
| --- | --- | --- |
| Populated record, 200 | [Record desktop](scoped-css/populated-desktop.png) | [Record mobile](scoped-css/populated-mobile.png) |
| Empty override map, 200 | [Empty desktop](scoped-css/empty-desktop.png) | [Empty mobile](scoped-css/empty-mobile.png) |
| Upstream failure, 503 | [Unavailable desktop](scoped-css/unavailable-desktop.png) | [Unavailable mobile](scoped-css/unavailable-mobile.png) |
| Missing bearer, 401 | [Refused desktop](scoped-css/refused-desktop.png) | [Refused mobile](scoped-css/refused-mobile.png) |

[The follow-up report](scoped-css/report.json) proves the additional
stylesheet loaded, wrapping is `anywhere`, populated tables use `fixed`
layout and 8px cell padding, and all eight captures have zero overflow
and axe violations. No visual baseline or existing byte budget changed.

These local images do not prove staging deployment, runtime application or
production availability. The ordinary Hono accessibility, Lighthouse and
pinned CI visual gates remain required independently.

## Compact incident copy

Captured and opened all eight images on 2026-10-23 after shortening repeated
incident guidance to fit the unchanged Kit server budget. The real local
Worker and existing accessibility fixtures supply these states; no external
requests, live records or credentials are used. The earlier `scoped-css/`
images above are the before view. Styles, admission, response validation and
escaping are unchanged. The full precedence explanation remains in the
[operator guide](../../operator-overrides.md).

| State | Desktop, 1280 × 800 | Mobile, 390 × 844 |
| --- | --- | --- |
| Populated record, 200 | [Record desktop](compact-copy/populated-desktop.png) | [Record mobile](compact-copy/populated-mobile.png) |
| Empty override map, 200 | [Empty desktop](compact-copy/empty-desktop.png) | [Empty mobile](compact-copy/empty-mobile.png) |
| Upstream failure, 503 | [Unavailable desktop](compact-copy/unavailable-desktop.png) | [Unavailable mobile](compact-copy/unavailable-mobile.png) |
| Missing bearer, 401 | [Refused desktop](compact-copy/refused-desktop.png) | [Refused mobile](compact-copy/refused-mobile.png) |

The [capture report](compact-copy/report.json) records zero axe violations
in all eight views and successful isolated-fixture cleanup. The screenshots
are supplemental evidence, not regenerated visual-regression baselines.
