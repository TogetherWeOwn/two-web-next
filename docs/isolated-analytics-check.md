# Isolated Web Analytics check

Use an existing `analytics-synthetic.<nonproduction-zone>` HTTPS host for synthetic traffic only.
Verify an independent provider zone, routes and Analytics destination, edge containment of Zaraz
and other outgoing integrations, and the absence of member data.

Serve direct UTF-8 HTML without cookies at `/__analytics-fixture` (minimal eligible HTML) and
`/privacy` (the real SSR policy). Add `X-Two-Analytics-Fixture: isolated-v1` and
`X-Two-Analytics-Jurisdiction` at the isolated edge on both responses. Derive jurisdiction from
trusted provider country and EU classification. Use `eu` for a classified EU visit, `uk` for
`GB`, `unknown` for unavailable geography like `XX`, and `allowed` for a confirmed permitted visit
like `US`. Trace can simulate rule evaluation. Browser delivery requires verified egress.

With pinned dependencies and Chromium, run from each approved egress. Set `ISOLATED_ANALYTICS_ORIGIN`
without a trailing slash. `--expect` compares the edge response and sends no location override.

```sh
node ci/analytics-staging-check.mjs --target "$ISOLATED_ANALYTICS_ORIGIN" --expect eu
```

The runner inspects two direct GETs before replaying the HTML in Chromium. Playwright serves
the replay headers, fake beacon and POST receipt after dropping the beacon integrity pin.

| Case | Beacon elements | Fake loads | Fake executions | Fake POSTs |
| --- | --- | --- | --- | --- |
| Eligible HTML, EU, UK or unknown | 0 | 0 | 0 | 0 |
| Eligible HTML, allowed | 1 | 1 | 1 | 1 |
| `/privacy`, JavaScript on and off in every jurisdiction | 0 | 0 | 0 | 0 |

Every case requires zero blocked requests, Zaraz markers and script errors. `/privacy` must
display the policy headings with zero scripts. Provider evidence separately requires rule and
jurisdiction readback, real delivery and execution, an isolated dataset receipt, and cleanup.
