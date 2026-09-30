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
https://next.togetherweown.com. There is deliberately no production job:
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
| `FEATURED_IMAGE_HOSTS` | var | Additional approved image hosts, comma-separated exact DNS names (e.g. `images.unsplash.com`). Empty/unset permits only `cdn.discordapp.com`. Used by both featured form validation and CSP. |

### Image and frame policy

Featured images must be full HTTPS URLs (255 characters maximum), with alt text,
no credentials, and no non-default port. IP literals (including alternate IPv4
spellings and IPv6), single-label hosts, localhost and private/reserved DNS
suffixes (including `.localdomain` and `.alt` and their descendants) are rejected,
even when configured. `FEATURED_IMAGE_HOSTS` accepts hostnames only, not schemes,
paths, ports or wildcards; invalid entries are ignored, never inserted into CSP.
Hosts match exactly, not their subdomains. The Discord CDN is always permitted
for avatars and featured images; add other hosts only after approving the host
and its content. The shipped variable is empty: arbitrary remote image URLs are
not admitted. Existing rows on unapproved hosts remain browser-blocked until
edited or their host is approved.

`img-src` permits `'self'` for site assets plus HTTPS on those same approved
hosts. This is a browser-load policy, not a server image fetch/proxy or DNS
resolution check. Approved hosts must remain publicly routed and trustworthy;
CSP also blocks redirects outside its sources. Removing a host blocks existing
images on it. No proxying or resizing is performed.

Only GET/HEAD `/join` permits frames, and only from `https://discord.com` for
the widget. Other routes have `frame-src 'none'`; `frame-ancestors 'none'` and
`X-Frame-Options: DENY` still prevent framing this site. CSP continues reporting
to `/csp-reports` via both `report-uri` and the `csp-endpoint` reporting group.

## Contributing

Squash-merge only; PR titles follow Conventional Commits and the body carries
`Refs: TOG-1234`. `check`, `gitleaks` and `pr-lint` are required.

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
