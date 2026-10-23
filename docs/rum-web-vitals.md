# Real-user Web Vitals (production)

Cloudflare Web Analytics already measures real visitors (the edge injects the
`/cdn-cgi/rum` beacon into every HTML response). `.github/workflows/rum-web-vitals.yml`
reads the last 24 hours nightly (04:23 UTC) through the Cloudflare GraphQL
Analytics API and fails when a 75th percentile exceeds its budget in
`ci/rum-budget.json`:

| Metric | Budget (p75) |
| --- | --- |
| Largest Contentful Paint | 2500 ms |
| Cumulative Layout Shift | 0.1 |
| Interaction to Next Paint | 200 ms |

Budgets are enforced only when the day has at least `minSamples` (50) samples.
A configured query that returns invalid JSON, a malformed GraphQL shape, or a
day with at least `minSamples` samples whose p75 quantiles are missing or not
numeric fails instead of reporting insufficient data. A non-2xx response fails
as a query failure with its HTTP status. Only a structurally valid empty or
low-sample result counts as insufficient data. Budgets only go down; raising
one is its own reviewed PR.

## Transport bounds

`ci/rum-check.mjs` uses one **10,000 ms total deadline**
(`RUM_TRANSPORT_TIMEOUT_MS`) from fetch start through response-body completion.
Headers and each body chunk share the same deadline; a dripping body cannot
extend it. The deadline settles independently even if fetch or a body read
ignores abort. It is separate from the workflow's whole-job timeout.

The response is read as bytes with a **65,536-byte (64 KiB) ceiling**
(`RUM_MAX_RESPONSE_BYTES`) before JSON parsing. These are the bytes exposed by
fetch after HTTP content decoding, not JavaScript string lengths or compressed
wire bytes. Exactly the ceiling is allowed; the first chunk exceeding it is
refused without waiting for EOF. UTF-8 characters split across chunks are decoded
only after the complete bounded body arrives.

A timeout or oversized response exits nonzero as `timeout` or
`response-too-large`, with a fixed summary stating **Budgets not evaluated.**
Neither outcome means insufficient samples or a metric-budget pass. Both abort
the request and attempt response-body cancellation without awaiting disposal;
throwing, rejecting or stalled cleanup and late transport completion cannot
replace the result or emit another summary. Provider payloads and credentials
are omitted. Synthetic tests may override `timeoutMs` and `maxResponseBytes`
through `runRumCheck`; the CLI uses the constants above. No Analytics query,
credentials, schedule or metric thresholds change with these bounds.

**Loop:** a failed run on `main` is re-run once by the host flake ledger. If it
fails again, a private main-red card goes to the Web Engineer, whose fix goes
through the normal PR gates (Lighthouse, visual regression, journeys).

## Setup (one-time, account owner)

1. In Cloudflare, create an API token with only **Account → Account Analytics →
   Read** for the production account. No other permission.
2. Add it as the repository secret `CF_ANALYTICS_READ_TOKEN`.
3. Add the repository variables `CF_RUM_ACCOUNT_ID` (the production account id)
   and `CF_RUM_SITE_TAG` (Web Analytics → the production site → site tag).

Until all three exist, the check reports "not configured" and passes.
