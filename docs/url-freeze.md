# URL freeze (W4, [TOG-9683](/TOG/issues/TOG-9683))

Source: [TOG-9016](/TOG/issues/TOG-9016) §2 parity map + [TOG-9671 plan](/TOG/issues/TOG-9671#document-plan)
§3. These paths are byte-identical across the strangler cutover: the new
Worker must answer them exactly where the Laravel app answers them today.
Any intentional change needs a 301 map entry, not a silent move.

## Frozen in this slice (W4 — implemented, tested)

| Path | Legacy source | Status |
|---|---|---|
| `/` | `HomeController` + bot counts + featured rows | ✅ degraded-shell: layout/copy/meta; live counts + featured rows arrive with the data slices (the page already renders the degraded state) |
| `/discord` | `routes/funnel.php` + `DiscordInviteController` (302, `no-store`) | ✅ |
| `/about` | `routes/funnel.php` `Route::view` | ✅ |
| `/faq` | `routes/funnel.php` `Route::view` | ✅ |
| `/rules` | `routes/web.php` `Route::view` | ✅ (invalid `RULES_LAST_UPDATED` hides the stamp, TOG-7323) |
| `/sitemap_index.xml` | `routes/web.php` sitemap closure | ✅ static entries; published `/e/{key}` rows land with W8 |
| `/robots.txt` | `routes/web.php` robots closure (per-env host, TOG-7071) | ✅ |
| `/join` | `JoinController` landing page (one-click button + invite fallback + widget) | ✅ W6: database-free leaf, in sitemap (monthly, 0.9) |
| `/join/discord` | `JoinController` OAuth start (`identify` + `guilds.join`, `throttle:10,1`) | ✅ W6: Postgres throttle, signed `join_source` / `join_next` cookies |
| `/join/callback` | `JoinController` OAuth callback (synchronous bot add, then sign-in) | ✅ W6: synchronous `PUT /guilds/{guild}/members/{user}`, one `join_attempts` row per terminal path |

Crawl-set contract (TOG-7072): published events only. Drafts 403 for guests,
cancelled answers 410 Gone (TOG-6781), past events are never indexed. The
route-level 403/410 for `/e/{key}` land with W8; `crawlableEvents` in
`src/seo.ts` already pins the sitemap side.

## Frozen later (owning slice)

| Path | Owner |
|---|---|
| `/events`, `/events/past` | W8 |
| `/e/{key}` | W8 |
| `/events.json` | W8 |
| `.ics` / `.rss` feeds | W9 |
| `/profile`, `/members/{user}` | W7 |
| `/admin/*` | W11–W12 |
| `/healthz`, `/up` | deploy health (this repo serves `/healthz` since W3) |

Note: legacy `/join*` is the one-click OAuth journey; this repo's equivalent
`/auth/discord*` shipped in W3 with the same `identify` + `guilds.join`
scopes. The `/join` paths landed with W6 alongside it (same scopes, same
synchronous bot add); both stay until the strangler cutover retires one.

## Discord redirect-URI discipline (W6)

Discord answers `redirect_uri` values that are not registered on the
application with `Unknown redirect_uri` — after the deploy, not before. The
callback URL is `${APP_URL}/join/callback`, so every environment that serves
the join journey needs its own exact URL registered in the Discord developer
portal **before** traffic can reach the new code:

1. **Add** the new redirect URI in the portal (staging first, then prod at cutover).
2. **Deploy** the code that builds it.
3. **Only then** switch traffic / announce. Never remove the old
   `/auth/discord/callback` URI until the cutover retires that path.

Same-app constraint: `DISCORD_BOT_TOKEN` must belong to the same Discord
application as `DISCORD_CLIENT_ID` — Discord only lets an application's own
bot add a member with that application's `guilds.join` token. A token from a
different app fails the synchronous add on every attempt (verified against
the staging Discord app at W6 sign-off, not in CI: CI never holds real
Discord credentials).

## Rules

- Funnel leaves (`/discord`, `/about`, `/faq`, `/rules`) stay DB-free: no
  session, no cookie, no cache, no database read in their path. Zero-query
  tests pin this (ports `DiscordFunnelTest` / `AboutPageTest` /
  `FaqPageTest`).
- One URL, one media type: `/events` (HTML) vs `/events.json`, `/e/{key}`
  (HTML) vs `/events/{key}.ics`. Never content-negotiate.
- `robots.txt` is a route, never a static file in `public/` (TOG-7071).
- Staging advertises its own host in sitemap/robots via `APP_URL`.
