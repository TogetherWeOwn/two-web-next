# Parity matrix: legacy `two-web` → `two-web-next`

Source: legacy [two-web](https://github.com/TogetherWeOwn/two-web) @ `e1e939a`
(read 2026-09-29: `routes/web.php`, `routes/api.php`, `routes/funnel.php`,
`routes/console.php`, controllers, Livewire, Filament, jobs, commands,
policies, middleware, services, config, views, content, public).
Next side: this repo @ `f100e0a` + live card statuses of the same date.

Flip gate (owner): re-run before W16; the DNS flip needs **0 unmapped rows**.
A row is mapped when it names a card or is **dropped, with a reason**.
`✅ done` = merged to `main`. Everything else names the owning card.

W-card statuses at write time:
W2 ✅, W3 ✅, W4 ✅, W5 ✅, W14 ✅ · W6 🔶, W11 🔶 · W1 ⛔, W10 ⛔ (slice 1
shipped), W13 ⛔ (PR #7 in review), W15 ⛔, S1 ⛔ · W7/W8/W9/W12/W16 📋 todo.

## 1. Web routes (`routes/web.php` → Hono)

| Legacy route | Next status | Card |
|---|---|---|
| `GET /` (HomeController: counts + ranks + featured + 3 upcoming) | ✅ degraded shell; live counts + featured + upcoming land with data slices | W4 ✅ + W8 📋 (verify: featured rows, upcoming) |
| `GET /sitemap_index.xml` (home 1.0, join 0.9, events.index 0.8, about/faq/rules/privacy 0.7, published `/e/{key}` 0.6) | ✅ static entries; join + `/e/{key}` rows pending | W4 ✅ + W8 📋 |
| `GET /robots.txt` (dynamic, per-env host) | ✅ | W4 ✅ |
| `Route::view /rules` (DB-free leaf + last-updated stamp) | ✅ | W4 ✅ |
| `GET /join`, `GET /join/discord`, `GET /join/callback` (one-click OAuth, `identify`+`guilds.join`, throttle 10,1, JoinAttempt write, guarded `next`) | `/auth/discord*` live; `/join` path alias pending | W6 🔶 |
| `GET /events` (EventsCalendar full-page) | ✅ SSR list (island enhancement pending) | W8 ✅ + W10 slice 3 ⛔ |
| `GET /events/past` (archive, 20/page) | ✅ SSR archive 20/page | W8 ✅ + W10 slice 4 ⛔ |
| `GET /e/{event}` (public page; drafts 403 non-mod, cancelled 410+noindex, JSON-LD, GoingCount, RsvpButton, prev/next, related) | ✅ page, 403/410, JSON-LD, going count; RsvpButton/prev-next/related pending | W8 ✅ (partial) |
| `GET /events/{event}.ics` (per-event download, ETag/304, sessionless, view-policy identical) | ✅ | W9 ✅ |
| `GET /events.rss` (published upcoming, ETag/304, atom self-link) | ✅ | W9 ✅ |
| `GET /events.ics` (subscribable incl. CANCELLED, `webcal://`) | ✅ | W9 ✅ |
| `GET /auth/discord/redirect`, `GET /auth/discord/callback` (login, `identify`+`guilds.members.read`, 404-not-member, guarded `next`) | ✅ same-app flow (`identify`+`guilds.join`, auto-join, role recompute) | W5 ✅ |
| `GET /auth/qa/{identity}` (staging-only, header token) | ✅ as `POST /auth/qa/:identity` — **deliberate divergence**: GET login is CSRF-able; POST + byte-identical 404s | W5 ✅ |
| `POST /logout` (throttle 30,1, session invalidate) | ✅ + origin check; throttle pending | W5 ✅ + N5 (new card, throttle) |
| `GET /profile`, `GET /members/{user}` (+ `member-access-log`, canonical to `profiles.show`) | ✅ member-gated (guest 302 → OAuth, non-member 403), one access-log row per read of another member, fail-closed 503; MemberStats block (bot DB) pending | W7 ✅ |
| `PATCH /members/{user}` (owner-only, throttle 30,1, bio/games/timezone validation) | ✅ + `POST _method=PATCH` for the plain form | W7 ✅ |
| `GET /events.json` (auth, 20/def-100/max paging, ETag, `going_count` per row) | ✅ session-gated, paged, ETag/304, `going_count` | W8 ✅ |
| `POST /events`, `PATCH /events/{event}` (throttle 30,1, draft-only create) | ✅ JSON moderator routes (throttle = N5) | W8 ✅ + W11 🔶 |
| `POST /events/{event}/publish|cancel` (throttle 30,1, announce semantics) | ✅ (write-back enqueued via `EVENT_SYNC_QUEUE`; binding pending queue creation) | W8 ✅ + W11 🔶 |
| `POST /events/{event}/rsvp-pause|rsvp-reopen` (throttle 30,1) | pending | W8 📋 + W11 🔶 |
| `PUT|DELETE /events/{event}/rsvp` (named `rsvp-writes` 12/min shared bucket + in-controller limiter, honeypot decoy) | ✅ PUT 201/200, DELETE 204, 405 other verbs, one shared 12/min per-member budget (advisory-locked, atomic), honeypot decoy, FOR UPDATE capacity races (test/rsvp.test.ts) | W9 ✅ + W10 slice 2 ⛔ (unblocked) |

## 2. Funnel routes (`routes/funnel.php`, empty stack, DB-free)

| Legacy route | Next status | Card |
|---|---|---|
| `GET /discord` (302 `no-store`, configured-or-fallback invite) | ✅ incl. hardcoded fallback | W4 ✅ |
| `GET /about`, `GET /faq` (static, zero-query) | ✅ | W4 ✅ |
| `GET /privacy` (versioned `content/privacy-policy-v1.md` from disk, no session/cache/DB) | ❌ missing — no card covered it | **N1** (new: `/privacy` versioned page) |
| `GET /up` (always-200 `{status, queue{pending,…,warn:20,critical:100}}`, unknown-not-500) | ❌ (`/health`, `/healthz` exist, no queue payload) | **N3** (new: `/up` health check) |
| `POST /csp-reports` (always-204, 8 KB cap, sampled fixed-key log, never stored) | ✅ `src/csp-reports.ts` (funnel posture: no session/cookie/cache/DB, `no-store`); CSP `report-uri` + Reporting API `Reporting-Endpoints`/`Report-To` point at it | W16 📋 (TOG-10107) |

## 3. Machine ingress (`routes/api.php`)

| Legacy | Next status | Card |
|---|---|---|
| `POST /api/agent-events` (bearer, 5 ops, per-grant budgets, idempotency replay, audit-everything, outer 60/min shield, HMAC bot signer byte-parity) | ✅ (`/api/agent-events` + signer + replay + budgets) | W14 ✅ |
| Grants admitted out-of-band, no Filament resource (AgentEventGrantPolicy view-only) | ✅ nothing to build — no UI in legacy either | W14 ✅ |

## 4. Livewire → islands (no Livewire protocol on Workers; SSR + binders)

| Legacy component | Next status | Card |
|---|---|---|
| GoingCount (badge, `going-count-updated` broadcast, one count query) | ✅ contract + binder + 18 drift tests | W10 slice 1 ✅ |
| RsvpButton (all states, honeypot swallow, throttle copy, focus) | re-spec ✅, needs W9 routes | W10 slice 2 ⛔, blocked by W9 |
| EventsCalendar (list+grid one pass, `?q=` search + logging, month math, Discord transients) | re-spec ✅, needs W8 | server side (search + logging) ✅ TOG-10105; island UI W10 slice 3 |
| PastEvents (20/page, canonicals, no RSVP controls) | re-spec ✅, needs W8 | W10 slice 4 ⛔, blocked by W8 |
| MemberProfile (view/edit, PATCH validation, spam trap, focus) | re-spec ✅, needs W7 | W10 slice 5 ⛔, blocked by W7 |

## 5. Filament admin (`/admin`, panel `admin`, TWO Moderation brand)

| Legacy surface | Next status | Card |
|---|---|---|
| Panel gate: Discord-role → 403 (no login form), dark brand, CSP stack, `RecordMemberDataAccess` on panel | pending (custom React rebuild, no Filament off PHP) | W11 🔶 (M1) |
| Events resource: table (search/sort/status/series/fill filters, publish/cancel/pause/reopen actions, no delete/bulk) + create-as-draft + edit (UTC↔wall DST carriers) + recurrence fields | pending | W11 🔶 (M2/M3) |
| RsvpsRelationManager (read-only roster, `canViewForRecord` 403) | pending | W12 📋 (M6) |
| FeaturedContent resource (CRUD + publish window + live preview + safe delete) | pending | W11 🔶 (M4; verify: homepage render path) |
| JoinAttempt resource (read-only viewer: outcome/source/request/discord-id) | pending | W12 📋 (M8) |
| JoinFunnelStats widget (per-outcome counts, 60 s cache, no member data) | pending | W12 📋 (M8 funnel-stats) |
| TopZeroResultSearches widget (normalized queries only) | ✅ TOG-10105 (dashboard section, moderator gate) | W12 📋 (verify scope at build) |
| Moderator admin guide + member-data docs | ops docs follow the rebuild | W11 🔶 / W12 📋 |

## 6. Jobs, queues, scheduler

| Legacy | Next status | Card |
|---|---|---|
| SyncEventToDiscord (unique per eventKey, tries 6, backoff 10/60/300/900/3600, debounce 10 s, grant recheck, terminal stamp) | pending (PR #7 in review) | W13 ⛔ |
| CallInternalAction (`role.assign`/`announcement.post` only; production web never dispatches it — drill-only) | pending, port shape | W13 ⛔ |
| `events:reconcile` every 10 min (close past, materialize series, re-dispatch stale; single-flight) | pending | W13 ⛔ |
| `model:prune` daily ×3 (MemberDataAccessLog, JoinAttempt + AgentEventIdempotencyKey, EventSearchLog; 90 d windows) | pending | W13 ⛔ |
| `web_sessions` expiry cleanup (no legacy equivalent — Laravel GC; rows accumulate without one) | ❌ missing | W13 ⛔ (verify scope at build) |
| Bot write-back after every event mutation (`syncAfterCommit`, drafts/past/unmirrored skip) | pending | W8 📋 + W13 ⛔ |

## 7. Console commands

| Legacy | Next status | Card |
|---|---|---|
| `discord:check-moderators` (deploy-time role-config probe) | no equivalent | W16 📋 (pre-flip checks) |
| `bot:internal-action-smoke` (live-against-staging QA) | no equivalent | W16 📋 (cutover rehearsal) |
| `queue:check-depth` (box probe) | dropped as a command (no box on Workers) — replaced by `GET /up` | **N3** |
| `error-alert:probe`, `queue:poison-probe` (drills) | dropped as commands — re-express as Vitest tests | W13 ⛔ / W15 ⛔ (verify scope) |
| `ci:session-cookie` (perf-budget session minter) | no equivalent | W15 ⛔ (verify scope; drop if no budget job) |
| `inspire` | stock scaffold | dropped (no-op) |

## 8. Mail, notifications, webhooks

Legacy web sends **no mail, no notifications, no webhooks**: no `app/Mail`,
no `app/Notifications`, `config/mail.php` stock-unused, Slack channel
configured-never-fired, no Discord webhook posts. Outbound is `Http::` only:
member-token role read at login; signed bot `POST /internal/actions`;
Paperclip control-plane card writer (dead in web — binding only, zero
callers). There is nothing to port; the negatives are pinned so W16 does not
go hunting for them.

| Legacy | Next status | Card |
|---|---|---|
| No mailables / notifications (confirmed absent) | ✅ nothing to build | — (pinned here) |
| No Slack/Discord webhook posts (confirmed absent) | ✅ nothing to build | — (pinned here) |
| RestartCardClient/Paperclip value objects (dead code, no callers) | ✅ do not port | dropped (dead) |
| Log-line alerting instead (error alert 1/5 min, Queue::failing critical) | ✅ `src/alerts.ts` (`error.alert`, 1 per `class@route` / 5 min per isolate; `queue.failing` from `src/jobs/consumer.ts`), runbook `docs/runbook-alerts.md` | **N4** ✅ |

## 9. Policies and gates

| Legacy | Next status | Card |
|---|---|---|
| EventPolicy (view/drafts/publish/cancel/toggleRsvp/Delete moderator-only) | pending | W8 📋 |
| RsvpPolicy (owner-only write; Published + !ended + rsvpOpen create) | ✅ owner-only, Published + !ended + rsvpOpen | W9 ✅ |
| FeaturedContentPolicy (all moderator; public via `currentlyVisible`) | pending | W11 🔶 |
| JoinAttemptPolicy (read moderator; writes denied — controller writes direct) | pending | W6 🔶 (write) + W12 📋 (read) |
| UserPolicy (`updateProfile` self-only) | pending | W7 📋 |
| `access-admin` gate (`is_moderator`, recomputed from Discord role IDs each login) | ✅ recompute live; gate pending | W5 ✅ + W11 🔶 |

## 10. Middleware and edge behavior

| Legacy | Next status | Card |
|---|---|---|
| `secureHeaders`-equivalent (CSP on web+admin+leaves, static anti-framing/sniffing globally) | ✅ global secureHeaders (stricter: no inline/eval — no Livewire to need it) | W3 ✅/W4 ✅ |
| One-429-shape (ThrottleEnvelope, all throttles) | ✅ agent ingress; RSVP writes ✅ (rateLimitExceeded); other human routes as they land | W14 ✅ + W9 ✅ |
| Route throttles 10,1 (join/login/QA) and 30,1 (logout/event writes) | ✅ `src/throttle.ts` + every-POST-throttled audit (`test/throttle.test.ts`) | **N5** ✅ |
| `member-access-log` (arm/flush, fail-closed 503 when enforced) | ✅ `src/access-log.ts` middleware on member routes; admin guard carries the same contract | W7 ✅ + W12 📋 (retention) |
| TrustHosts (APP_URL host only) / trustProxies (nginx socket) | Workers: platform TLS; host check pending | W16 📋 |
| Maintenance mode except `/discord` | dropped — Workers deploys are atomic, no maintenance mode; DB-free `/discord` floor preserved | dropped (platform) |
| CompressStaticAssets (gzips Livewire runtime) | dropped — no Livewire runtime; edge compresses static assets | dropped (platform) |

## 11. Services, support, validation

| Legacy | Next status | Card |
|---|---|---|
| EventService (capacity/waitlist under lock, series create/materialize, sync-after-commit) | pending | W8 📋 + W11 🔶 + W13 ⛔ |
| InternalActionClient + signer (sole bot speaker; `addMember` sync-only, never queued) | ✅ signer byte-parity; client pending | W14 ✅ + W13 ⛔ |
| EventIcs/EventRss/EventFeed/EventSubscribe/EventGoogleCalendar/EventJsonLd | ✅ | W8 ✅ (JSON-LD) + W9 ✅ (feeds) |
| RsvpRateLimit / AgentEventRateLimit | ✅ / ✅ | W9 ✅ / W14 ✅ |
| SafeRedirect (guarded `next`), SpamTrap (honeypot + 1000 ms floor) | pending | W6 🔶 / W7 📋 + W9 📋 |
| RecurrenceSchedule/RecurrenceInput, EventInput, Rules (IANA tz, wall-time, control chars) | pending | W11 🔶 (form) + W13 ⛔ (materialize) |
| MemberStatsSource / Profiles support (rank, stats, milestones) | pending | W7 📋 |
| Home support (Lobby Ledger, ranks, Discord widget iframe) | ✅ shell; live data pending | W4 ✅ + W6 🔶 (widget) + W8 📋 (upcoming) |
| Counts (never-throw degraded empty state) | ✅ seam (`readCounts` → UNAVAILABLE) | W4 ✅ + W8 📋 (wire bot views) |

## 12. SEO, shell, content, sessions

| Legacy | Next status | Card |
|---|---|---|
| Share meta (canonical + OG/Twitter, no og:image) + RSS autodiscovery | ✅ layout-level; per-event tags pending | W4 ✅ + W8 📋 |
| `site.webmanifest` + icons (192/512/maskable/apple) + theme-color `#0b0714` | ❌ missing (`public/` has styles + islands only) | **N2** (new: manifest/icons) |
| Branded 404/429/500/503 pages | ❌ Hono defaults | **N2** (new: error pages) |
| Draft/noindex + gone-410 + past-never-indexed rules | sitemap side ✅; route side pending | W8 📋 |
| `content/privacy-policy-v1.md` (live source) | ❌ see N1 | **N1** |
| `content/faq-preview*.md` (docs-only), `content/welcome/*` (unwired drafts) | copy inlined / never wired | dropped (docs-only / dead) |
| Design-lab routes (non-prod visual experiments) | ✅ correctly absent | dropped (never production) |
| DB sessions, 120-min sliding lifetime | ✅ DB-backed + rotation; **divergence**: 30 d rotating TTL (Worker-compatible; no sliding lottery) — CPO decision, verify at W16 | W5 ✅ |
| Session cookie `__Host-`, HttpOnly, Lax; OAuth state bound to signed cookie | ✅ | W5 ✅ |

## 13. New cards created by this matrix (all in TWO Web Next, one PR each)

- **N1** ([TOG-9893](/TOG/issues/TOG-9893)) — `/privacy` versioned policy page: render `privacy-policy-v1.md` from disk via `Str::markdown`-equivalent, funnel-style (no session/cache/DB), CSP header. Acceptance: 200 with DB down; version bump = new file + const.
- **N2** ([TOG-9894](/TOG/issues/TOG-9894)) — webmanifest + install icons + theme-color + branded 404/429/500/503. Acceptance: manifest serves, icons resolve, each error code renders brand (no stack traces; 429 shape per W9).
- **N3** ([TOG-9895](/TOG/issues/TOG-9895)) — `GET /up` always-200 `{status, queue{…}}` with warn 20 / critical 100, unknown-not-500. Blocked by W13 (queue visibility). Replaces `queue:check-depth`.
- **N4** ([TOG-9896](/TOG/issues/TOG-9896)) — log-based error alert (1 per fingerprint / 5 min, dont-report list respected) + queue-failing critical line; runbook for tailing. Blocked by W13.
- **N5** ([TOG-9897](/TOG/issues/TOG-9897)) — human-route throttles: 10,1 join/login/QA + 30,1 logout/event writes, one 429 shape, `every-POST-throttled` audit. Rides the W9 throttle mechanism; blocked by W9.
- **N6** ([TOG-9898](/TOG/issues/TOG-9898)) — user-roster write on sign-in/join (`updateOrCreate` Discord id/username/avatar/member flag; never the moderator flag — recompute owns that). The `users` table exists from W3 but nothing writes it; W7/W11 reads need it. Acceptance: repeat login updates the row, no duplicates, moderator flag untouched by the write path.

Unmapped rows remaining: **0**. Dropped rows carry reasons above; every other
row names its card. Re-run this matrix before W16 (DNS flip).
