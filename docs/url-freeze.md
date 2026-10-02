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
| `/privacy` | `routes/funnel.php` + `PrivacyController` (versioned policy, zero-query) | ✅ N1: versioned bundle, no session/cookie/cache/DB, in sitemap (monthly, 0.7) |
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
| `/up` | deploy/uptime health (N3); Next-only `/health`, `/healthz`, `/db-ping` removed ([TOG-10852](/TOG/issues/TOG-10852)), ordinary 404 rather than redirect aliases |

Note: legacy `/join*` is the one-click OAuth journey; this repo's equivalent
`/auth/discord*` shipped in W3 with the same `identify` + `guilds.join`
scopes. The `/join` paths landed with W6 alongside it (same scopes, same
synchronous bot add); both stay until the strangler cutover retires one.

## Redirect map

Legacy-only aliases ([TOG-11156](/TOG/issues/TOG-11156)); request proof:
`test/legacy-redirects.test.ts`. GET and automatic HEAD share this behavior.

| Legacy method + Hono pattern | Status | Location | Query policy |
|---|---|---|---|
| `GET /admin/events/create` | 301 | `/admin/events/new` | Drop all |
| `GET /admin/events/:key/edit` | 301 | `/admin/events/:key` | Drop all |
| `GET /admin/featured-contents` | 301 | `/admin/featured` | Drop all |
| `GET /admin/featured-contents/create` | 301 | `/admin/featured/new` | Drop all |
| `GET /admin/featured-contents/:id/edit` | 301 if mapped, 404 if missing/invalid, 503 if DB unavailable | `/admin/featured/{nativeId}` resolved by `featured_contents.legacy_id = :id` | Drop all |
| `GET /auth/discord/redirect` | 302 | `/auth/discord` | Preserve only `next` accepted by `safeNext` (`src/join/service.ts`), URL-encoded; otherwise no query |

