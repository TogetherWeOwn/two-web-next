# two-web-next

[![Release](https://img.shields.io/github/v/release/TogetherWeOwn/two-web-next)](https://github.com/TogetherWeOwn/two-web-next/releases)

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), which is now in
maintenance mode: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest,
[Drizzle](https://orm.drizzle.team) + Postgres. Migration plan: TOG-9671.
Shared-DB foundation (topology, numbering, backups): [docs/db-migrations.md](docs/db-migrations.md).
Operations (deploy/rollback, `/up`, queues, outages and restore drills):
[docs/runbook.md](docs/runbook.md).

## What works today

- Homepage.
- Sign in with Discord (`identify` + `guilds.join`). On sign-in the Owen bot adds the
  member to the TWO server automatically; if that fails, sign-in still succeeds and the
  page offers the invite link. The Discord access token is used once and never stored.
- Signed, HttpOnly `__Host-` session cookie carrying a random token; OAuth `state` bound to a signed cookie.
- DB-backed sessions (Postgres `web_sessions`, token hashes only): rotation on every authenticated view, logout revokes, replays become guests.
- Moderator flag recomputed at login from Discord snowflake role IDs (never names) via the bot token; blank allowlist and failed lookups fail closed without blocking sign-in.
- Staging-only QA seam (`POST /auth/qa/:identity`): 404s everywhere but the staging host with `QA_AUTH_TOKEN` set.

## Develop

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in locally; never commit
npm run dev
npm run check                    # typecheck + tests
```

## Database (Drizzle)

Schema lives in `src/db/`; migrations in `drizzle/`. Until Neon exists (S1),
local dev and tests run against `agent-testdb` (database `two_web_next`):

```sh
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/two_web_next"
npm run db:generate   # new migration from schema changes
npm run db:migrate    # apply to DATABASE_URL
npm run db:check      # schema-vs-migrations consistency
```

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
required `check` job runs typecheck and the coverage gate against its
Postgres service, writes a job summary with the ten least-covered files,
and uploads HTML, LCOV and JSON reports for 14 days, including on failure.

When intentionally raising a floor, re-measure with the same locked provider
and Node 24 against the test database, leave a one-percentage-point margin
(rounded down to one decimal place), and include the summary in the PR.
Never lower a floor simply to make a regression pass.

## Deploy

Push to `main` runs `check`, then `deploy-staging` (GitHub Environment `staging`
gate): `wrangler deploy` with the repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, followed by a `/up` smoke test against
https://next.togetherweown.com. The smoke checks HTTP 200 and the expected health
envelope for liveness, not database readiness: degraded or unknown queue health
does not fail deployment. There is deliberately no production job:
production (togetherweown.com) is only switched at cutover (plan TOG-9671, W16).

## Configuration

| Name | Kind | Notes |
| --- | --- | --- |
| `APP_URL` | var | Public origin; the OAuth callback is `${APP_URL}/auth/discord/callback` and must be registered on the Discord application. |
| `DISCORD_CLIENT_ID` | var | Owen application (public). |
| `DISCORD_GUILD_ID` | var | TWO server. |
| `DISCORD_INVITE_URL` | var | Fallback invite when auto-join fails. |
| `DISCORD_CLIENT_SECRET` | secret | `wrangler secret put` |
| `DISCORD_BOT_TOKEN` | secret | Same application as the client id (Discord requires it for `guilds.join`). Needs Create Instant Invite in the guild. |
| `SESSION_SECRET` | secret | 32+ random bytes. |
| `DATABASE_URL` | var (dev) / Hyperdrive binding (staging/prod) | Local/dev: agent-testdb. Without it sessions cannot persist (per-request memory store, fails closed to guest). |
| `DISCORD_MODERATOR_ROLE_IDS` | var | Snowflake IDs, comma-separated, never names. Blank = nobody is a moderator (safe default). |
| `QA_AUTH_TOKEN` | secret (staging only) | Enables `POST /auth/qa/:identity`. Unset everywhere else; the route 404s without it. |

## Contributing

Squash-merge only; PR titles follow Conventional Commits and the body carries
`Refs: TOG-1234`. `check`, `gitleaks` and `pr-lint` are required.

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
