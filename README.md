# two-web-next

The Together We Own website, rebuilt for Cloudflare Workers. It replaces
[two-web](https://github.com/TogetherWeOwn/two-web) (Laravel), which is now in
maintenance mode: fixes only, no new features.

Stack: [Hono](https://hono.dev) on Cloudflare Workers, TypeScript, Vitest. Postgres
(Neon via Hyperdrive) arrives with the data slices. Migration plan: TOG-9671.

## What works today

- Homepage.
- Sign in with Discord (`identify` + `guilds.join`). On sign-in the Owen bot adds the
  member to the TWO server automatically; if that fails, sign-in still succeeds and the
  page offers the invite link. The Discord access token is used once and never stored.
- Signed, HttpOnly `__Host-` session cookie; OAuth `state` bound to a signed cookie.

## Develop

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in locally; never commit
npm run dev
npm run check                    # typecheck + tests
```

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

## Contributing

Squash-merge only; PR titles follow Conventional Commits and the body carries
`Refs: TOG-1234`. `check`, `gitleaks` and `pr-lint` are required.

## License

Business Source License 1.1, converting to MIT three years after each release. See [LICENSE](LICENSE).
