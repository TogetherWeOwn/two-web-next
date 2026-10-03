# two-web-next

[![Release](https://img.shields.io/github/v/release/TogetherWeOwn/two-web-next)](https://github.com/TogetherWeOwn/two-web-next/releases)

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), the frozen legacy
repository: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest,
[Drizzle](https://orm.drizzle.team) + Postgres, server-rendered HTML with plain
JavaScript islands. The [parity matrix](docs/parity.md) tracks the migration;
migration plan: TOG-9671.
Shared-DB foundation (topology, numbering, backups): [docs/db-migrations.md](docs/db-migrations.md).
Operations (deploy/rollback, `/up`, queues, outages and restore drills):
[docs/runbook.md](docs/runbook.md).

## What works today

- Homepage, rules (optional last-updated stamp), privacy page, branded error pages,
  manifest/icons, canonical URLs, sitemap, robots and security/cache headers.
  Homepage member counts currently show an unavailable state, not live statistics.
- Discord sign-in (`identify` + `guilds.join`) and the join journey, including
  fallback invite and join-attempt audit. The OAuth access token is used once,
  never stored. OAuth-state and session cookies contain signed random values;
  only persisted session tokens are hashed. Authenticated views rotate session
  tokens and logout revokes them.
- Moderator status is recomputed at login from Discord snowflake role IDs (not
  names); missing configuration or failed lookups fail closed. The QA sign-in
  seam requires the exact staging `APP_URL` configuration and is disabled
  without its token; that configuration gate is not a request-host allowlist.
- Member-gated `/profile` and `/members/:user` views, plus self-only profile
  edits. Member-data access is recorded; log-write failures refuse reads by
  default.
- Event listing, calendar and past-event islands, event detail/search, iCalendar
  and Google Calendar links, event feeds, RSVP/leave endpoints and going counts.
  RSVP endpoints are implemented; the event detail page does not yet mount an
  RSVP-button island.
- Moderator admin screens: event and featured-event CRUD, read-only RSVP roster,
  join audit and funnel summary.
- Guarded agent-event ingress with caller/guild validation, idempotency and
  outer rate limiting. CSP report ingestion and human-route throttle responses
  have fixture coverage; the general human throttle currently needs an explicit
  `DATABASE_URL` (the Hyperdrive-only path does not enforce it).
- Worker queue/scheduler scaffolding: retries, locking, queue ledger,
  `events:reconcile`, retention pruning and readiness `/up` (503 on DB/schema failure or a missing required secret).
  Bot/Discord adapters are still reject-all stubs; the separate event write-back
  queue is not bound. These are not a claim of end-to-end live bot parity.

## Moderator guides

- [Moderator admin guide](docs/moderator-admin-guide.md): Next admin routes,
  event and featured-content workflows, dashboard diagnostics, and safe escalation.
- [Troubleshooting join and Discord sign-in](docs/troubleshooting-join.md):
  current notices, recovery pages, and the invite fallback.

## Develop and test safely

Use Node **22.18.0+ on the 22.x line, or 24+** (CI uses Node 24; the probe CLIs
require default native TypeScript stripping, not early Node 22/23 releases).
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
`agent-testdb` (database `two_web_next`, user `agent_test`, empty password), the
CI job's disposable Postgres service, or local fixtures. **Never point tests,
probes or verification at a production or staging database.** If access fails,
stop; do not substitute another credential or database.

```sh
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/two_web_next"
npm run db:migrate    # apply the tracked migrations to this test database
npm run db:check      # validate migration history
npm run format        # formatting only; no lint fixes or import reordering
npm run lint          # read-only Biome lint + format gate
npm run check         # lint + format + types + config drift/selftest + Vitest (including SQL suites)
```

For schema changes, `npm run db:generate` generates a migration; use the web
numbering range `1000–1999` described in [docs/db-migrations.md](docs/db-migrations.md).
Review generated SQL before applying it. Do not edit existing migrations.

Always supply the test URL for full-suite runs. Most live suites skip when
`DATABASE_URL` is unset, but `test/review-p1-verify.test.ts` falls back to
agent-testdb's `postgres` database, so an unset URL is not an offline run.
Tests must use agent-testdb or disposable CI service containers, never
production or staging databases. Legacy suites clear shared tables: do not
run concurrent suites against the same test database.

## Coverage ratchet

```sh
DATABASE_URL="postgres://agent_test@agent-testdb:5432/two_web_next" npm run test:coverage
node ci/coverage-summary.mjs
```

Apply migrations to that test database first. Coverage includes every
`src/**/*.{ts,tsx}` file, even if no test imports it. Global and aggregate
area floors (`src/admin`, `src/events`, `src/join`, `src/sessions.ts`) live in
`vitest.config.ts`. The baseline uses the full suite with the test database;
without it, skipped live suites may put coverage below the floors. CI's
required `check` job runs the configuration drift check, Biome lint/format gate,
typecheck and the coverage gate against its Postgres service, writes a job summary
with the ten least-covered files, and uploads HTML, LCOV and JSON reports for 14 days,
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

```sh
npm run build:assets                 # regenerate public/ from assets/
npm run build:assets:check           # fail when the output drifted
npm run config:check                 # drift check + its local-fixture selftests
npx wrangler deploy --dry-run --outdir dist   # bundle check; does not deploy
```

Do not use `npm run deploy` as a test or build command.

## Deploy

Push to `main` runs `check`, then `deploy-staging` (GitHub Environment `staging`
gate): `wrangler deploy` with the repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, followed by `node bin/smoke.mjs https://next.togetherweown.com`.
The staging smoke checks `/up`, the public pages and feeds, sitemap, robots,
Discord and guest auth redirects, and a branded 404. It checks CSP and nosniff
on every response and staging noindex on returned HTML (the application's header
contract). `/up` requires HTTP 200 with `db:ok` and `pending_migrations:0` (DB/schema
readiness); degraded or unknown queue health alone does not fail deployment. Redirects are not followed; each
request/body has a 5-second timeout. A failure names the route and expected versus
actual result and fails the deploy job after six attempts. That workflow remains
staging-only; the separate production workflow below stays disabled until
authorized cutover (plan TOG-9671, W16).
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
when the first page has one, and the malformed-key 422/404 refusals. Until
PR #109 (`GET /events/:key` show route plus the collection `meta` envelope)
is deployed, the checker detects the missing show route (guest probe gets the
app's branded 404) and skips the five contract-dependent checks visibly
instead of failing the deploy; probes that already hold on main (guest
collection 401, QA login, malformed `event_key` 422) stay unconditional. The
step retries six times like the public smoke, refuses any non-staging origin
(production included), and never logs the token, cookies or response bodies.
It needs the `staging`-environment `QA_AUTH_TOKEN` secret; without it the step
reports its skip and passes, so a missing token never fails a deploy.

Deployment context: the top-level Wrangler configuration names Worker
`two-web-next` and the `next.togetherweown.com` route; it has no named
`env.staging` block. The Hyperdrive resource name is not a Worker selector or
proof of environment isolation. The separate `env.production` block below is
a disabled cutover template, not authorization for a live deployment, database
probe or production cutover.

### Production (manual, disabled until cutover)

`.github/workflows/deploy-production.yml` accepts only `workflow_dispatch` on
`main`; it never deploys on push, PR or release. Before the deploy job can start,
`ci/production-deploy-gate.mjs` requires the repository variable
`PRODUCTION_DEPLOY_ENABLED` to be exactly `true`, verifies the live GitHub
Environment `production` has nonempty required reviewers with self-review
prevented, and rejects the placeholder Hyperdrive id. Admin bypass explicitly
remains enabled by the owner's provisioning exception; neither the workflow nor
the preflight claims to prevent an authorized administrator from bypassing review.
Missing protection, failed
API access, unset/false flag or any other ref fails closed. Both gate jobs inherit
`contents: read` and `actions: read`; the latter is required to
[read an Environment in this private repository](https://docs.github.com/en/rest/deployments/environments#get-an-environment--fine-grained-access-tokens).
The deploy job uses that Environment, checks the gate again after approval, and
deploys the dispatch SHA with `wrangler deploy --env production`. It does not
create resources or run migrations/tests on production. Its post-deploy smoke runs
the same GET-only public-route set as staging
(`node bin/smoke.mjs https://togetherweown.com --allow-indexable`): `/up`
requires HTTP 200 with `db:ok` and `pending_migrations:0`, accepting
degraded/unknown queue states like staging, and the remaining 15 routes assert
status/body/CSP/nosniff/content-type/redirect plus the apex indexing posture
(indexable HTML omits the staging noindex). No auth, no writes, no PII.
The smoke runs only after a separately authorized production deployment; no
production probe is performed by delivering or testing this template.

`env.production` is a **cutover template**, not a live deployment:

- Worker: `two-web-next-production`; workers.dev and preview URLs disabled.
- Route/origin: `togetherweown.com` / `https://togetherweown.com`, the intended
  apex **placeholder target**. Defining it does not flip DNS; deploying would
  claim that custom domain, so do not deploy before W16 authorization.
- Hyperdrive `DB`: all-zero id `00000000000000000000000000000000` is an inert
  dry-run placeholder, never the staging Hyperdrive. Provision the separately
  named `two-web-next-production` Hyperdrive and replace the id in a reviewed
  cutover PR.
- Queues: `two-web-next-production-sync-event` and
  `two-web-next-production-internal-action` are reserved, unprovisioned names;
  provision both separately from staging before cutover. Producers and consumers
  use these names; crons match staging (every ten minutes, midnight UTC).
- Vars are explicit because environment bindings/vars do not inherit. Register
  the production Discord callback; provision secrets for the production Worker
  separately. Never set `QA_AUTH_TOKEN` or a staging `DATABASE_URL` in production.

Before enabling the flag, the authorized provisioning actor must configure the
live `production` Environment's required reviewers, prevent self-review and
main-only deployment policy, install the Environment-scoped secrets
`PRODUCTION_CLOUDFLARE_API_TOKEN` and `PRODUCTION_CLOUDFLARE_ACCOUNT_ID`, and
complete resource/secret provisioning and W16 authorization. These names must
exist only in the `production` Environment, never at repository or organization
scope. They map to Wrangler's `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
variables only in the credential check and deployment steps. Missing/empty values
are rejected before deployment, so absent production secrets cannot fall back to
the staging secret names. No secret values are printed.

Keep `PRODUCTION_DEPLOY_ENABLED` unset/false until then, including applicable
organization and Environment values. The workflow's `vars` expression resolves
configuration across scopes: repository/Environment absence alone does not
prove the effective flag is disabled. Verify the organization's value and repo
visibility before cutover; keep the repository value unset/false while disabled.
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
blocks live deployment. No production deploy, DNS flip or W16 rehearsal is
performed by adding this template. Actual production rollout and tested rollback
remain W16 work (plan TOG-9671).

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
`X-Frame-Options: DENY` still prevent framing this site. CSP continues reporting
to `/csp-reports` via both `report-uri` and the `csp-endpoint` reporting group.

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

The deployment preflight parses the **top-level** `vars.DISCORD_MODERATOR_ROLE_IDS`
in `wrangler.jsonc` and requires exactly the approved SySOp ID, before any queue
creation or deployment. `wrangler deploy --config wrangler.jsonc` consumes that
same source value, without `--env`/`--var` overrides; a separate GitHub moderator
secret cannot make the gate pass. `keep_vars` retains unrelated remote plaintext
vars, and Wrangler retains remote secrets. No binding values are read back or
copied. The preflight proves source configuration, **not live isolation or a
successful deployment**. Blank config remains a valid local revocation state,
but unapproved extra roles (including duplicates) fail the probe.

The live smoke runs manually via the `staging-smoke` workflow in a job container
(`[self-hosted, two-selfhosted]` while the repo is private, GitHub-hosted while
public; TOG-12326). It posts a real announcement to a throwaway channel and
creates a real staging event. Dispatch only after
the existing staging isolation/HMAC prerequisites and independent review clear.
Pass `--announcement-only` (workflow input `announcement_only`) to run only
`announcement.post` and its same-key replay check, for a receiver that does not
implement `role.assign` or `event.upsert`; then only `--channel-key` is needed.
Both probes are fixture-tested in `check` without real secrets.

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
`check`, `gitleaks` and `pr-lint` are required. Review the exact green head before
merge. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
