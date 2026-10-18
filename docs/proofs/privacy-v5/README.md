# Privacy v5 visual evidence

## Design contract

- **Audience and job:** visitors and members reading how board views are logged.
- **Primary action:** read the policy; no new interaction.
- **Content:** distinguish anonymous board telemetry from viewer-linked member-data access auditing. Preserve the deletion exceptions and lazy-throttle disclosure from v4.
- **References:** the [v4 policy](../../../content/privacy-policy-v4.md), the [v5 policy](../../../content/privacy-policy-v5.md), and the [retention ledger](../../retention-ledger.md).
- **Layout, typography and tokens:** keep the existing privacy page unchanged except for its text and version number.
- **Responsive behavior:** longer text wraps inside the existing content column at desktop 1280×800 and mobile 390×844.
- **Required states:** the complete policy before and after at both widths, with detail captures of the changed board disclosure.
- **Non-goals:** new collection, access rules, erasure categories, retention windows, controls or page styles. Historical policy sources remain unchanged; no historical-policy web route is added.

## Captures

Rendered the real Hono `/privacy` page using the existing `ci/wrangler.lighthouse.jsonc` local fixture Worker and Playwright Chromium. The fixture has no remote bindings or real credentials. Browser requests outside the fixture origin were blocked. Captures waited for network idle and font readiness, used device scale factor 1, and disabled animations. All eight images were opened and inspected.

| Viewport | Before — v4 | After — v5 |
|---|---|---|
| Desktop 1280×800, full page | [Before](before-desktop.png) | [After](after-desktop.png) |
| Mobile 390×844, full page | [Before](before-mobile.png) | [After](after-mobile.png) |
| Desktop board disclosure | [Before](before-desktop-board.png) | [After](after-desktop-board.png) |
| Mobile board disclosure | [Before](before-mobile-board.png) | [After](after-mobile-board.png) |

Both versions returned HTTP 200 with the expected version number, zero scripts and no horizontal overflow. The desktop page height changed from 4,934 to 5,175 pixels; the mobile page height changed from 7,409 to 7,791 pixels. The longer board explanation and version note account for the added height. Text remains inside the content column; navigation and the footer retain their layout.

These are local fixture evidence, not production screenshots, runtime-log probes, or committed visual-regression baselines. The pinned CI visual suite remains authoritative. Any intentional baseline change must be reviewed from its CI failure artifact and accepted with the existing visual-accept tool; no baseline was regenerated locally.
