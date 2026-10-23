# two-web-next

[![Release](https://img.shields.io/github/v/release/TogetherWeOwn/two-web-next)](https://github.com/TogetherWeOwn/two-web-next/releases)

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), the frozen legacy
repository: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest,
[Drizzle](https://orm.drizzle.team) + Postgres, server-rendered HTML with plain
JavaScript islands. The [parity matrix](docs/parity.md) tracks the migration;
migration plan: TOG-9671.
How it fits together: [docs/architecture.md](docs/architecture.md).
Shared-DB foundation (topology, numbering, backups): [docs/db-migrations.md](docs/db-migrations.md).
Operations (deploy/rollback, `/up`, queues, outages and restore drills):
[docs/runbook.md](docs/runbook.md). Security boundaries and repository evidence:
[docs/threat-model.md](docs/threat-model.md).

## What works today

- Homepage member/online counts and rank reads come from bot-owned `web_v1` views, are cached for 60 seconds, and hide missing or stale counts; the page degrades when reads fail. House rules, the versioned privacy page, branded error pages, manifest/icons, canonical metadata, sitemap, robots, and security/cache headers are also implemented ([`src/counts.ts`](src/counts.ts), [`src/pages.tsx`](src/pages.tsx), [`src/index.tsx`](src/index.tsx), [`src/seo.ts`](src/seo.ts), [`test/home-counts.test.ts`](test/home-counts.test.ts), [`test/seo.test.ts`](test/seo.test.ts), [`test/n2-manifest-errors.test.ts`](test/n2-manifest-errors.test.ts)). `/.well-known/security.txt` serves the RFC 9116 disclosure file ([`src/security-txt.ts`](src/security-txt.ts), [`src/index.tsx`](src/index.tsx), [`test/security-txt.test.ts`](test/security-txt.test.ts)).
- Discord sign-in requests `identify` + `guilds.join`; the join journey includes an invite fallback and join-attempt audit. The OAuth access token is used for the join request and not stored. OAuth state and return-journey cookies are signed; persisted session tokens are hashed, rotated on authenticated reads, and revoked on logout ([`src/index.tsx`](src/index.tsx), [`src/join/route.ts`](src/join/route.ts), [`src/sessions.ts`](src/sessions.ts), [`test/auth-acceptance.test.ts`](test/auth-acceptance.test.ts), [`test/sessions.test.ts`](test/sessions.test.ts)).
- Moderator status is recomputed at login by matching Discord snowflake role IDs, not names; a blank allowlist or failed lookup denies moderator status. QA sign-in requires its configured token and exact staging `APP_URL`; this is not a request-host allowlist ([`src/index.tsx`](src/index.tsx), [`src/roles.ts`](src/roles.ts), [`src/qa.ts`](src/qa.ts), [`test/auth-acceptance.test.ts`](test/auth-acceptance.test.ts), [`test/qa-identity-admission.test.ts`](test/qa-identity-admission.test.ts)).
- `/profile` and `/members/:user` are member-gated; profile edits are self-only. Reads of another member's data are recorded, and these profile/member reads are refused if audit recording fails ([`src/profiles/routes-gate.ts`](src/profiles/routes-gate.ts), [`src/profiles/routes-admission.ts`](src/profiles/routes-admission.ts), [`src/member-reads.ts`](src/member-reads.ts), [`test/profiles.test.ts`](test/profiles.test.ts), [`test/profile-self-only.test.ts`](test/profile-self-only.test.ts), [`test/member-data-access.test.ts`](test/member-data-access.test.ts)).
- Event listing, calendar and past-event islands, event detail/search, iCalendar and Google Calendar links, event feeds, RSVP/leave endpoints, and going counts are implemented. The event detail page mounts the RSVP-button island. Discord-native calendar rows use [shared expiring snapshots](docs/discord-snapshots.md) and atomic refresh admission in Postgres; they are display-only, not canonical events ([`src/events/pages.tsx`](src/events/pages.tsx), [`src/events/routes.tsx`](src/events/routes.tsx), [`src/events/reads.ts`](src/events/reads.ts), [`test/events.test.ts`](test/events.test.ts), [`test/event-page.test.ts`](test/event-page.test.ts), [`test/islands-rsvp-button.test.ts`](test/islands-rsvp-button.test.ts), [`test/event-feeds.test.ts`](test/event-feeds.test.ts), [`test/discord-snapshot-postgres.test.ts`](test/discord-snapshot-postgres.test.ts)).
- Moderator admin screens include event and featured-event CRUD, a read-only RSVP roster, join-attempt audit, and a funnel summary ([`src/admin/routes.tsx`](src/admin/routes.tsx), [`src/admin/reads.ts`](src/admin/reads.ts), [`test/admin.test.ts`](test/admin.test.ts), [`test/admin-reads.test.ts`](test/admin-reads.test.ts)). They also include a read-only activity-log viewer showing who changed what, with subject and causer filters ([`src/admin/routes.tsx`](src/admin/routes.tsx), [`src/admin/reads.ts`](src/admin/reads.ts), [`src/admin/pages.tsx`](src/admin/pages.tsx), [`test/admin-activity-log.test.ts`](test/admin-activity-log.test.ts)).
- Agent-event ingress validates its caller and guild, supports idempotency, and applies an outer rate limit. CSP report ingestion and human-route throttles have fixture coverage; the human throttle uses `DATABASE_URL` when set, otherwise Hyperdrive's `DB.connectionString`. Shared throttle middleware allows when no store is configured or a store operation fails; `/join/discord` and `/join/callback` use a separate check that can fail if its configured store errors ([`src/agent-events/route.ts`](src/agent-events/route.ts), [`src/agent-events/service.ts`](src/agent-events/service.ts), [`src/throttle.ts`](src/throttle.ts), [`src/join/route.ts`](src/join/route.ts), [`src/db/connection.ts`](src/db/connection.ts), [`test/agent-events.test.ts`](test/agent-events.test.ts), [`test/agent-events-shield.test.ts`](test/agent-events-shield.test.ts), [`test/csp-reports.test.ts`](test/csp-reports.test.ts), [`test/throttle-db-connection.test.ts`](test/throttle-db-connection.test.ts)).
- Queue and scheduler code includes retries, locking, a queue ledger, `events:reconcile`, retention pruning, and `/up` readiness (503 on DB/schema failure, on a missing `SESSION_SECRET`, `DISCORD_CLIENT_SECRET`, or `DISCORD_BOT_TOKEN`, or on a weak `SESSION_SECRET` under the documented strength floor). The jobs worker uses a bot client and Postgres event store; missing bot endpoint/key/secret configuration makes bot calls fail as terminal jobs. Internal-action producer/consumer logic and its Wrangler queue binding exist, but the alert probe is the only sender to the internal-action queue; this does not claim normal web dispatch or end-to-end live bot parity ([`src/jobs/worker.ts`](src/jobs/worker.ts), [`src/jobs/call-internal-action.ts`](src/jobs/call-internal-action.ts), [`src/bot/client.ts`](src/bot/client.ts), [`src/alert-probe.ts`](src/alert-probe.ts), [`src/up.ts`](src/up.ts), [`wrangler.jsonc`](wrangler.jsonc), [`test/jobs.test.ts`](test/jobs.test.ts), [`test/jobs-worker-config.test.ts`](test/jobs-worker-config.test.ts), [`test/callinternalaction-no-web-dispatch.test.ts`](test/callinternalaction-no-web-dispatch.test.ts), [`test/up.test.ts`](test/up.test.ts)). Guarded one-row re-dispatch applies a single `replay` advice by queueing a fresh sync-event via `POST /admin/queue/failed/:id/redispatch`; it is staging-only and disabled until separately authorized ([queue-redrive runbook](docs/queue-redrive-runbook.md)) ([`src/admin/queue-redispatch.ts`](src/admin/queue-redispatch.ts), [`src/admin/routes.tsx`](src/admin/routes.tsx), [`test/queue-redispatch-route.test.ts`](test/queue-redispatch-route.test.ts), [`test/queue-redispatch-postgres.test.ts`](test/queue-redispatch-postgres.test.ts)).

## Event search

Calendar past searches preview up to 20 matches. Use **Continue search in past events**
to page through older matches without losing the query; **Clear search** returns to
the ordinary archive. See the [archive search contract](docs/past-archive-search.md)
for matching rules, empty-state recovery and cache boundaries. Archive cards retain
the query and page when opening an event, including in another tab; the detail
page's [archive return link](docs/archive-detail-return.md) takes you back to those
results without changing the event's canonical or share URLs.

## Moderator guides

- [Moderator admin guide](docs/moderator-admin-guide.md): Next admin routes,
  event and featured-content workflows, dashboard diagnostics, and safe escalation.
- [Monthly event-planning cadence](docs/event-planning-cadence.md): rolling
  four-week planning, cancellation/reschedule handling, and cycle completion.
- [Weekly TWO Community event run-of-show](docs/weekly-event-run-of-show.md):
  preparation, preflight, cancellation, and closeout evidence.
- [Event host privacy and safety checklist](docs/event-host-privacy-safety-checklist.md):
  least-privilege event hosting and routing concerns to an authorized moderator.
- [Weekly event retrospective template](docs/event-retrospective-template.md):
  qualitative event learning, separate from attendance and activity counts.
- [Troubleshooting join and Discord sign-in](docs/troubleshooting-join.md):
  current notices, recovery pages, and the invite fallback.
- [RSVP states and safe recovery](docs/rsvp-recovery.md): seats, waitlist positions,
  pending Discord mirrors, uncertain writes, and bounded support steps.

## Develop and test safely

Use Node **22.23.0+ on the 22.x line, or 24+** (CI uses Node 24; the probe CLIs
require default native TypeScript stripping, not early Node 22/23 releases).
The 22 floor is 22.23.0, the 22.x release verified end to end here:
its bundled npm 10.9.8 installs the committed lockfile, and ICU 78
renders a zero UTC offset as `GMT+00:00`, as the test suite pins.
Node 22.18.0 fails the suite (ICU 77 renders `GMT`) and its bundled
npm 10.9.3 could not install the lockfile until its optional-peer
entries were completed. The `node22-compat` CI leg proves the floor
on every non-draft, non-docs-only pull request.
Install development dependencies even when
`NODE_ENV` is inherited as `production`:

```sh
npm ci --include=dev
cp .dev.vars.example .dev.vars   # local settings only; never commit this file
```

Set the local origin in `.dev.vars` to match Wrangler's local server and the
Discord application's registered callbacks (`${APP_URL}/auth/discord/callback`
and `${APP_URL}/join/callback`).
See [the complete configuration reference](docs/config.md) for bindings, secrets,
defaults and failure behaviour. Use only test credentials for local auth.

### Database and migrations

Schema is in `src/db/`, migrations in `drizzle/`. Tests are permitted only on
`agent-testdb` (user `agent_test`, empty password), the CI job's disposable
Postgres service, or local fixtures. On `agent-testdb`, the shared
`testDatabaseUrl` guard allows only `postgres`, `two_web_next`, `w15_tests`, and
numeric `two_web_next_tog<digits>` databases; arbitrary names are refused. For a
full local check, use a fresh, run-owned database named
`two_web_next_tog<unique-digits>`; do not run the full suite against the shared
`two_web_next` database. **Never point tests, probes or verification at a
production or staging database.** If access fails, stop; do not substitute
another credential or database.

```sh
# Create a new isolated test database first; replace the numeric suffix each run.
export TEST_DB=two_web_next_tog1234567890123456
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/${TEST_DB}"
export AUDIT_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"
unset LEGACY_DATABASE_URL
export PGPASSWORD=
export W1_AGENT_TESTDB=0
npm run db:migrate    # apply tracked migrations to this run-owned test database
npm run db:check      # validate migration history
npm run format        # formatting only; no lint fixes or import reordering
npm run lint          # read-only Biome lint + format gate
env -u BOT_DATABASE_URL npm run check # lint + format + types + config drift/selftest + Vitest
```

For schema changes, `npm run db:generate` generates a migration; use the web
numbering range `1000–1999` described in [docs/db-migrations.md](docs/db-migrations.md).
Review generated SQL before applying it. Do not edit existing migrations.

Always supply the test URL for full-suite runs. Live suites skip when
`DATABASE_URL` is unset; `test/review-p1-verify.test.ts` gates its live-DB
proofs behind the same skip and keeps its P1-3 refusal proofs offline.
Tests must use agent-testdb or disposable CI service containers, never
production or staging databases. Legacy suites clear shared tables: do not
run concurrent suites against the same test database.

### Machine-docs check

Agents fetch `/join.md`, `/llms.txt` and `/events.md` literally, so this one
command re-proves the three truths after any machine-doc change: the join
invite resolves through the sanitized floor, llms.txt guidance matches its
content, and documented per-event URLs are fetchable or marked templates.

```sh
npx vitest run test/machine-docs-followable-links-acceptance.test.ts test/ai-friendly-md.test.ts
```

## Coverage ratchet

```sh
# Choose a fresh, unused numeric suffix for each run.
export TEST_DB="two_web_next_tog1234567890123456"
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/$TEST_DB"
export AUDIT_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"
unset LEGACY_DATABASE_URL
export PGPASSWORD=
export W1_AGENT_TESTDB=0
npm run db:migrate
npm run test:coverage
node ci/coverage-summary.mjs
```

Coverage includes every
`src/**/*.{ts,tsx}` file, even if no test imports it. Global and aggregate
area floors (`src/admin`, `src/events`, `src/join`, `src/sessions.ts`, `src/jobs`,
`src/bot`, `src/agent-events`, `src/profiles`, `src/auth`, `src/invite.ts`,
`src/return-journey.ts`, `src/write-recovery.tsx`, `src/kit-*`, `src/counts.ts`,
`src/seo.ts`) live in `vitest.config.ts`. The
baseline uses the full suite with the test database; without it, skipped live
suites may put coverage below the floors. CI's
`check` job runs the configuration drift check, Biome lint/format gate,
typecheck and the coverage gate against its Postgres service, writes a job summary
with the ten least-covered files, and uploads the JSON coverage summary for 14 days,
including on failure.

When intentionally raising a floor, re-measure with the same locked provider
and Node 24 against the test database, leave a one-percentage-point margin
(rounded down to one decimal place), and include the summary in the PR.
Never lower a floor simply to make a regression pass.

For local development, use the separate test-only configuration, which omits
Hyperdrive and selects the explicit `DATABASE_URL` from `.dev.vars`:

```sh
npm run dev -- --config wrangler.local.jsonc --local
```

Keep `.dev.vars` on the passwordless test URL above. The checked-in local config
uses `APP_URL=http://localhost:8787`, local Queue names and no remote bindings;
set public Discord IDs only for an authorized test application/guild. Do not
use real guild sign-in as a test fixture. `/up` is the readiness signal (503 on DB
unreachable, pending web migrations or a missing required secret; queue-only trouble stays 200; no auth); use the SQL suites for database
verification. This exercises direct Postgres, not Hyperdrive pooling. Miniflare requires a nonempty password for a Hyperdrive
local connection string, so the passwordless authorized URL cannot be used as
that override. **Do not invent a password or substitute credentials.** Never
deploy the local config.

Do not use remote development for tests. Many SQL suites skip if `DATABASE_URL`
is unset, but that is not full database verification; some existing tests also
use the test container directly. The commands above deliberately set one safe
URL. CI migrates its own `postgres:17` service before running `npm run check`.

### Islands and build checks

`assets/islands/*.js` and `assets/styles.css` are the reviewed browser sources,
with contracts in `src/islands/contracts.ts`. `npm run build:assets` minifies
them with esbuild into the checked-in `public/islands/*.js` and
`public/styles.css` that Wrangler serves as static assets; there is no
frontend framework bundle to generate. Island and stylesheet tests execute the
minified bytes, so edit the source, rebuild, and commit both.

Successful calendar fragment navigation and Back/Forward keep guest header sign-in,
hero Join and card sign-in destinations aligned with the committed URL, retaining
ordinary-login versus join endpoints and attribution parameters. Unsent search
drafts and failed, superseded or invalid fragments do not install new destinations;
replacement links and zones are admitted together without replacing the search input.

```sh
npm run build:assets                 # regenerate public/ from assets/
npm run build:assets:check           # fail when the output drifted
npm run config:check                 # drift check + its local-fixture selftests
npx wrangler deploy --dry-run --outdir dist   # bundle check; does not deploy
```

WebMCP tool errors (`assets/islands/model-context.js`): every tool call owns
a 10 s deadline over fetch plus body consumption and a 32 KiB body cap
(mirroring `API_PUBLIC_BOUNDS.maxBodyBytes`, enforced while streaming when a
reader exists); settlement aborts the per-call fetch and releases its queue
entry and pagehide forwarder. Failures reject with an `Error` carrying a
stable `.code`, a safe `.message` naming the next step, and `.retryAfter`
seconds (1–86400) on rate limits only. Codes: `timeout`,
`invalid_response` (oversize, malformed, or unexpected redirect),
`unavailable` (5xx, transport, or pagehide), `rate_limited` (429, never
retried automatically), `not_found` (unknown event key, no retry),
`invalid_request` (bad event key, thrown synchronously). Local check,
fixtures only:

```sh
npx vitest run test/islands-model-context-bounds-acceptance.test.ts test/islands-model-context.test.ts
```

### Browser regressions

Except for the unconditional Kit member-auth suite, these suites skip their browser cases unless the opt-in variable is `"true"`, so
a run without it can pass without executing them. For the Vitest suites wired
into CI, the `a11y` job sets each variable, writes a Vitest JSON report and runs
`ci/a11y-require-executed.mjs`, which fails the step unless every case in the
named suite passed and at least the minimum ran. The RSVP and Kit member-auth `node --test` suites
write TAP reports and run `ci/rsvp-focus-require-executed.mjs` the same way.
The minimums live in `.github/workflows/ci.yml`. Run any listed command locally
to execute the same Chromium proof.

| Suite | Opt-in variable | Local command |
| --- | --- | --- |
| `test/admin-event-native-unicode.test.ts` | `ADMIN_EVENT_BROWSER_TESTS` | `ADMIN_EVENT_BROWSER_TESTS=true npx vitest run test/admin-event-native-unicode.test.ts` |
| `test/featured-native-length.test.ts` | `FEATURED_NATIVE_BROWSER_TESTS` | `FEATURED_NATIVE_BROWSER_TESTS=true npx vitest run test/featured-native-length.test.ts` |
| `test/calendar-search-unicode-boundaries.test.ts` | `CALENDAR_SEARCH_BROWSER_TESTS` | `CALENDAR_SEARCH_BROWSER_TESTS=true npx vitest run test/calendar-search-unicode-boundaries.test.ts` |
| `test/event-device-timezone.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/event-device-timezone.test.ts` (also needs `npm ci --prefix web --include=dev` once) |
| `test/event-device-timezone-ends.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/event-device-timezone-ends.test.ts` (also needs `npm ci --prefix web --include=dev` once) |
| `test/profile-device-timezone.test.ts` | `PROFILE_DEVICE_TIMEZONE_BROWSER_TESTS` | `PROFILE_DEVICE_TIMEZONE_BROWSER_TESTS=true npx vitest run test/profile-device-timezone.test.ts` (also needs `npm ci --prefix web --include=dev` once) |
| `test/profile-native-length.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/profile-native-length.test.ts` |
| `test/member-profile-native-422-baseline.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/member-profile-native-422-baseline.test.ts` |
| `test/profile-composition-browser.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/profile-composition-browser.test.ts` |
| `test/profile-refused-draft-recovery-acceptance.test.ts` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run test/profile-refused-draft-recovery-acceptance.test.ts` |
| `test/kit-error-shell-render.test.ts` | `KIT_ERROR_SHELL_BROWSER_TESTS` | `KIT_ERROR_SHELL_BROWSER_TESTS=true npx vitest run test/kit-error-shell-render.test.ts` (also needs `npm ci --prefix web --include=dev` once) |
| `test/admin-editor-expiry-departure.test.ts` | `ADMIN_EDITOR_EXPIRY_BROWSER_TESTS` | `ADMIN_EDITOR_EXPIRY_BROWSER_TESTS=true npx vitest run test/admin-editor-expiry-departure.test.ts` |
| `ci/audit-lifecycle.test.mjs` | `A11Y_BROWSER_TESTS` | `A11Y_BROWSER_TESTS=true npx vitest run ci/audit-lifecycle.test.mjs` |
| `ci/rsvp-focus-browser.test.mjs` | `RSVP_FOCUS_BROWSER_TESTS` | `RSVP_FOCUS_BROWSER_TESTS=true node --test ci/rsvp-focus-browser.test.mjs` (real Chromium focus proof with recovery paths; verified by `ci/rsvp-focus-require-executed.mjs`; runs in the `a11y` job) |
| `ci/kit-member-auth-browser.test.mjs` | None—always runs | `npm run test:kit-member-auth-browser` (15 real Chromium cases; memory sessions, local HTTPS, real Svelte SSR and minified controllers; requires Kit dependencies and OpenSSL; TAP-verified in `a11y`) |

The admin, featured and calendar suites use intercepted synthetic fixtures or
loopback servers with mocked reads, and the profile suite uses loopback fixtures
with memory stores. None needs a database, staging or the network. Install the
browser once, then run a suite with its variable set:

```sh
npx playwright install --with-deps chromium
```

Without Chromium the Vitest suites fail in `beforeAll`, vitest reports their
cases as skipped, and the verifier fails the CI step. The `a11y` job reuses its
cached Playwright Chromium. These steps run on `app`, `db` and `full` scopes,
main and nightly.

Do not use `npm run deploy` as a test or build command.

## Deploy

Push to `main` runs `check`, then `deploy-staging` (GitHub Environment `staging`
gate): `wrangler deploy` with the repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, followed by `node bin/smoke.mjs https://next.togetherweown.com --fail-on-ready-wait-critical`.
The staging smoke checks `/up`, the public pages and feeds, sitemap, robots,
Discord and guest auth redirects, and a branded 404. It checks CSP and nosniff
on every response and staging noindex on returned HTML (the application's header
contract). `/up` requires HTTP 200 with `db:ok` and `pending_migrations:0` (DB/schema
readiness) plus the queue envelope (`warn_at:20`, `critical_at:100`); with the staging
strict flag a literal `unknown` in `queue.status` or `ready_wait_severity`, or a `critical`
`ready_wait_severity`, fails the deploy even though `/up` itself still returns 200. Queue
`degraded` passes. The strict flag is staging-only: production and post-rollback smoke omit
it (`critical` only warns, `unknown` passes), so a blind or stuck queue cannot block its own
fix. Redirects are not followed; each
request/body has a 5-second timeout. A failure names the route and expected versus
actual result and fails the deploy job after six attempts. That workflow remains
staging-only; the separate production workflow below is gated and promotes
automatically once staging verifies a commit (with a daily backstop), keeping
manual dispatch for explicit redeploys and recovery.
Full procedures live in [docs/runbook.md](docs/runbook.md).

`npm run test:smoke` runs both checkers against loopback stub servers with local
fixtures only, no external network or database. It is included in `npm run check`
and the required PR CI job, so both PR CI and the pre-deploy check exercise the
selftests. The checkers themselves are staging-only post-deploy probes, not
production test commands.

After the public-routes smoke, the deploy runs
`QA_AUTH_TOKEN=<staging QA token> node bin/json-smoke.mjs https://next.togetherweown.com`,
which logs into staging through the QA seam (`POST /auth/qa/qa-member` with the
`X-TWO-QA-Auth` header and an explicit same-origin `Origin`) as the
non-moderator QA member and asserts the session-gated event JSON contract:
guest 401 refusals for `/events.json` and `/events/:key`, the collection paging
envelope (`data/page/limit` plus `meta.current_page/per_page/total/last_page`),
the JSON show shape for the first collection row (or the exact cancelled 410
envelope when that row is cancelled), a 410 probe against a cancelled fixture
when the first page has one, and the malformed-key 422/404 refusals. Every
listed contract check runs on each probe; a missing route or malformed response
fails the smoke rather than being treated as pending. Data-dependent checks
still report their skips when staging has no events or no cancelled fixture,
and the loud-skip ledger records those results. The step retries six times like
the public smoke, refuses any non-staging origin (production included), and
never logs the token, cookies or response bodies. It needs the
`staging`-environment `QA_AUTH_TOKEN` secret; without it the step writes the
per-check SKIP ledger as evidence and then fails closed, so a missing token
fails the deploy instead of passing with unverified guards.

Deployment context: the top-level Wrangler configuration names Worker
`two-web-next` and the `next.togetherweown.com` route; it has no named
`env.staging` block. The Hyperdrive resource name is not a Worker selector or
proof of environment isolation. The separate `env.production` block below
configures the production Worker; it is not authorization for a deployment,
database probe or production test.

### Production (gated automatic promotion)

Cutover decision state is recorded in `docs/cutover-gates.md` and the release
contract in `docs/releases.md`; this section describes the deployment contract,
not the currently serving version. Worker code reaches production only through
`.github/workflows/deploy-production.yml` (rollbacks through
`.github/workflows/rollback-production.yml`; production migrations through
`.github/workflows/db-migrate.yml`), all require `PRODUCTION_DEPLOY_ENABLED` to be
exactly `true`. The production workflow promotes automatically when
`e2e-staging` completes plus a daily 14:17 UTC schedule backstop, and keeps a
manually authorized dispatch for explicit redeploys; it never deploys on push,
PR or release. Automatic runs promote only a staging green that soaked 30
minutes with no newer red staging run, skip cleanly when production already
serves the target (`/up` revision marker) or there is nothing soaked and green,
and read the live production ledger via `/up` when the target journal has
entries production lacks: when the ledger holds every target web entry (set
inclusion), the run clears automatically; otherwise it stops with a clear
error (ledger lacks entries, ledger read failed, unusable target timestamp,
non-ok database, or a live Worker that predates the ledger signal —
automatic migration otherwise waits on the least-privilege migrator). An
unknown live commit after three `/up` reads also stops promotion. A manual
re-dispatch with `migrations_applied: true` records an audited continuation
past any stop once `db-migrate.yml` (target production) has applied the
target's migrations; automatic runs ignore that input and halt on those stops
unless the ledger already proves the target applied. The first promotion
after the ledger signal ships needs one manual dispatch because the live
Worker predates it. Repo
variable `PRODUCTION_HOLD_UNTIL` (ISO-8601 UTC, at most 24h ahead) pauses all
promotion while now is before its value. Before the deploy job can start,
`ci/production-deploy-gate.mjs` requires the repository variable
`PRODUCTION_DEPLOY_ENABLED` to be exactly `true`, verifies the live GitHub
Environment `production` protection and rejects the placeholder Hyperdrive id.
By default, protection requires nonempty reviewers with self-review prevented;
with `PRODUCTION_AUTO_APPROVE=true`, it instead requires a main-only deployment
policy and successful staging deploy and `e2e-staging` runs on the exact SHA,
whose `staging-quality` job (Lighthouse budgets and quality scores) must also
have executed and passed.
Both modes require successful exact-SHA CI. Admin bypass explicitly remains
enabled by the owner's provisioning exception; neither the workflow nor
the preflight claims to prevent an authorized administrator from bypassing review.
Missing protection, failed
API access, unset/false flag or any other ref fails closed. Both gate jobs inherit
`contents: read` and `actions: read`; the latter is required to
[read an Environment in this private repository](https://docs.github.com/en/rest/deployments/environments#get-an-environment--fine-grained-access-tokens).
The deploy job uses that Environment and checks the gate again after approval.
It uploads a Worker version tagged with the promoted SHA, GitHub run ID, and
run attempt (`sha` input, or by default the latest main commit whose post-deploy
e2e-staging journeys passed), then promotes that exact tag 5% → 50% → 100%
through the pinned central gradual-promote action, with per-stage health/SLO
gates pinned to the new version and automatic rollback to the recorded
pre-promote version on any in-action stage failure. Including the
run and attempt keeps retries of the same SHA unambiguous. `wrangler versions
upload` and `wrangler versions deploy` change code without re-syncing the
already-attached apex custom domain or other triggers. The workflow intentionally
does not reconcile trigger configuration from `wrangler.jsonc`; trigger changes
must be managed separately via [Production trigger reconciliation](docs/runbook.md#production-trigger-reconciliation-manual-domain-safe)
(CI pins the literal reviewed `env.production` schedule and consumer values,
so any change fails CI until the test is updated in the same release PR; the
authorized principal must still run the reconciliation for the change to take
effect in production). The workflow does not create resources or run
migrations/tests on production. Its post-deploy smoke runs
the same GET-only public-route set as staging
(`node bin/smoke.mjs https://togetherweown.com --allow-indexable`): `/up`
requires HTTP 200 with `db:ok` and `pending_migrations:0`, accepting
degraded queue states; unlike staging it omits `--fail-on-ready-wait-critical`,
so `critical` queue readiness only warns and `unknown` passes, and the remaining 15 routes assert
status/body/CSP/nosniff/content-type/redirect plus the apex indexing posture
(indexable HTML omits the staging noindex). No auth, no writes, no PII.
After the promotion reaches 100%, the workflow probes the apex again with the
same checker and retry contract (six attempts): verification gates release
publication, so six failed attempts fail the deploy job before the `release`
job can tag. A failed verification leaves the promoted candidate live at 100%
with the tag withheld; the gradual action's automatic rollback covers only
failures inside the promotion itself, so there is no automatic restore here.
The failed step prints `PREV_VERSION` as the recorded restoration target, and
the operator restores it manually through
`.github/workflows/rollback-production.yml` with that version id. An inline
rollback stays out of the deploy workflow: the rollback path checks the target
version's secrets first.
The smoke runs only inside an authorized production deployment run. Routine
tests and probes stay staging-only; production live checks run only inside the
authorized cutover (`docs/cutover-check.md`) or incident (`docs/runbook.md`)
procedures.

`env.production` in `wrangler.jsonc` configures the production
Worker. Never deploy it outside the gated workflow:

- Worker: `two-web-next-production`; workers.dev and preview URLs disabled.
- Route/origin: `togetherweown.com` / `https://togetherweown.com`, the production
  apex target. Defining it does not flip DNS; deploying would
  claim that custom domain, so deploy only through the gated workflow.
- Hyperdrive `DB`: the separately named `two-web-next-production` Hyperdrive
  with its provisioned id in `wrangler.jsonc` `env.production`, distinct from
  the staging Hyperdrive. The all-zero id `00000000000000000000000000000000`
  is only the inert sentinel `ci/production-deploy-gate.mjs` refuses; it never
  lives in config or deploys.
- Queues: `two-web-next-production-sync-event` and
  `two-web-next-production-internal-action` are the production queue names,
  kept separate from staging; complete provisioning before a deployment is
  authorized. Producers and consumers
  use these names; crons match staging (every ten minutes, midnight UTC).
- Vars are explicit because environment bindings/vars do not inherit. Register
  the production Discord callback; provision secrets for the production Worker
  separately. Never set `QA_AUTH_TOKEN` or a staging `DATABASE_URL` in production.

Whoever is authorized to provision production must keep the live `production`
Environment configured with a main-only deployment branch policy and, by
default, required reviewers with self-review prevented; with
`PRODUCTION_AUTO_APPROVE=true` the reviewer requirement is replaced by
successful staging deploy and `e2e-staging` runs on the exact SHA, with an
executed, passing `staging-quality` job (which the gate checks), while the branch
policy stays required. Install the
Environment-scoped secrets
`PRODUCTION_CLOUDFLARE_API_TOKEN` and `PRODUCTION_CLOUDFLARE_ACCOUNT_ID`, and
complete resource/secret provisioning before a deployment is authorized. These names must
exist only in the `production` Environment, never at repository or organization
scope. They map to Wrangler's `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
variables only in the credential check and deployment steps. Missing/empty values
are rejected before deployment, so absent production secrets cannot fall back to
the staging secret names. No secret values are printed.

Keep `PRODUCTION_DEPLOY_ENABLED` unset/false except while a deployment,
rollback, or production migration is authorized, including applicable
organization and Environment values.
The deploy, rollback, and db-migrate workflows each require the flag to be
exactly `true`; `ci/production-deploy-gate.mjs` runs in the deploy and rollback
workflows, while db-migrate relies on the flag, the main-only ref check, and
production Environment protection. The
workflow's `vars` expression resolves configuration across scopes:
repository/Environment absence alone does not prove the effective flag is
disabled. Verify the organization's value and repo visibility before
authorizing a deployment, rollback, or production migration; keep the repository value unset/false otherwise.
GitHub YAML alone does **not** install review protection.
A failed protection lookup must be resolved with the existing credential's
provisioning owner, not by removing the check or substituting credentials.

CI runs these offline checks with no production credentials or database access:

```sh
node --test ci/production-deploy-gate.test.mjs
npx wrangler deploy --dry-run --env production --outdir dist-production
```

The selftest proves disabled flags fail before API access, non-main/non-manual
requests fail, missing/unprotected Environments fail, and the Hyperdrive sentinel
blocks deployment. Running these checks, or editing this documentation, deploys
nothing and probes nothing in production.

## Configuration

[docs/config.md](docs/config.md) inventories every `Env`/`JobsEnv` key and every
actual Wrangler variable/binding. `npm run check` runs
`ci/check-config-docs.mjs` and its selftests; missing, removed, duplicate or
incomplete rows fail CI. Secret **names**, never values, belong in documentation.

### Image and frame policy

Featured images must be full HTTPS URLs (255 characters maximum), with alt text,
no credentials, and no non-default port. IP literals (including alternate IPv4
spellings and IPv6), single-label hosts, localhost and private/reserved DNS
suffixes (including `.localdomain`, `.alt`, `.corp`, `.mail` and their descendants)
are rejected, even when configured. `FEATURED_IMAGE_HOSTS` accepts hostnames only, not schemes,
paths, ports or wildcards; invalid entries are ignored, never inserted into CSP.
Hosts match exactly, not their subdomains. The Discord CDN is always permitted
for avatars and featured images; add other hosts only after approving the host
and its content. The shipped variable is empty: arbitrary remote image URLs are
not admitted. Existing remote images on unapproved hosts are suppressed until
edited or their host is approved. Legacy same-site images render as local paths
under `'self'`; new form submissions still require an approved full HTTPS URL.

`img-src` permits `'self'` for site assets plus HTTPS on those same approved
hosts. This is a browser-load policy, not a server image fetch/proxy or DNS
resolution check. Approved hosts must remain publicly routed and trustworthy;
CSP also blocks redirects outside its sources. Removing a host blocks existing
images on it. No proxying or resizing is performed.

Only GET/HEAD `/join` permits frames, and only from `https://discord.com` for
the widget. Other routes have `frame-src 'none'`; `frame-ancestors 'none'` and
`X-Frame-Options: DENY` still prevent framing this site. CSP reports violations
to `/csp-reports` through the `csp-endpoint` reporting group (`report-to` plus the
`Reporting-Endpoints` header). The deprecated `report-uri` directive is not sent.

## Pre-flip probes (W16 rehearsal)

Ports of legacy `discord:check-moderators` and `bot:internal-action-smoke`
(`docs/parity.md` §7). Neither ever targets production — the role probe is
network-free (it checks resolved config) and the smoke requires a valid
`BOT_PRODUCTION_URL`, refuses that entire hostname regardless of port or DNS
root dot, and rejects redirects. Both URLs must be HTTP(S), without credentials,
query strings or fragments. A distinct hostname alone does not prove staging
isolation: the runtime/receiver/custody holds still apply.

```sh
npm run check:worker-moderators                   # source deployment preflight
npm run check:moderators -- --require-configured   # process-env fixture/local probe
npm run smoke:internal-action -- \
  --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway>
APP_URL=https://next.togetherweown.com npm run drill:internal-action -- \
  --discord-id=<drill identity> --role-key=<key> --channel-key=<throwaway>
```

`npm run check:moderators -- --help` prints usage to stdout and reads nothing;
`--json` emits the findings verdict. Both this probe and `audit:moderator-roles`
use the [offline operator-probe contract](docs/operator-probes.md): usage/input
refusals with `--json` are one versioned safe error on stderr, stdout empty,
exit 2. Comparison verdicts and exits 0/1 are unchanged.
`npm run check:worker-moderators` parses
the top-level `vars.DISCORD_MODERATOR_ROLE_IDS` and `vars.DISCORD_GUILD_ID` in
`web/wrangler.staging.jsonc`; `npm run check:worker-moderators-production` parses
`env.production.vars` in `wrangler.jsonc`. Each requires exactly its guild-bound
Owner+Moderator pair (staging guild `1545644954272137297`:
`1546211363578191873,1545648550329851946`; production guild
`326474832151838730`: `1546777855801954408,1546777856984481792`) before deployment.
The staging workflow deploys `web/wrangler.staging.jsonc` and supplies only the
validated `KIT_ROUTE_ARCHIVE` and `KIT_ROUTE_STATIC` route flags with `--var`;
it does not override either moderator var. A separate GitHub moderator secret
cannot make the gate pass. `keep_vars` retains unrelated remote plaintext vars,
and Wrangler retains remote secrets. No binding values are read back or copied.
The preflight proves source configuration, **not live isolation or a successful
deployment**. Blank config remains a valid local revocation state, but
unapproved extra roles (including duplicates) fail the probe, as does a pair
that belongs to the other guild — role IDs are guild-scoped, so a production
pair in the staging config matches nobody while looking configured.

The live smoke runs manually via the `staging-smoke` workflow in a job container
(`[self-hosted, two-selfhosted]` while the repo is private, GitHub-hosted while
public; TOG-12326). It posts a real announcement to a throwaway channel and
creates a real staging event. Dispatch only after
the existing staging isolation/HMAC prerequisites and independent review clear.
Pass `--announcement-only` (workflow input `announcement_only`) to run only
`announcement.post` and its same-key replay check, for a receiver that does not
implement `role.assign` or `event.upsert`; then only `--channel-key` is needed.
Both probes are fixture-tested in `check` without real secrets.

For smoke/drill help, effect-free preview (default or `--dry-run`), explicit
apply, JSON errors and repeat-run identities, use the single
[bot probe staging procedure](docs/bot-probe-staging.md). Both tools' `--help`
links there without reading target or credential configuration.

The CallInternalAction drill (`drill:internal-action`) ports the remaining
drill-only half of `docs/parity.md` §6: production web never dispatches
CallInternalAction, so instead of a web route it drives the real queued
producers and `handleCallInternalAction` (attempts=1) directly against staging.
It refuses both the production bot host and the production web apex (`APP_URL`
is mandatory and `https://togetherweown.com` is refused), performs a real
staging role.assign and posts a real announcement to a throwaway channel, and
never upserts events. Fixture-tested in `check` without real secrets.

These probe-only process settings are not Worker `Env`/`JobsEnv` bindings:

| Name | Kind | Notes |
| --- | --- | --- |
| `BOT_ENDPOINT_URL` | secret (staging bot) | Base URL of the staging bot's internal-actions endpoint. The smoke refuses to run without an explicit target. |
| `BOT_SHARED_SECRET` | secret | HMAC secret the staging bot holds for our key id. Env only; never printed or logged. |
| `BOT_KEY_ID` | var | Which shared secret signs the smoke (lets the bot rotate per caller). |
| `BOT_PRODUCTION_URL` | var, required | Valid production bot URL. Missing/malformed exclusion fails closed before actions; the entire hostname is refused regardless of port. |

## Contributing

Squash-merge only; PR titles follow Conventional Commits and the body follows the
[PR template](.github/pull_request_template.md). No internal card IDs in PR text.
`ci-ok`, `gitleaks`, `e2e-ok` and `pr-lint` are required, plus Paperclip Review 5/5
on the exact green head. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
