# two-web-next

[![Release](https://img.shields.io/github/v/release/TogetherWeOwn/two-web-next)](https://github.com/TogetherWeOwn/two-web-next/releases)

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), the frozen legacy
repository: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest,
[Drizzle](https://orm.drizzle.team) + Postgres, server-rendered HTML with plain
JavaScript islands. The [parity matrix](docs/parity.md) tracks the migration;
[database foundations](docs/db-migrations.md) cover topology and numbering.

## What works today

- Homepage, rules (optional last-updated stamp), privacy page, branded error pages,
  manifest/icons, canonical URLs, sitemap, robots and security/cache headers.
  Homepage member counts currently show an unavailable state, not live statistics.
- Discord sign-in (`identify` + `guilds.join`) and the join journey, including
  fallback invite and join-attempt audit. The OAuth access token is used once,
  never stored. Signed OAuth-state cookies and DB-backed sessions store only
  token hashes; authenticated views rotate tokens and logout revokes them.
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
  `events:reconcile`, retention pruning, `/health` and always-200 `/up`.
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

For local development, keep Hyperdrive local as well as the explicit URL:

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB="$DATABASE_URL" npm run dev
```

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

## Deployment context

The existing workflow runs checks before its gated `deploy-staging` job and
`/health` smoke. The top-level Wrangler configuration names Worker `two-web-next`
and the `next.togetherweown.com` route; it has **no named `env.staging` or
`env.production` blocks**. The Hyperdrive resource name is not a Worker
selector or proof of environment isolation. This reference does not authorize a
live deployment, database probe or production cutover. Operational procedures
remain outside this README refresh.

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
