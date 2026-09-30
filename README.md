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
  `events:reconcile`, retention pruning and always-200 `/up`.
  Bot/Discord adapters are still reject-all stubs; the separate event write-back
  queue is not bound. These are not a claim of end-to-end live bot parity.

## Develop and test safely

Use Node **22+** (CI uses Node 24). Install development dependencies even when
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
npm run check         # types + config drift/selftest + Vitest (including SQL suites)
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
required `check` job runs the configuration drift check, typecheck and the
coverage gate against its Postgres service, writes a job summary with the ten
least-covered files, and uploads HTML, LCOV and JSON reports for 14 days,
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
use real guild sign-in as a test fixture. `/up` is the liveness signal (always
200, queue health folded in, no auth); use the SQL suites for database
verification. This exercises direct Postgres, not Hyperdrive pooling. Miniflare requires a nonempty password for a Hyperdrive
local connection string, so the passwordless authorized URL cannot be used as
that override. **Do not invent a password or substitute credentials.** Never
deploy the local config.

Do not use remote development for tests. Many SQL suites skip if `DATABASE_URL`
is unset, but that is not full database verification; some existing tests also
use the test container directly. The commands above deliberately set one safe
URL. CI migrates its own `postgres:17` service before running `npm run check`.

### Islands and build checks

`public/islands/*.js` are checked-in browser scripts, with contracts in
`src/islands/contracts.ts`. **There is no separate islands build command** and
no frontend framework bundle to generate. Wrangler serves `public/` as static
assets; island tests verify the scripts and server-rendered mount contracts.

```sh
npm run config:check                 # drift check + its local-fixture selftests
npx wrangler deploy --dry-run --outdir dist   # bundle check; does not deploy
```

Do not use `npm run deploy` as a test or build command.

## Deploy

Push to `main` runs `check`, then `deploy-staging` (GitHub Environment `staging`
gate): `wrangler deploy` with the repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, followed by a `/up` smoke test against
https://next.togetherweown.com. The smoke checks HTTP 200 and the expected health
envelope for liveness, not database readiness: degraded or unknown queue health
does not fail deployment. There is deliberately no production job:
production (togetherweown.com) is only switched at cutover (plan TOG-9671, W16).
Full procedures live in [docs/runbook.md](docs/runbook.md).

Deployment context: the top-level Wrangler configuration names Worker
`two-web-next` and the `next.togetherweown.com` route; it has **no named
`env.staging` or `env.production` blocks**. The Hyperdrive resource name is not
a Worker selector or proof of environment isolation. This reference does not
authorize a live deployment, database probe or production cutover.

## Configuration

[docs/config.md](docs/config.md) inventories every `Env`/`JobsEnv` key and every
actual Wrangler variable/binding. `npm run check` runs
`ci/check-config-docs.mjs` and its selftests; missing, removed, duplicate or
incomplete rows fail CI. Secret **names**, never values, belong in documentation.

## Contributing

Squash-merge only; PR titles follow Conventional Commits and the body carries
`Refs: TOG-1234`. `check`, `gitleaks` and `pr-lint` are required. Review the exact
green head before merge. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
