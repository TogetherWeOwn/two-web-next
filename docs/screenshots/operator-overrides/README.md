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

These local images do not prove staging deployment, runtime application or
production availability. The ordinary Hono accessibility, Lighthouse and
pinned CI visual gates remain required independently.
