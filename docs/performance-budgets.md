# Performance gates

CI runs two independent jobs in `.github/workflows/ci.yml`:

- `bundle-budget`: Node-only checker + offline selftest. Checks the exact minified
  `public/islands/**/*.js` (including top-level islands) and `public/styles.css`
  files, raw and default-level gzip. A new island or nested helper without an
  explicit ceiling fails closed. The job first rebuilds the served files from
  `assets/` with `ci/minify-assets.mjs --check` and fails on drift.
  `npm run check` also runs these checks.
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

## Minified public assets

`assets/islands/*.js` and `assets/styles.css` are the reviewed sources.
`public/islands/*.js` and `public/styles.css` are the deterministic
`esbuild --minify` (pinned `0.28.1`) build output that Workers serves; the
served bytes are checked in so every test executes exactly what ships. Edit
the source, then regenerate and commit the output:

```sh
npm run build:assets          # regenerate public/ from assets/
npm run build:assets:check    # fail when the output drifted from its source
```

The binder and stylesheet suites run against the minified bytes, so they prove
each build equivalent; only whitespace-tolerant assertions survive
minification. The deploy workflow rebuilds and re-checks drift after `npm run
check`, so the deployed bytes are the reviewed bytes.

## Local verification

```sh
npm ci --include=dev
npm run build:assets:selftest
npm run build:assets:check
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
rewrite or minify CSS, JavaScript or markup. The five 2026-09-30 ceilings below
outgrew on main's theme/port work; CEO decision 2026-10-03 on TOG-10845
approved raising them to measured size ×1.25 (rounded up to 512 B raw /
256 B gzip), the rule this PR already applies to later islands. Measured on
the merged tree (main `0bc7b0cb`):

| Asset | Raw / gzip bytes | Ceiling |
|---|---:|---:|
| `public/islands/events-calendar.js` | 12356 / 3975 | 15872 / 5120 |
| `public/islands/going-count.js` | 6800 / 2548 | 8704 / 3328 |
| `public/islands/member-profile.js` | 15547 / 4969 | 19456 / 6400 |
| `public/islands/past-events.js` | 6275 / 2024 | 8192 / 2560 |
| `public/styles.css` | 5678 / 1841 | 7168 / 2304 |

A separate CEO decision on TOG-12992 (2026-10-03) raised one more island,
`public/islands/admin-event-editor.js`, to measured ×1.25 rounded up. Its growth
comes from main #344 (`033059bf`, admin session-expiry draft-hold in the editor
islands), which took it from 1013 / 485 to 2843 / 1189, not from this PR:

| Asset | Raw / gzip bytes | Ceiling |
|---|---:|---:|
| `public/islands/admin-event-editor.js` | 2843 / 1189 | 3584 / 1536 |

The raise covers that one island only; a further increase on it needs a new
decision. Lighthouse thresholds are untouched.

The minification follow-up landed here: `public/` now holds the deterministic
`esbuild --minify` output of `assets/`, and the ceilings below measure those
minified bytes (measured ×1.25, rounded up to 512 B raw / 256 B gzip). Served
behavior is unchanged: the binder and stylesheet suites execute the minified
bytes. Measured on this tree with esbuild `0.28.1`:

| Asset | Raw / gzip bytes | Ceiling |
|---|---:|---:|
| `public/islands/admin-event-editor.js` | 1429 / 737 | 2048 / 1024 |
| `public/islands/admin-event-text-limits.js` | 998 / 539 | 1536 / 768 |
| `public/islands/auth-status.js` | 2081 / 1009 | 3072 / 1280 |
| `public/islands/avatar.js` | 287 / 213 | 512 / 512 |
| `public/islands/copy-link.js` | 1323 / 714 | 2048 / 1024 |
| `public/islands/events-calendar.js` | 5133 / 1991 | 6656 / 2560 |
| `public/islands/going-count.js` | 2289 / 1092 | 3072 / 1536 |
| `public/islands/member-profile.js` | 6138 / 2414 | 7680 / 3072 |
| `public/islands/past-events.js` | 3350 / 1397 | 4608 / 1792 |
| `public/islands/rsvp-button.js` | 13662 / 4001 | 17408 / 5120 |
| `public/styles.css` | 4749 / 1611 | 6144 / 2048 |

Never relax a Lighthouse threshold to turn a build green. Threshold changes
require a separate owner-approved PR. Byte-ceiling increases must likewise be a
separate deliberate PR explaining what grew and why. A failure gets a fix or an
explicit decision, not retries until a lucky sample passes.

## Discord snapshot path

The shared-snapshot + fenced-refresh Discord path adds a latency-critical read
path: every request runs one storage claim, at most one owner then performs the
live Discord read followed by a storage complete, every other request serving
the stored snapshot. The request that owns a refresh runs claim, live read,
then complete in sequence, so its worst case is about 4,000 ms
(1,500 + 1,000 + 1,500). The bounds below
restate the implemented constants; `test/performance-budgets-snapshot.test.ts`
pins each documented number to its constant so drift fails CI.

| Snapshot path | Budget | Enforced by |
|---|---|---|
| Snapshot cold-claim (each storage claim and complete) | 1,500 ms per operation | `DISCORD_STORE_DEADLINE_MS` in `src/events/discord-snapshot-postgres.ts`, asserted in `test/discord-snapshot-deadline.test.ts` |
| Stale-serve (usable snapshot age from last success) | Fresh under 60,000 ms; serves stale while age is under 600,000 ms total | `DISCORD_CACHE_FRESH_MS` and `DISCORD_CACHE_STALE_MS` in `src/events/discord-snapshot.ts`, asserted in `test/discord-events-cache.test.ts` |
| Refresh-lease (single-owner Discord refresh) | 5,000 ms | `DISCORD_REFRESH_LEASE_MS` in `src/events/discord-snapshot.ts`, asserted in `test/discord-events-cache.test.ts` and `test/discord-snapshot-postgres.test.ts` |

The live Discord read inside a refresh has a 1,000 ms headers-and-body deadline
(`DISCORD_READ_DEADLINE_MS` in `src/events/discord-transients.ts`). Storage
statements run under 400 ms statement / 350 ms lock timeouts
(`DISCORD_STORE_SQL_TIMEOUT_MS`; the lock cap is derived as the statement cap
minus 50). A failed refresh keeps the successful
timestamp and installs at least a 10,000 ms shared retry hold
(`DISCORD_FAILURE_HOLD_MS`). These rows document behavior only; changing
snapshot behavior or deadlines is out of scope.
