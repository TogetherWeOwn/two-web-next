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

## Two independent verdicts

The production workflow runs `node ci/rum-check.mjs --require-collection`.
Collection health is required: missing configuration or fewer than `minSamples`
(50) samples in the captured 24-hour window exits **2**, not green performance.
This does not claim a p75 breach or diagnose why collection is insufficient.
Do not lower `minSamples` or generate traffic to make the check green.

Every result includes `collectionHealth` and `metricVerdict` in addition to the
existing `kind`, `code` and bounded summary:

| Evidence | Collection health | Metric verdict | Required exit |
| --- | --- | --- | --- |
| Any required setting absent | `not-configured` | `not-evaluated` | 2 |
| Valid empty group list or 0–49 samples | `insufficient` | `not-evaluated` | 2 |
| At least 50, all metrics observed and within budget | `healthy` | `pass` | 0 |
| At least 50, one or more observed p75 values over budget | `healthy` | `over-budget` / `over-budget (partial)` | 1 |
| At least 50, no breach, some/all metrics explicitly unavailable | `healthy` | `partial` / `unavailable` | 0 |
| Invalid JSON, malformed GraphQL data or missing/non-finite required quantiles | `invalid-response` | `not-evaluated` | 1 |
| HTTP/GraphQL/network failure, deadline or body ceiling | `unavailable` | `not-evaluated` | 1 |

A negative API quantile means **n/a**, never zero or an observed pass. With
sufficient samples the other observed metrics remain enforced; an all-n/a day
has no metric pass. For compatibility `kind: "pass"` means no observed breach,
so consumers must inspect `metricVerdict` to distinguish partial/unavailable
metrics. The table labels unavailable rows `unavailable` and low-sample observed
rows `not evaluated`, not `ok`. Collection health `healthy` establishes query
admission and sample sufficiency, not complete metric availability or coverage
of all visitors. Summaries go to stdout and the GitHub step summary.

Without `--require-collection`, the CLI is diagnostic: `skipped` and
`insufficient` keep exit 0 but still show their explicit missing-evidence
verdicts. This mode is not production monitoring evidence. The retry wrapper
preserves the requirement on both attempts. Malformed data and transport errors
fail in either mode. Only a structurally valid empty/low-sample result is
`insufficient`; numeric p75 quantiles are mandatory once the sample floor is met.
Budgets only go down; raising one is its own reviewed PR.

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

## Bounded rate-limit recovery

`runRumCheck` remains a single attempt. The CLI uses
`runRumCheckWithRateLimitRetry`: at most two requests, retrying only after a
completed HTTP 429 response (JSON or non-JSON). Stalled requests, failed body
reads and oversized responses never qualify. Neither do network errors,
401/403, 5xx, HTTP 200 GraphQL errors, malformed data or metric-budget failures.

A valid `Retry-After` integer-seconds value or future HTTP-date (IMF-fixdate,
RFC850 or asctime) sets the cooldown, with a one-second minimum. A wait above **300 seconds** returns the original
failure without retrying; it is never clamped downward. Absent, malformed,
negative, current or past values use the default **300,000 ms** cooldown
(`RUM_RATE_LIMIT_COOLDOWN_MS`); `RUM_MAX_RATE_LIMIT_WAIT_MS` caps the allowed wait.
Cloudflare documents a [five-minute GraphQL rate window](https://developers.cloudflare.com/analytics/graphql-api/limits/).

Both attempts use the same captured 24-hour query window and credentials. Each
keeps its own 10-second total deadline and 64 KiB response ceiling. The second
result is evaluated normally: repeated 429s and genuine budget breaches still
exit nonzero. Summaries report the safe numeric cooldown, never provider payloads,
header text or identity. The workflow's **eight-minute** whole-job timeout fits
300 seconds of cooldown, two 10-second attempts and setup allowance; the query,
schedule, read-only token scope and metric thresholds stay unchanged.

**Loop:** a failed run on `main` is re-run once by the host flake ledger. If it
fails again, a private main-red card goes to the Web Engineer, whose fix goes
through the normal PR gates (Lighthouse, visual regression, journeys).

## Setup (one-time, account owner)

1. In Cloudflare, create an API token with only **Account → Account Analytics →
   Read** for the production account. No other permission.
2. Add it as the repository secret `CF_ANALYTICS_READ_TOKEN`.
3. Add the repository variables `CF_RUM_ACCOUNT_ID` (the production account id)
   and `CF_RUM_SITE_TAG` (Web Analytics → the production site → site tag).

Until all three exist, required production monitoring reports `not-configured`
and fails collection health. Creating a token or changing production collection
is a separately authorized setup action; a monitoring failure is not permission
to deploy, broaden token scope or alter CSP. A credential failure stops attempts;
never try another key.

## Observed collection evidence (2026-11-04)

Read the completed scheduled runs, not their green conclusion alone. These are
rolling 24-hour windows ending at each actual query, not calendar-day totals or
unique visitor counts; delayed schedules can leave gaps or overlap.

| Run created (UTC) | Samples | LCP p75 (ms) | CLS p75 | INP p75 |
| --- | ---: | ---: | ---: | --- |
| [2026-10-28 10:40](https://github.com/TogetherWeOwn/two-web-next/actions/runs/40674027313) | 21 | 1457 | 0 | n/a |
| [2026-10-29 10:58](https://github.com/TogetherWeOwn/two-web-next/actions/runs/40861681379) | 20 | 1380 | 0 | n/a |
| [2026-10-30 10:55](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41044307982) | 21 | 1217 | 0 | n/a |
| [2026-10-31 10:27](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41192851234) | 19 | 1319 | 0 | n/a |
| [2026-11-01 11:22](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41301633539) | 23 | 1417 | 0 | n/a |
| [2026-11-02 12:39](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41446440456) | 22 | 1490 | 0 | n/a |
| [2026-11-03 12:04](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41632688788) | 19 | 1288 | 0 | n/a |

All seven runs explicitly said `budgets not enforced`; none proves 50 real
samples/day. The latest ran at head `61cb82e136bd6f2bb3fe8e86c599bf467234f969`.
The same 19-sample fixture now produces required exit 2, collection health
`insufficient`, metric verdict `not-evaluated`, rather than a performance pass.

Bounded public reads on 2026-11-04 used two homepage GETs (default curl and a
browser-like User-Agent plus `Accept: text/html`) and one static beacon-script
GET. Default curl HTML omitted the beacon; browser-like HTML included the
Cloudflare Insights beacon, integrity attribute and a nonce matching the
response CSP. Its script contains a same-origin `/cdn-cgi/rum` transport path,
which the page's `connect-src 'self'` admits. No JavaScript was executed, no
beacon submitted, no authenticated collection setting written, and no database
queried. No tokens, nonce values or account/site identifiers are recorded here.

The successful queries and nonzero counts rule out wholly absent configuration
or a total collection outage in those windows. The public setup check found no
obvious beacon/CSP admission defect. The shortfall is **low observed RUM volume**;
low real visitor volume versus partial collection loss remains **unknown**:
there is no independent page-view denominator, cross-route/browser delivery
proof or observed beacon receipt in this evidence. Do not label collection
complete from a single HTML response. The remaining prerequisite is authorized,
read-only comparison of real daily page views with received Web Vitals and
route/browser collection coverage, followed by a real 24-hour window reaching
50 samples. If real volume is lower, the monitoring evidence remains
insufficient until the product requirement is explicitly revised; neither
synthetic traffic nor a lower sample floor satisfies it.
