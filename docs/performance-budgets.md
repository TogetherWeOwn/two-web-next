# Performance gates

CI runs two independent jobs in `.github/workflows/ci.yml`:

- `bundle-budget`: Node-only checker + offline selftest. Checks the exact minified
  `public/islands/**/*.js` (including top-level islands) and every top-level
  `public/*.css` file, raw and default-level gzip. A new island, nested helper,
  or top-level stylesheet without an explicit ceiling fails closed. The job
  first rebuilds the served files from `assets/` with
  `ci/minify-assets.mjs --check` and fails on drift.
  `npm run check` also runs these checks.
- `lighthouse`: pinned `@lhci/cli`, actual `wrangler dev --local`, three samples per
  page, mobile performance assertions, desktop Lighthouse category scores, and a
  web-standards check. These checks fail the CI job when they fail. Reports and
  assertion results (also on failure) are uploaded as the `lighthouse-<sha>` GitHub
  artifact for 14 days in the repository artifact store, not a public LHCI server.
- main Worker bundle: the `check` job dry-runs the Hono Worker
  (`npx wrangler deploy --dry-run --outdir dist`, no deploy) and gates
  `dist/worker.js` against `ci/worker-bundle-budget.json` with
  `node ci/check-worker-bundle.mjs`. Served-asset and Kit budgets are untouched.

The required `ci-ok` job is the result gate; the standalone `check` job depends
only on `scope` and runs alongside the audit and performance jobs. `ci-ok`
aggregates `scope`, `check`, `docs-links` and the selected audit/performance
results. For an in-scope, non-draft run, both `lighthouse` and `bundle-budget`
must succeed. A failed or cancelled selected job, an unexpected skip, a failed
`scope`/`check`/`docs-links` result, or an invalid scope verdict fails `ci-ok`.
A skipped audit or performance job passes only when `scope` marks it out of
scope or the PR is a draft. `ci-ok` runs unless the workflow is cancelled; a
cancelled run must be followed by a run with a successful `ci-ok` result before
merge. Since GitHub can treat a skipped required check as mergeable, `ci-ok`
validates the selected job results and scope verdict instead of relying on check
skips to enforce the gate.
`test/performance-ci.test.ts` sends synthetic over-budget LCP/CLS reports through
the real LHCI assertion command, proves its nonzero exit fails this gate, and pins
the workflow wiring. `npm run gate:selftest` covers result-state handling offline.

## Main Worker bundle

The main app Worker (`src/worker.ts` via `wrangler.jsonc`) previously had
dry-run builds in CI (`ci.yml` `check` job) with no size assertion.
`ci/check-worker-bundle.mjs` gates the dry-run output `dist/worker.js`
(raw and default-level gzip) against `ci/worker-bundle-budget.json`.
It exits **0** when the bundle fits, **1** on breach, **2** when it cannot
enforce (missing bundle or budget). Every failure prints a remediation
pointer to the budget file's `$comment`. The checker never deploys.

Measured 2026-10-18 with wrangler 4.149.0
(`npx wrangler deploy --dry-run --outdir dist`; the `--env production`
dry-run builds byte-identical output, so one ceiling covers both):

| Bundle | Raw / gzip bytes | Ceiling |
|---|---:|---:|
| `dist/worker.js` | 2486680 / 499001 | 3108352 / 623872 |

Ceilings are measured size x1.25 rounded up (raw to 512 B, gzip to 256 B),
the repository x1.25 rule from `ci/bundle-budget.json`. Never relax a
ceiling to turn a build green; a raise needs its own reviewed decision
explaining what grew and why.

## Minified public assets

