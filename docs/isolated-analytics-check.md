# Isolated Web Analytics check

Use this check to rehearse the regional exclusion and script-free policy page on a
synthetic staging target. The policy suppresses Analytics before script injection
for EU, UK and unknown jurisdictions. The allowed-region case exercises a fake
beacon and collector. `/privacy` stays script-free in every jurisdiction.

## Target and jurisdiction

Use an existing `analytics-synthetic.<nonproduction-zone>` HTTPS host admitted
only to synthetic traffic. Verify in the provider configuration that the zone,
routes and Analytics destination are separate from production and that the target
has no member data. Check that Zaraz and other outgoing integrations are
contained at the edge. The runner rejects the production zone, the shared staging
host and shared preview domains. The operator verifies zone and destination
ownership before supplying the origin.

The target serves two direct UTF-8 HTML responses without cookies. Use
`/__analytics-fixture` for minimal Analytics-eligible HTML without other scripts
and `/privacy` for the real server-rendered policy page. The isolated edge adds
`X-Two-Analytics-Fixture: isolated-v1` and `X-Two-Analytics-Jurisdiction` to both
responses. Derive the jurisdiction from the provider-observed country and EU
classification used by the policy. Use `eu` for a positively classified EU visit,
`uk` for `GB`, `unknown` for unavailable or indeterminate geography such as `XX`,
and `allowed` for a positively classified permitted visit such as `US`. The
expected jurisdiction is a comparison with this response metadata. It is never
sent as a location override. Use already approved synthetic egress for each
case. Provider Trace can exercise rule evaluation with simulated geography. A
verified browser delivery case needs the corresponding trusted input on the
actual isolated HTTPS response.

## Run and interpret

With the checkout's pinned Node dependencies and Playwright Chromium installed,
run once from each approved egress. Set `ISOLATED_ANALYTICS_ORIGIN` to the verified
HTTPS origin with no trailing slash. Select the expected classification for the
current egress.

```sh
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect eu
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect uk
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect unknown
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect allowed
```

The runner makes two HTTPS GETs per invocation and rejects redirects. It checks
the original HTML before replaying it in fresh Chromium contexts. All browser
requests are handled inside Playwright or blocked. The replay supplies its own
HTML response headers, removes the beacon integrity pin in the allowed case, and
serves a fake script and a fake `204` response to the collector POST. It prints
only case labels and counts.

| Case | Expected raw and browser beacon elements | Fake loads | Fake executions | Fake POSTs |
| --- | --- | --- | --- | --- |
| Eligible HTML, EU, UK or unknown | 0 | 0 | 0 | 0 |
| Eligible HTML, allowed | 1 | 1 | 1 | 1 |
| `/privacy`, every jurisdiction, JavaScript on and off | 0 | 0 | 0 | 0 |

Every case requires zero blocked requests, Zaraz markers and script errors.
Both `/privacy` replays require visible policy headings and zero script elements.
The required browser smoke also checks three initialization calls against one
fake load, execution and POST, and checks the real Hono and Kit privacy renderers
with JavaScript disabled.

For provider evidence, record the effective regional rule, edge-observed
jurisdiction, actual delivery and execution, and an attributable receipt from the
allowed isolated visit in the isolated dataset. Verify effective Zaraz settings
and any staging cleanup separately. The synthetic result measures intercepted
requests and fake receipts only. Keep any unavailable actual jurisdiction case
unverified. [Cloudflare collection behavior](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)