Admin aliases run behind the same moderator guard as their targets: guests
302 to `/auth/discord`, signed-in non-moderators receive the same 403. No
resource/database binding is read before that guard. Four aliases need no
resource reads; the featured edit alias looks up only the native ID by the
imported `legacy_id` after authorization. Source IDs stay decimal strings
(including IDs beyond JavaScript's safe integer range); a missing mapping
never falls back to a same-number native row. All return `private, no-store`
after the guard. Dynamic event keys are encoded as one path segment; the
literal create alias is registered before the event-key route.
`/admin/join-attempts/:id` already matches the legacy path and needs no redirect.

Login uses a temporary, `no-store` redirect rather than a permanent OAuth
cache entry. Invalid `next` (including `//evil`), `state`, `code`, and all
other query keys are discarded. This alias does not start OAuth or issue a
cookie; `/auth/discord` remains responsible for fresh state. Forwarding a
safe `next` is not a claim that ordinary login resumes it after the callback:
that existing gap remains recorded in `docs/w15-auth-tests.md`.

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

## Cutover guest-GET probes

[Cutover checker](cutover-check.md) maps every path/pattern in these tables to
an explicit expected response. A new unmapped row fails both the checker and
its local-only selftest. Parameterized routes use a published sitemap event
(or `--event-key`) and an anonymous member probe; wildcards mean representative
paths, not enumeration of an infinite URL space. Feed probes are `/events.ics`,
`/events/{key}.ics` and `/events.rss`.

The OAuth aliases mentioned above remain frozen too:

| Path | Anonymous GET contract |
|---|---|
| `/auth/discord` | 302 to Discord authorize, callback on the target host |
| `/auth/discord/redirect` | 302 to `/auth/discord`, `no-store`, in both cutover phases; no redirect following |
| `/auth/discord/callback` | 302 to `/?n=signin_failed` without code/state |

Retired paths, carried forward from legacy `ci/live-seo-probe.mjs`, plus the
PHP/Livewire-only surfaces: these are **404**, not a soft-404 200 or a redirect
to an error page, on the Next candidate in both phases.

| Path | Anonymous GET contract |
|---|---|
| `/about-us/` | 404 |
| `/news/` | 404 |
| `/members` | 404 (distinct from member-gated `/members/{user}`) |
| `/gamipress/points/` | 404 |
| `/events/month/2024-01/` | 404 |
| `/this-url-never-existed-abc123xyz/` | 404 (never existed) |
| `/wp-json/` | 404 |
| `/wp-login.php` | 404 |
| `/livewire/livewire.js` | 404 |
| `/livewire/update` | 404 (GET only; no mutation) |
| `/health` | 404 (removed Next-only diagnostic; `/up` is the health endpoint) |
| `/healthz` | 404 (removed Next-only diagnostic, not an alias for `/up`) |
| `/db-ping` | 404 (removed Next-only diagnostic, no database probe) |

## Rules

- Funnel leaves (`/discord`, `/about`, `/faq`, `/rules`) stay DB-free: no
  session, no cookie, no cache, no database read in their path. Zero-query
  tests pin this (ports `DiscordFunnelTest` / `AboutPageTest` /
  `FaqPageTest`).
- One URL, one media type: `/events` (HTML) vs `/events.json`, `/e/{key}`
  (HTML) vs `/events/{key}.ics`. Never content-negotiate.
- `robots.txt` is a route, never a static file in `public/` (TOG-7071).
- Staging advertises its own host in sitemap/robots via `APP_URL`.

## Current mounted registration inventory

Guard: `test/route-inventory.test.ts`; snapshot: `test/fixtures/route-inventory.json`.
This table records the current Worker, not an assertion that every legacy parity
feature is finished. It includes `ALL` middleware and the RSVP 405 fallback.
Stacked handlers at the same method/path are one entry; the exposure and throttle
audits separately pin middleware multiplicity. Hono does not register automatic
HEAD handling or static-asset bindings as separate routes here.

Auth classes are **reviewed policy labels** in `test/helpers/route-inventory.ts`,
not proof inferred from handler bodies. Removing every `ALL` registration at a
scoped member/admin gate changes the mounted classification. Removing just one
stacked handler (for example, the member gate but not the access logger) is not
detected here; the exposure inventory pins multiplicity, and the existing
role/owner/bearer/QA behavioral tests prove authorization. `public-draft-moderator` means
public records are public, drafts require a moderator; `member-decoy` means genuine
RSVP writes require membership but honeypot decoys intentionally bypass auth.
`oauth-state` is an OAuth callback's signed state, not an existing login session.
Public routes may read optional sessions; this does not promise zero DB queries.

| Registered method + Hono pattern | Auth class | Test reference / mapping |
|---|---|---|
| `ALL /*` | middleware | member-exposure: global security headers |
| `ALL /admin/*` | moderator | member-exposure: mounted admin gate |
| `ALL /events/:key/rsvp` | public | rsvp: 405 fallback, not a public read |
| `ALL /members/*` | member | member-exposure: gate + access log |
| `ALL /profile` | member | member-exposure: gate + access log |
| `DELETE /events/:key/rsvp` | member-decoy | rsvp: owner withdrawal + decoy |
| `GET /` | public | app: home / optional session |
| `GET /about` | public | seo: frozen funnel leaf |
| `GET /admin` | moderator | admin: dashboard |
| `GET /admin/events` | moderator | admin: event table |
| `GET /admin/events/:key` | moderator | admin: edit form |
| `GET /admin/events/new` | moderator | admin: create form |
| `GET /admin/featured` | moderator | admin: featured table |
| `GET /admin/featured/:id` | moderator | admin: edit form |
| `GET /admin/featured/new` | moderator | admin: create form |
| `GET /admin/join-attempts` | moderator | admin-reads: join audit viewer |
| `GET /admin/join-attempts/:id` | moderator | admin-join-attempt: read-only join audit detail |
| `GET /auth/discord` | public | app: OAuth start; legacy `/auth/discord/redirect` now temporarily redirects here |
| `GET /auth/discord/callback` | oauth-state | app: sign-in callback |
| `GET /discord` | public | seo: invite redirect |
| `GET /e/:key` | public-draft-moderator | events: legacy `/e/{event}` |
| `GET /events` | public | events: calendar |
| `GET /events.ics` | public | event-feeds: subscription |
| `GET /events.json` | session | events: authenticated JSON |
| `GET /events.rss` | public | event-feeds: RSS |
| `GET /events/:file{.+\.ics}` | public-draft-moderator | event-feeds: legacy `/events/{event}.ics` |
| `GET /events/past` | public | events: archive |
| `GET /faq` | public | seo: frozen funnel leaf |
| `GET /join` | public | join: landing page |
| `GET /join/callback` | oauth-state | join: one-click callback |
| `GET /join/discord` | public | join: OAuth start |
| `GET /members/:user` | member | profiles: legacy `/members/{user}` |
| `GET /privacy` | public | privacy: versioned policy |
| `GET /profile` | member | profiles: current member |
| `GET /robots.txt` | public | seo: frozen robots |
| `GET /rules` | public | seo: frozen funnel leaf |
| `GET /sitemap_index.xml` | public | seo: frozen sitemap |
| `GET /up` | public | up: always-200 queue health |
| `PATCH /events/:key` | moderator | events: JSON update |
| `PATCH /members/:user` | member-owner | profiles: self-only edit |
| `POST /__probe/alert` | staging-token | alerts: QA-only request + poison-job drill; expected 500, no production seam |
| `POST /admin/events` | moderator | admin: draft create |
| `POST /admin/events/:key` | moderator | admin: update |
| `POST /admin/events/:key/cancel` | moderator | admin: cancel |
| `POST /admin/events/:key/publish` | moderator | admin: publish |
| `POST /admin/featured` | moderator | admin: featured create |
| `POST /admin/featured/:id` | moderator | admin: featured update |
| `POST /admin/featured/:id/delete` | moderator | admin: featured delete |
| `POST /api/agent-events` | machine-bearer | agent-events: W14 machine ingress |
| `POST /auth/qa/:identity` | staging-token | app: deliberate POST divergence from legacy GET |
| `POST /csp-reports` | public | csp-reports: no-store violation sink |
| `POST /events` | moderator | events: draft create |
| `POST /events/:key/cancel` | moderator | events: cancel |
| `POST /events/:key/publish` | moderator | events: publish |
| `POST /logout` | public | app: optional session revoke + origin check |
| `POST /members/:user` | member-owner | profiles: `_method=PATCH` form adapter |
| `PUT /events/:key/rsvp` | member-decoy | rsvp: owner answer + decoy |

The diagnostic aliases were removed by [TOG-10852](/TOG/issues/TOG-10852).
`test/db-ping.test.ts` proves they match unknown paths: ordinary 404s, or the
global same-origin 403 for untrusted unsafe requests. These are in-process
production/staging-host configurations; no live database or network is used.

### Updating the inventory

1. Review the added/removed method, exact Hono pattern and auth policy. Keep
   scoped `ALL` registrations and the RSVP fallback; do not hide them by filtering.
2. Update the snapshot and the auth classifier if the reviewed policy changes.
3. Add `// route-inventory: METHOD /pattern` to the existing owning `.test.ts`
   file. Use the canonical mounted path even when a test requests a concrete key
   or a child router. The guard excludes its own test files and JSON fixtures;
   arbitrary URL substrings, method mismatches and prose are not references.
4. Add an exact backticked method/pattern row here or in `docs/parity.md` with
   its mapping or intentional divergence. Remove obsolete test-reference comments
   on route deletion. If no behavioral test exists, file the gap separately;
   a reference is not an assertion of executed behavioral coverage.
5. Run `env -u DATABASE_URL npm run check` for fixtures only, or set
   `DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next` for the
   authorized disposable test DB. Never run tests against staging or production.
