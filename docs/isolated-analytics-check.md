# Isolated Web Analytics check

Use an existing `analytics-synthetic.<nonproduction-zone>` HTTPS host admitted
only to synthetic traffic. Verify its independent zone, routes and Analytics
destination in the provider configuration. The host must have no member data,
and Zaraz and other outgoing integrations must be contained at the edge. The
runner rejects the production zone, shared staging and shared preview domains.

Serve direct UTF-8 HTML without cookies at `/__analytics-fixture` (minimal
Analytics-eligible HTML) and `/privacy` (the real SSR policy page). Add
`X-Two-Analytics-Fixture: isolated-v1` and `X-Two-Analytics-Jurisdiction` at the
isolated edge on both responses. Derive the latter from the policy's trusted
provider-observed country and EU classification. Use `eu` for a positively
classified EU visit, `uk` for `GB`, `unknown` for indeterminate geography such
as `XX`, and `allowed` for a positively classified permitted visit such as `US`.
Trace can simulate rule evaluation. Browser delivery requires verified egress.

With pinned Node dependencies and Playwright Chromium installed, run the command
once from each corresponding approved egress. Set `ISOLATED_ANALYTICS_ORIGIN`
to the verified HTTPS origin with no trailing slash. Use `eu`, `uk`, `unknown`
and `allowed` in turn. `--expect` compares against the edge response and sends
no location override.

```sh
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect eu
```

The runner checks the original HTML from two direct GETs and replays it in fresh
Chromium contexts. It supplies its own response headers, removes the vendor
integrity pin for replay and fulfills the beacon script and collector POST inside
Playwright. All other browser requests are stubbed or blocked.

| Case | Beacon elements | Fake loads | Fake executions | Fake POSTs |
| --- | --- | --- | --- | --- |
| Eligible HTML, EU, UK or unknown | 0 | 0 | 0 | 0 |
| Eligible HTML, allowed | 1 | 1 | 1 | 1 |
| `/privacy`, JavaScript on and off in every jurisdiction | 0 | 0 | 0 | 0 |

Every case requires zero blocked requests, Zaraz markers and script errors.
`/privacy` also requires visible policy headings and zero scripts. Browser smoke
checks three initialization calls and both privacy renderers. Provider evidence
separately needs the effective rule, trusted jurisdiction, actual delivery and
execution, an attributable isolated dataset receipt, Zaraz readback and any
staging cleanup. Keep cases without real trusted egress unverified.
