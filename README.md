# two-web-next

[![Release](https://img.shields.io/github/v/release/TogetherWeOwn/two-web-next)](https://github.com/TogetherWeOwn/two-web-next/releases)

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), which is now in
maintenance mode: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest,
[Drizzle](https://orm.drizzle.team) + Postgres. Migration plan: TOG-9671.
Shared-DB foundation (topology, numbering, backups): [docs/db-migrations.md](docs/db-migrations.md).

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

`test/db.test.ts` does a live round-trip when `DATABASE_URL` is set and skips
otherwise, so the cold CI run (no test-DB access) stays green.

## Deploy

Push to `main` runs `check`, then `deploy-staging` (GitHub Environment `staging`
gate): `wrangler deploy` with the repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, followed by a `/health` smoke test against
https://next.togetherweown.com. That workflow remains staging-only.

### Production (manual, disabled until cutover)

`.github/workflows/deploy-production.yml` accepts only `workflow_dispatch` on
`main`; it never deploys on push, PR or release. Before the deploy job can start,
`ci/production-deploy-gate.mjs` requires the repository variable
`PRODUCTION_DEPLOY_ENABLED` to be exactly `true`, verifies the live GitHub
Environment `production` has nonempty required reviewers with self-review
prevented, and rejects the placeholder Hyperdrive id. Missing protection, failed
API access, unset/false flag or any other ref fails closed. The deploy job uses
that Environment, checks the gate again after approval, and deploys the dispatch
SHA with `wrangler deploy --env production`. It does not create resources or run
migrations/tests on production. Its `/health` smoke is DB-free liveness only,
not a database-readiness or cutover proof.

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
main-only deployment policy, install environment-scoped Cloudflare credentials,
and complete resource/secret provisioning and W16 authorization. Keep the flag
unset/false until then. GitHub YAML alone does **not** install review protection.
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