`assets/islands/*.js` and `assets/styles.css` are the reviewed sources.
`public/islands/*.js` and `public/styles.css` are the deterministic
`esbuild --minify` (pinned `0.28.1`) build output that Workers serves; the
served bytes are checked in so every test executes exactly what ships. Edit
the source, then regenerate and commit the output.
Top-level theme stylesheets (`public/theme.css`, `public/*-theme.css`) are
authored in place with no `assets/` source, so they are budgeted but never
minified. A new authored stylesheet needs two edits: a ceiling in
`ci/bundle-budget.json` and an entry in `AUTHORED_CSS` in
`ci/minify-assets.mjs`. A budgeted stylesheet with no `assets/` source and no
`AUTHORED_CSS` entry fails `build:assets:check` with an explicit "add to
AUTHORED_CSS or create assets/<name>" message:

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
npm run worker-budget:selftest
npx wrangler deploy --dry-run --outdir dist
npm run worker-budget
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
job must still collect all twenty-four samples (eight routes, three runs each) and pass the unchanged assertions.

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
LHCI's readiness marker until all eight routes pass HTML/content admission. HTTP
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
| `/faq` | Production static questions and answers |
| `/rules` | Production static house rules (database-free; last-updated stamp from config) |
| `/privacy` | Production versioned privacy policy, pre-rendered at module load |

This is a rendering/assets regression gate, **not** staging acceptance, live DB
latency, Discord widget availability, authenticated/member/admin coverage or an
RSVP mutation test. It never tests production or staging databases. A session
cookie minter is unnecessary for these guest pages; do not interpret that as
coverage of the legacy authenticated performance surfaces.

## Threshold policy

`ci/lighthouserc.cjs` defines the mobile public-page assertions below. Each
metric uses the median of three runs; the performance category uses the median
run score. The mobile performance category floor is read from
`ci/quality-budget.json`.

| Assertion | Threshold | Severity |
|---|---:|---|
| Performance category score (mobile) | 0.9 (90%) minimum | error |
| Largest contentful paint | 2000 ms | error |
| Cumulative layout shift | 0.1 | error |
| Server response time (observed TTFB) | 600 ms | error |
| Total blocking time | 200 ms | error |
| First contentful paint | 1800 ms | warning |

The separate desktop category check uses the same category floors from
`ci/quality-budget.json`:

| Category | Minimum score |
|---|---:|
| performance | 0.9 (90%) |
| accessibility | 0.95 (95%) |
| best-practices | 0.95 (95%) |
| seo | 0.95 (95%) |

Mobile screen 412 × 823, scale 1.75, simulated Slow 4G (150 ms RTT,
1638.4 Kbps throughput) and 4× CPU slowdown are unchanged. The observed TTFB
tripwire prevents Lantern's per-origin simulation from hiding slow HTML responses.
`test/performance-ci.test.ts` pins mobile thresholds, the phone profile and route
set. `test/performance-budgets-snapshot.test.ts` pins the documented thresholds
and category floors to their source configuration. `test/lighthouse-inventory.test.ts`
fails when the worker allowlist (`ci/lighthouse-paths.ts`), the LHCI list and the
admission list disagree, or when any of them drops one of the eight routes. The
post-cutover watch (`npm run lighthouse:origin`) reuses the LHCI route list, so it
measures the same eight routes on its allowlisted origin with the same thresholds.

## Authenticated session-cookie journeys

The guest gates above never cover member/admin latency: the fixture worker
refuses authenticated requests by design, so the personalized reads get their
own gate in the browser-smoke job (`.github/workflows/e2e.yml`), after the
critical journeys on the same seeded disposable Postgres:

| Journey | Request | Session | Budget (server response) |
|---|---|---|---|
| member-rsvp | `GET /e/:key` (seeded published event) | member (`qa-member`) | median 500 ms, slowest sample 1000 ms |
| moderator-admin | `GET /admin/events` | moderator (`qa-moderator`) | median 500 ms, slowest sample 1000 ms |

