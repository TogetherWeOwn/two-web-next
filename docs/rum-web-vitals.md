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
day with samples but no numeric p75 quantiles fails instead of reporting
insufficient data. A non-2xx response fails as a query failure with its HTTP
status. Only a structurally valid empty result counts as zero samples. Budgets
only go down; raising one is its own reviewed PR.

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
