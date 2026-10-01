# Performance gates

CI runs two independent jobs in `.github/workflows/ci.yml`:

- `bundle-budget`: Node-only checker + offline selftest. Checks the exact unbundled
  `public/islands/**/*.js` (including top-level islands) and `public/styles.css`
  files, raw and default-level gzip. A new island or nested helper without an
  explicit ceiling fails closed. `npm run check` also runs these checks.
- `lighthouse`: pinned `@lhci/cli`, actual `wrangler dev --local`, three samples per
  page, median assertions. Reports and assertion results (also on failure) are
  uploaded as the `lighthouse-<sha>` GitHub artifact for 14 days. Uploads go to the
  repository artifact store, not a public LHCI server.

The required `check` job depends on **both** performance jobs and runs with
`if: always()`. Its first gate explicitly rejects failed, cancelled, skipped or
missing results; a skipped required check alone is not a safe merge gate.
`test/performance-ci.test.ts` sends synthetic over-budget LCP/CLS reports through
the real LHCI assertion command, proves its nonzero exit fails this gate, and pins
the workflow wiring. `npm run gate:selftest` covers result-state handling offline.

## Local verification

```sh
npm ci --include=dev
npm run budget:selftest
npm run budget
# Chrome/Chromium must be installed; point CHROME_PATH at its executable.
CHROME_PATH=/path/to/chrome WRANGLER_SEND_METRICS=false npm run lighthouse
```

LHCI starts/stops the fixture worker itself, listening only on `127.0.0.1:8787`.
Do not run another service on that port. The dedicated Wrangler config has no
Hyperdrive, database, queue, cron, remote service or deployment route. The fixture
worker discards runtime bindings, injects a read-only Drizzle proxy and in-memory
sessions, and serves the production Hono pages with the production public assets.
It refuses OAuth, writes, authenticated requests and routes outside the audit set.
The proxy admits only complete anonymous-read SQL statements with the expected
parameters. Homepage read callbacks use fresh local read-only proxies, with only
the production transaction-local 400ms/400ms or 250ms/250ms timeout settings;
unknown SQL, session-level settings and nested/configured transactions fail closed.
There is no SQL transport or mutable database state.

`ci/lighthouse-admission.cjs` starts the same local Wrangler command and withholds
LHCI's readiness marker until all five routes pass HTML/content admission. HTTP
200 alone is insufficient: homepage teasers and featured content, the event card
and detail must contain the fixture title, venue, aggregate and future dates.
Redirects and empty/outage fallbacks are rejected. Probes have a five-second
abort bound; a 55-second fail-closed watchdog precedes LHCI's unchanged 60-second
startup wait. Shutdown terminates the wrapper's owned Wrangler process group.

Tests exercise the real wrapper in Miniflare/workerd and prove populated homepage,
calendar and detail content without outbound fetches, even if runtime database or
Discord bindings are accidentally injected. The fixture samples its clock inside
each request, not at module evaluation (workerd's global-scope clock is the Unix
epoch), and admission requires dates seven days after the request.

Measured as a guest:

| Path | Data |
|---|---|
| `/` | Published upcoming teaser with three RSVPs and featured community news; existing unavailable-counts fallback only |
| `/events` | One published upcoming game night with three RSVPs; no past rows |
| `/e/01ARZ3NDEKTSV4RRFFQ69G5FAV` | The same fixture, real detail renderer |
| `/join` | Existing widget-free fallback (nonnumeric fixture guild ID) |
| `/about` | Production static introduction |

This is a rendering/assets regression gate, **not** staging acceptance, live DB
latency, Discord widget availability, authenticated/member/admin coverage or an
RSVP mutation test. It never tests production or staging databases. A session
cookie minter is unnecessary for these guest pages; do not interpret that as
coverage of the legacy authenticated performance surfaces.

## Threshold policy

`ci/lighthouserc.cjs` copies the legacy public-page thresholds and mobile profile:

| Audit | Median ceiling | Severity |
|---|---:|---|
| Largest contentful paint | 2000 ms | error |
| Cumulative layout shift | 0.1 | error |
| Server response time (observed TTFB) | 600 ms | error |
| Total blocking time | 300 ms | warning |
| First contentful paint | 1800 ms | warning |

Mobile screen 412 × 823, scale 1.75, simulated Slow 4G (150 ms RTT,
1638.4 Kbps throughput) and 4× CPU slowdown are unchanged. The observed TTFB
tripwire prevents Lantern's per-origin simulation from hiding slow HTML responses.
`test/performance-ci.test.ts` pins all thresholds, the phone profile and route set.

The byte ceilings are specific to Next's unbundled assets, based on the measured
2026-09-30 sizes documented in `ci/bundle-budget.json`, with roughly 25–45%
headroom. They are not copied from legacy Vite/Filament bundles that Next does not
serve. The checker exits **0** if every asset fits, **1** for size breaches or
missing budgeted assets, **2** for missing/invalid configuration or unenforced
assets. Its 31-case selftest isolates raw/gzip breaches, exact boundaries,
missing files, malformed/empty/invalid budgets and newly unbudgeted assets,
including imported nested helpers and dot-prefixed files/directories that Workers
also serves. Hidden paths require explicit ceilings and cannot escape raw/gzip enforcement. The newly landed `copy-link` island has an
initial ceiling based on its measured size. Island ceilings stay unchanged.
The stylesheet ceilings remain **3072/1280 raw/gzip bytes**. Main's home-event
and error-search rules must be preserved while reducing asset size; whitespace
compaction alone does not fit those additions. Do not raise the ceilings in this
PR to hide that failure. Declarations remain whitespace-compacted (identical
parsed CSS); Lighthouse thresholds and island ceilings are untouched.

Never relax a Lighthouse threshold to turn a build green. Threshold changes
require a separate owner-approved PR. Byte-ceiling increases must likewise be a
separate deliberate PR explaining what grew and why. A failure gets a fix or an
explicit decision, not retries until a lucky sample passes.