`ci/check-auth-perf.mjs` (budgets in `ci/auth-perf-budget.json`, at least five
samples each; the parser rejects smaller sample counts) mints exactly one QA session per identity, replays the
`__Host-two_session` cookie with rotation like the browser journeys, and
asserts status 200 **plus** authenticated content (signed-in account chrome on
the detail page, administration nav on the admin list — a published event
answers 200 to guests too, so status alone is not session proof) before it
measures. Ceilings are calibrated (see below) fail-closed budgets for the local worker. The hermetic test `ci/check-auth-perf.test.mjs` (which runs the
`--selftest`: good fixtures pass, slow samples and cookie-stripped guest
bodies fail, malformed budgets fail closed) runs in the `check` job; the
live gate runs in browser-smoke and fails `e2e-ok` with it. Cookie stripped (`--mutant no-cookie`) goes red:
the detail renders the guest banner and the admin list bounces to sign-in.
Local verification (hermetic only):

```sh
npm run auth-perf:selftest
node --test ci/check-auth-perf.test.mjs
```

### Calibration evidence

The first ceilings (median 1500 ms, slowest 3000 ms) were tightened to the
values above after two independent runs of the `browser-smoke` job on the pinned
`ubuntu-24.04` runner, against the workflow's disposable Postgres fixture, both on
head `71866d4` (five status-200 samples per journey per run, server response ms):

| Journey | Run | Samples | Median |
|---|---|---|---|
| member-rsvp | [39410396685](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39410396685) | 87, 93, 38, 37, 37 | 38 |
| member-rsvp | [39414247798](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39414247798) | 100, 44, 46, 42, 40 | 44 |
| moderator-admin | 39410396685 | 28, 20, 21, 19, 20 | 20 |
| moderator-admin | 39414247798 | 24, 23, 23, 21, 22 | 23 |

The slowest sample was 100 ms (member-rsvp, a cold first read) and 28 ms
(moderator-admin). The 500 ms median ceiling is over 11x the highest measured
member-rsvp run median (44 ms) and over 21x the highest moderator-admin run median
(23 ms). The 1000 ms single-sample ceiling is 10x the slowest member-rsvp sample
(100 ms) and over 35x the slowest moderator-admin sample (28 ms). This headroom
absorbs runner variance while sustained median regressions above 500 ms fail. The
anti-relaxation guard in `ci/check-auth-perf.test.mjs` now pins the new values as
the upper bound. Limitation: two runs on one runner type; further tightening
needs more runs, including cold-start samples.

Never relax these ceilings to turn a build green; threshold changes need
their own reviewed PR, like the Lighthouse thresholds above.

## Staging quality and journey gates

The staging checks run after deployment and serve different purposes:

| Check | What it verifies | Gate behavior |
|---|---|---|
| `staging-journeys` | Authenticated critical journeys against the deployed Worker; a journey ledger fails the job if every journey skips. | Post-deploy evidence, not a PR merge check. Docs-only and test-only deploys may skip it. Automatic production candidate resolution requires a successful `staging-journeys` result. |
| `staging-quality` | Mobile Lighthouse performance assertions plus desktop Lighthouse category scores on the deployed origin. | Runs after every qualifying staging deploy, even when journeys are skipped. A Lighthouse assertion failure fails the check; automatic production candidate resolution also requires this job to pass. |
| Web standards (`npm run standards -- --origin`) | Security headers, HTML basics and internal links. | Runs inside `staging-quality` and blocks it: a Web standards failure fails the job, like the Lighthouse budgets. |

The staging origin runs use GET-only requests with no sign-in or writes, but
they are not database-free: both Lighthouse runs measure `/events`, and the
mobile run also measures the discovered `/e/<key>`. Those routes read the
staging database, so a staging DB outage fails `staging-quality` and blocks
promotion. Every check listed above blocks: a failure in any of them fails
`staging-quality` and blocks promotion.

