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

The lockfile keeps `@lhci/cli` at **0.15.1** and Lighthouse at **12.6.1**.
Overrides scoped to LHCI use `tmp` **0.2.7** and `@puppeteer/browsers` **3.2.3**
to remove high-severity temporary-file and ZIP-extraction advisories. A global
`basic-ftp` **6.2.1** override fixes GHSA-c475-qrg2-pj4r; only LHCI's proxy chain
pulls `basic-ftp` in, and npm 10 does not apply a scoped override to the hoisted
copy. The `basic-ftp` client API used by `get-uri` is unchanged between 5.3.1 and
6.2.1. There are no new audit exceptions. The browser helper is ESM-only and requires Node
**22.12.0 or later**; CI remains on Node **24**. The performance regression suite
checks LHCI's temporary-file cleanup and both CommonJS/ESM Puppeteer entry points.
These import checks do not replace actual Chromium collection: the Lighthouse
job must still collect all fifteen samples and pass the unchanged assertions.

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
also serves. Hidden paths require explicit ceilings and cannot escape raw/gzip enforcement. Islands that landed after the
baseline (`copy-link`, `avatar`, `admin-event-editor`, `admin-event-text-limits`,
`auth-status`, `rsvp-button`) start at their measured size plus 25–33% headroom.

Served assets are main's files, unchanged: this PR adds gates only and does not
rewrite or minify CSS, JavaScript or markup. Measured at main `fb63afa`, five
pre-existing assets exceed their unchanged ceilings:

| Asset | Raw / gzip bytes | Ceiling |
|---|---:|---:|
| `public/islands/events-calendar.js` | 12060 / 3919 | 10240 / 3584 |
| `public/islands/going-count.js` | 5321 / 2062 | 4096 / 1536 |
| `public/islands/member-profile.js` | 14612 / 4581 | 7168 / 2560 |
| `public/islands/past-events.js` | 5871 / 1972 | 5120 / 2048 |
| `public/styles.css` | 5678 / 1841 | 3072 / 1280 |

The checker reports them over budget until an explicit ceiling decision or a
size reduction lands. Do not raise them here to turn the job green. Lighthouse
thresholds are untouched.

Never relax a Lighthouse threshold to turn a build green. Threshold changes
require a separate owner-approved PR. Byte-ceiling increases must likewise be a
separate deliberate PR explaining what grew and why. A failure gets a fix or an
explicit decision, not retries until a lucky sample passes.
