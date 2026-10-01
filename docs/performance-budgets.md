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
It refuses OAuth, writes and routes outside the audit set. Tests prove that all
five paths return HTML 200, not redirects/errors, with no outbound fetches even
if a database URL or Discord token is accidentally injected. The event fixture
samples its clock inside each request, not at module evaluation (workerd's
global-scope clock is the Unix epoch). `test/performance-worker.test.ts` bundles
the real wrapper into Miniflare and verifies both event pages render dates seven
days in the future without outbound access.

Measured as a guest:

| Path | Data |
|---|---|
| `/` | Existing unavailable-counts fallback |
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
assets. Its 19-case selftest isolates raw/gzip breaches, exact boundaries,
missing files, malformed/empty/invalid budgets and newly unbudgeted assets,
including imported nested helpers. The newly landed `copy-link` island has an
initial ceiling based on its measured size. Island ceilings stay unchanged.
The stylesheet ceiling moved once, 3072/1280 → 4096/1792 raw/gzip: main's
error-search rules (`.error-events-search`, TOG-10824) are legitimate growth
that no whitespace compaction can fit — fully minified the sheet is 3220 raw
bytes against the old 3072 ceiling. Declarations remain whitespace-compacted
(identical parsed CSS); Lighthouse thresholds and island ceilings are untouched.

Never relax a Lighthouse threshold to turn a build green. Threshold changes
require a separate owner-approved PR. Byte-ceiling increases must likewise be a
separate deliberate PR explaining what grew and why. A failure gets a fix or an
explicit decision, not retries until a lucky sample passes.