Desktop collection survives one transient: `npm run lighthouse:quality` runs
`ci/lighthouse-quality-run.mjs`, which reruns the whole `lhci autorun` a single
time when it fails with fewer LHRs than configured (7 routes x 3 runs = 21 on a
deployed origin), counted from collect's per-run `.lighthouseci/lhr-*.json`
files (the quality dir holds only the median report per route). A
full-evidence assert failure never retries. Every run writes
`.lighthouseci/quality-collect.log` (full lhci output) and, on failure,
`.lighthouseci/quality-collect-diagnosis.md`, which says COLLECT FAILURE
(short evidence: re-run the step, floors untouched), BUDGET BREACH (full
evidence plus an evaluated assertion miss: see `quality-summary.md`), or an
unclassified step failure (full evidence, no assertion verdict). Both files
ship in the `web-quality-origin-*` artifact.

Mobile collection survives one transient the same way: `npm run
lighthouse:origin` runs `ci/lighthouse-origin-run.mjs`, which reruns the whole
`lhci autorun` a single time when the first attempt comes up short of LHRs (8
routes x 3 runs = 24 with a discovered event, 7 x 3 = 21 when the event route
is skipped), counted from collect's per-run `.lighthouseci/lhr-*.json` files.
The retry also fires on the truncation signature of exit 0 with tail routes
unmeasured, which the old single-shot runner failed closed on with no
diagnosis, and on a marginal `/` LCP breach: complete evidence where the only
error-level assertion is the homepage `largest-contentful-paint` strictly
inside (budget, budget * 1.1) with every other route pass or warn-only. The
retry gates; the first attempt's table (`watch-summary.attempt1.md`) and
per-run files (`marginal-attempt1/`) stay in the artifact next to the gating
table, so both attempts are evidence. Any other full-evidence assert failure
never retries, and a second breach stays red as systematic. Every run writes
`.lighthouseci/origin-collect.log` (full lhci output) and, on failure,
`.lighthouseci/origin-collect-diagnosis.md`, which says COLLECT FAILURE
(short evidence, naming the routes short of runs: re-run the step, budgets
untouched), BUDGET BREACH (full evidence plus an evaluated assertion miss:
see `watch-summary.md`), or an unclassified step failure (full evidence, no
assertion verdict). Both files ship in the `web-quality-origin-*` artifact.
The `watch-summary.md` medians table is followed by a per-sample table with
every run's values for every route, including passes.

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
| `public/islands/auth-status.js` | 2765 / 1297 | 3072 / 1536 |
| `public/islands/avatar.js` | 287 / 213 | 512 / 512 |
| `public/islands/copy-link.js` | 1323 / 714 | 2048 / 1024 |
| `public/islands/events-calendar.js` | 7180 / 2639 | 7680 / 2816 |
| `public/islands/going-count.js` | 2289 / 1092 | 3072 / 1536 |
| `public/islands/member-profile.js` | 9471 / 3500 | 12288 / 4608 |
| `public/islands/past-events.js` | 3602 / 1490 | 4608 / 1792 |
| `public/islands/rsvp-button.js` | 14498 / 4201 | 17408 / 5120 |
| `public/styles.css` | 4749 / 1611 | 6144 / 2048 |

2026-10-21: the `events-calendar.js` row now records the calendar month-jump merge (7180/2639 B); ceilings 7680/2816 B are the minimal steps covering it.

The auth-status gzip ceiling uses the repository's ×1.25 rule on its recorded
2026-10-10 baseline (1213 B → 1536 B). This approved headroom covers two
fail-safe auth changes: bounded sign-out feedback and a session-read deadline
that settles even when abort is ignored. The raw ceiling remains unchanged.

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
(`DISCORD_READ_DEADLINE_MS` in `src/events/discord-transients-types.ts`, applied by `src/events/discord-transients-live.ts`). Storage
statements run under 400 ms statement / 350 ms lock timeouts
(`DISCORD_STORE_SQL_TIMEOUT_MS`; the lock cap is derived as the statement cap
minus 50). A failed refresh keeps the successful
timestamp and installs at least a 10,000 ms shared retry hold
(`DISCORD_FAILURE_HOLD_MS`). These rows document behavior only; changing
snapshot behavior or deadlines is out of scope.
