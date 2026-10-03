# Parity matrix: legacy `two-web` → `two-web-next`

Source: legacy [two-web](https://github.com/TogetherWeOwn/two-web) @ `e1e939a`
(read 2026-09-29: `routes/web.php`, `routes/api.php`, `routes/funnel.php`,
`routes/console.php`, controllers, Livewire, Filament, jobs, commands,
policies, middleware, services, config, views, content, public).
Next side: this repo @ `b46a479a` (2026-10-03) + live card statuses of the same date.

Flip gate (owner): re-run before W16; the DNS flip needs **0 unmapped rows**.
A row is mapped when it names a card or is **dropped, with a reason**.
`✅ done` = merged to `main`. Everything else names the owning card.

W-card statuses at refresh time (2026-10-01; W10/W15 updated 2026-10-02; re-verified 2026-10-03, unchanged):
W1 ✅, W2 ✅, W3 ✅, W4 ✅, W5 ✅, W6 ✅, W7 ✅, W8 ✅, W9 ✅, W10 ✅
(slices 1–5, incl. slice 2 RsvpButton island PR #98;
[TOG-9839](/TOG/issues/TOG-9839) done), W11 ✅, W12 ✅,
W13 ✅, W14 ✅, S1 ✅ · W15 ✅ ([TOG-9697](/TOG/issues/TOG-9697) done,
QA PASS on main `ea51a83e`) ·
W16 ⛔ ([TOG-10112](/TOG/issues/TOG-10112), parent [TOG-9698](/TOG/issues/TOG-9698)).

Database-outage acceptance is maintained separately in
[`db-outage-matrix.md`](db-outage-matrix.md) and
`test/db-outage-matrix.test.ts`. It distinguishes the legacy bot-only outage
from app-DB loss and lists the stronger Next targets; this historical snapshot
is not evidence that a configured-but-unreachable DB already meets them.

## 1. Web routes (`routes/web.php` → Hono)

| Legacy route | Next status | Card |
|---|---|---|
| `GET /` (HomeController: counts + ranks + featured + 3 upcoming) | ✅ merged: live counts + rank reads (`test/home-counts.test.ts`, `test/counts.test.ts`); featured rows use legacy `[start, end)` windows, position/id order and no cap (`test/featured.test.ts`); next 3 published, not-ended events with going counts, anonymous cards and guest join CTA (`test/home-events.test.ts`); missing/down DB keeps 200 with unavailable empty state | W4 ✅ + [TOG-10818](/TOG/issues/TOG-10818) ✅ + [TOG-10819](/TOG/issues/TOG-10819) ✅ + [TOG-10820](/TOG/issues/TOG-10820) ✅ |
| `GET /sitemap_index.xml` (home 1.0, join 0.9, events.index 0.8, about/faq/rules/privacy 0.7, published `/e/{key}` 0.6) | ✅ static entries + join + published `/e/{key}` rows (`src/seo.ts` `buildSitemapUrls`/`crawlableEvents`; `test/seo.test.ts`) | W4 ✅ + W8 ✅ |
| `GET /robots.txt` (dynamic, per-env host) | ✅ | W4 ✅ |
| `Route::view /rules` (DB-free leaf + last-updated stamp) | ✅ | W4 ✅ |
| `GET /join`, `GET /join/discord`, `GET /join/callback` (one-click OAuth, `identify`+`guilds.join`, throttle 10,1, JoinAttempt write, guarded `next`, join-result confirmation + member reinvite) | ✅ one-shot `join_result` banner on `/`, `/join`, `/profile`, `/events`, `/e/{key}` with `data-testid="reinvite-link"` → `/discord` (merged PR #46); expired-grant vs outage classification (200 "Join approval expired" vs 503 "Discord is unreachable"; status governs, untrusted bodies never parsed) + bounded OAuth log redaction | W6 ✅ + [TOG-10356](/TOG/issues/TOG-10356) ✅ + [TOG-10355](/TOG/issues/TOG-10355) ✅ |
| `GET /events` (EventsCalendar full-page) | ✅ SSR list + island UI (`test/islands-events-calendar.test.ts`) | W8 ✅ + W10 slice 3 ✅ |
| `GET /events/past` (archive, 20/page) | ✅ SSR archive 20/page + island UI (`test/islands-past-events.test.ts`) | W8 ✅ + W10 slice 4 ✅ |
| `GET /e/{event}` (public page; drafts 403 non-mod, cancelled 410+noindex, JSON-LD, GoingCount, attendee list, RsvpButton, prev/next, related) | ✅ page, 403/410, JSON-LD, going count, state banners, venue, guest join pitch, per-event share tags, past noindex and canonical copy-link island; member-only logged attendee names/profile links; prev/next + related merged (PR #58; `test/event-navigation.test.ts`); RsvpButton island shipped (PR #98; `test/islands-rsvp-binder.test.ts`); non-canonical letter-case keys 301 to the canonical form before lookup (`test/events-key-canonical.test.ts`) | W8 ✅ (partial) + [TOG-10822](/TOG/issues/TOG-10822) ✅ + [TOG-10823](/TOG/issues/TOG-10823) ✅ + [TOG-10821](/TOG/issues/TOG-10821) ✅ |
| `GET /events/{event}.ics` (per-event download, ETag/304, sessionless, view-policy identical) | ✅ non-canonical letter-case keys 301 to the canonical form (`test/events-key-canonical-siblings.test.ts`); unknown-key 404s render the branded 404 with suggestions and noindex | W9 ✅ |
| `GET /events.rss` (published upcoming, ETag/304, atom self-link) | ✅ equal-start rows ordered by id (`test/feed-equal-start-order.test.ts`) | W9 ✅ |
| `GET /events.ics` (subscribable incl. CANCELLED, `webcal://`) | ✅ equal-start rows ordered by id (`test/feed-equal-start-order.test.ts`) | W9 ✅ |
| `GET /auth/discord/redirect`, `GET /auth/discord/callback` (login, `identify`+`guilds.members.read`, 404-not-member, guarded `next`, `login_next`/`url.intended` precedence) | ✅ same-app flow (`identify`+`guilds.join`, auto-join, role recompute); legacy start alias merged (PR #105): 302 to `/auth/discord`, only validated `next` forwarded, other queries dropped (`test/legacy-redirects.test.ts`); return journey on signed `__Host-two_login_*` cookies, cleared on every terminal path (merged PR #46); classified failure banners (denied `signin_denied` / outage `signin_unavailable` / generic `signin_failed`) with bounded logs | W5 ✅ + [TOG-11156](/TOG/issues/TOG-11156) ✅ + [TOG-10356](/TOG/issues/TOG-10356) ✅ + [TOG-10355](/TOG/issues/TOG-10355) ✅ |
| `GET /auth/qa/{identity}` (staging-only, header token) | ✅ as `POST /auth/qa/:identity` — **deliberate divergence**: GET login is CSRF-able; POST + byte-identical 404s | W5 ✅ |
| `GET /auth/status` (bool-only liveness, stale tabs) | ✅ merged (PR #239): exact bool-only JSON, no-store/private, no identity or rotating cookies; stable non-authenticating probe survives rotation (`test/session-recovery.test.ts` + two-tab browser fixture); shared hook only, remaining surface integration is not waived | [TOG-10357](/TOG/issues/TOG-10357) ✅ |
| `GET /auth/recover` (expired member writes) | ✅ merged (PR #239): durable explicit recovery, safe GET return, signed ten-minute pending/restored notice, one-shot post-login banner, no retained body or automatic retry. MemberProfile drafts preserved until reset; admin event-editor expired-save recovery merged (`test/admin-session-recovery.test.ts`); other write owners integrate under existing cards | [TOG-10357](/TOG/issues/TOG-10357) ✅ |
| `POST /logout` (throttle 30,1, session invalidate) | ✅ + origin check; bounded cross-tab server recheck and fail-closed revocation response merged (PR #239); throttle ✅ (`test/throttle.test.ts`) | W5 ✅ + [TOG-10357](/TOG/issues/TOG-10357) ✅ + **N5** ✅ ([TOG-9897](/TOG/issues/TOG-9897)) |
| `GET /profile`, `GET /members/{user}` (+ `member-access-log`, canonical to `profiles.show`) | ✅ member-gated (guest 302 → OAuth recording `url.intended`, non-member 403), one access-log row per read of another member, fail-closed 503; MemberStats block reads bot-owned `web_v1` views, hides on no row/missing views/DB failure, covered by the same profile access-log subject | W7 ✅ |
| `PATCH /members/{user}` (owner-only, throttle 30,1, bio/games/timezone validation) | ✅ + `POST _method=PATCH` for the plain form | W7 ✅ |
| `GET /events.json` (auth, 20/def-100/max paging, ETag, `going_count` per row) | `per_page` takes precedence over retained `limit` alias; default 20, complete signed integer sizes clamped 1–100, malformed/decimal/exponent sizes default 20; stable `starts_at ASC, id ASC`; existing `data/page/limit` plus `meta.current_page/per_page/total/last_page` (viewer-visible total, at least one last page); pages past the end clamp to the last page before any OFFSET is issued, so the response carries last-page rows with consistent `page`/`current_page`; retained exact `event_key` filter applies before paging to both rows and totals (malformed key 422, hidden/missing key empty); JSON/default/mixed-JSON guest 401, explicit `text/html` with valid positive quality redirects 302 with guarded `next` (no HTML substring or q=0 redirect); private ETag/304; collection emits the 15 legacy-ordered keys with wall-time readings and Discord derivation (`test/event-json-access-matrix.test.ts`) | W8 ✅ + [TOG-11155](/TOG/issues/TOG-11155) |
| `GET /events/:key` (legacy `/events/{event}` JSON show) | Session gate as collection; existing `eventJson()` fields and viewer waitlist position, no identities; draft member 403, moderator 200 + noindex; cancelled 410 with legacy reason/message/event_key/status; private ETag/304; non-canonical letter-case keys 301 to the canonical form (`test/events-key-canonical-siblings.test.ts`); registered after archive and per-event ICS | [TOG-11155](/TOG/issues/TOG-11155) |
| `POST /events`, `PATCH /events/{event}` (throttle 30,1, draft-only create) | ✅ JSON moderator routes + `event-write` throttle (`test/throttle.test.ts`) | W8 ✅ + W11 ✅ |
| `POST /events/{event}/publish|cancel` (throttle 30,1, announce semantics) | ✅ routes + status machine (`test/admin-reads.test.ts` publish/cancel parity); tracked write-back via W13 `SYNC_EVENT_QUEUE` (PR #68); cancel rows send `event.cancel`, never upsert, and legacy in-flight `event.cancel` carriers map to the same tracked job with the producer key unchanged (`test/sync-cancel-carrier.test.ts`) | W8 ✅ + W11 ✅ + [TOG-10815](/TOG/issues/TOG-10815) |
| `POST /events/{event}/rsvp-pause|rsvp-reopen` (throttle 30,1) | ✅ `POST /events/:key/rsvp-pause`, `POST /events/:key/rsvp-reopen`, `POST /admin/events/:key/rsvp-pause`, `POST /admin/events/:key/rsvp-reopen`: moderator-only, published/non-ended, row-locked idempotent toggles; each flip uses the Discord sync queue (`test/rsvp-toggle.test.ts`) | [TOG-10817](/TOG/issues/TOG-10817) ✅ |
| `PUT|DELETE /events/{event}/rsvp` (named `rsvp-writes` 12/min shared bucket + in-controller limiter, honeypot decoy) | ✅ PUT 201/200, DELETE 204, 405 other verbs, one shared 12/min per-member budget (advisory-locked, atomic), honeypot decoy, full-event waitlisting + FIFO promotion under FOR UPDATE (`test/rsvp.test.ts`, `test/rsvp-waitlist.test.ts`); outage saves seat pending then recovers synced (`test/rsvp-writeback-outage.test.ts`, PR #247) | W9 ✅ + W10 slice 2 ✅ ([TOG-9839](/TOG/issues/TOG-9839) done, PR #98) |

Event-page navigation uses `starts_at, id` order, omitting absent neighbors.
Related links prefer the same non-null game, then fill to three by `starts_at, id`,
including ongoing events (`ends_at >= now`) and excluding the current event.
Links are **published-only for every viewer**, per [TOG-10821](/TOG/issues/TOG-10821):
this deliberately narrows legacy's moderator-draft and `past`-status eligibility.
Guests get `/join?next=/e/{key}`; all event-page variants retain the existing
private/no-store policy with `Vary: Cookie`. Three bounded link queries, no
per-event RSVP reads.

### Auth admission follow-up (merged PR #141 + PR #118; review acceptance pending)

[TOG-10354](/TOG/issues/TOG-10354) adds shared Postgres single-use admission for
ordinary auth and one-click join, plus atomic invalidation of the supplied active
pre-login/pre-join token on fresh authentication. Request tests hold the first
exchange in flight and replay ORIGINAL signed cookies; only one exchange, join,
session and terminal attempt is admitted. Separate clients prove durable
coordination, expiry and replacement rollback on the isolated test container.
Journey expiry/consumption eligibility depends on the locked CTE output, not a
base-relation qualifier that can run before locking. Auth/join natural-expiry
regressions observe an actual wait on an unchanged tuple with collected table
statistics; these failed on the pre-correction SQL in PostgreSQL 17.11. The
holder-updated expiry case remains separate. This database-level proof does not
establish attacker-reachable HTTP exploitation or lift independent review gates.
Blank-bot join follows main's TOG-12680 contract: the OAuth exchange and user
lookup run, zero bot-credentialed calls are emitted, and the callback renders
recovery with no member session (also when the bot is disabled mid-journey). Store acquisition/consumption failure has separate
request proofs of no upstream call, terminal attempt or session change; refused
admission issuance cannot hand off to OAuth. Denial/exchange failure preserves prior authority;
failed ordinary auto-join may only issue a non-member/non-moderator session,
while failed one-click join issues none. Ten-minute server expiry and tombstone
cleanup are documented in [W15 coverage](w15-auth-tests.md#admission-state-retention-and-failure-contract).
Local Chromium fixture proof (`ci/auth-browser.mjs`) covers the real sign-in CTA,
auth/join re-entry, supplied prior-cookie rejection, ORIGINAL-cookie replay and
consent-denial recovery without external traffic. Human admission is
serialized per bucket (`test/human-throttle-concurrency.test.ts`) and
signed-in re-entry replacing the prior session exactly once is pinned
(`test/join-idempotence.test.ts`). Exact-head independent
review/security acceptance and green CI remain delivery gates.
This narrows three W15 gaps; it does not claim full parity, cutover readiness,
production testing, or change the recorded rotating TTL/POST-QA divergences.

## 2. Funnel routes (`routes/funnel.php`, empty stack, DB-free)

| Legacy route | Next status | Card |
|---|---|---|
| `GET /discord` (302 `no-store`, configured-or-fallback invite) | ✅ incl. hardcoded fallback | W4 ✅ |
| `GET /about`, `GET /faq` (static, zero-query) | ✅ | W4 ✅ |
| `GET /privacy` (versioned policy from disk, no session/cache/DB; v1 file retained as history, live page serves `content/privacy-policy-v2.md` via `POLICY_FILE`) | ✅ `src/privacy.ts` + `test/privacy.test.ts` | **N1** ✅ ([TOG-9893](/TOG/issues/TOG-9893)) |
| `GET /up` (always-200 `{status, queue{pending,…,warn:20,critical:100}}`, unknown-not-500) | ✅ `src/up.ts` + `test/up.test.ts`; sole deploy/uptime endpoint, payload unchanged; queue read covers the ledger (`queue.status: "unknown"` when unconfigured) | **N3** ✅ ([TOG-9895](/TOG/issues/TOG-9895)) + [TOG-10852](/TOG/issues/TOG-10852) ✅ |
| `POST /csp-reports` (always-204, 8 KB cap, sampled fixed-key log, never stored) | ✅ `src/csp-reports.ts` + `test/csp-reports.test.ts` (funnel posture: no session/cookie/cache/DB, `no-store`); CSP `report-uri` + Reporting API `Reporting-Endpoints`/`Report-To` point at it | [TOG-10107](/TOG/issues/TOG-10107) ✅ |

### Diagnostic surface decision ([TOG-10852](/TOG/issues/TOG-10852))

Delete the Next-only `/db-ping`, `/health` and `/healthz` routes in every
configuration. Legacy exposes only `/up`; retaining a token/flag-protected
ping would add a credential and an unnecessary public connection/fingerprinting
surface. Removed paths use the ordinary branded 404 (same body and headers as
unknown paths), with no diagnostic handler or database version/clock response.

The 404 recovery enhancement ([TOG-10824](/TOG/issues/TOG-10824), contract
reconciled in [TOG-11066](/TOG/issues/TOG-11066)) supersedes the original
unconditional no-binding-read clause for ordinary 404 responses only. Like any
unknown path, a removed diagnostic path may perform the optional, public-only
lookup of at most three published, not-ended events: 400 ms SQL timeouts and a
500 ms overall deadline, failing open to an empty suggestion list. Responses
remain 404, noindex, private/no-store and session-free. No database error or
connection metadata is exposed. Unsafe requests refused by the global
same-origin guard still return 403 before reading any database binding. The
removed-diagnostics tests pin response and DB-access parity across both host
configurations, including absent, available and failing fixture lookups.

The existing `/up` queue read already exercises the Worker-to-Hyperdrive-to-Postgres
path: a counted queue proves connectivity; `queue.status: "unknown"` reports an
unconfigured/unreachable ledger, not database acceptance. Deploy smoke moves from
`/health` to `/up` and accepts the existing healthy/degraded/unknown envelope,
including during an outage. It does not turn liveness into a database gate or
change `/up`'s payload. The direct CLI probe remains non-HTTP and operator-invoked;
no public version/clock endpoint or redirect alias remains.

## 3. Machine ingress (`routes/api.php`)

| Legacy | Next status | Card |
|---|---|---|
| `POST /api/agent-events` (bearer, 5 ops, per-grant budgets, idempotency replay, audit-everything, outer 60/min shield, HMAC bot signer byte-parity) | Shared `events` storage, public publication, post-commit admin write-back carrier and independent signed `event.read` observation implemented; standalone replay objects, cross-writer lifecycle locks/revisions and migrated fold round trips covered; live carrier/runtime integration still unbound (see agent-events.md) | W14 ✅ + [TOG-11159](/TOG/issues/TOG-11159) |
| Grants admitted out-of-band, no Filament resource (AgentEventGrantPolicy view-only) | ✅ nothing to build — no UI in legacy either | W14 ✅ |

## 4. Livewire → islands (no Livewire protocol on Workers; SSR + binders)

| Legacy component | Next status | Card |
|---|---|---|
| GoingCount (badge, `going-count-updated` broadcast, one count query) | ✅ contract + binder + drift tests (`test/islands-going-count*.test.ts`, `test/going-count-ssr-binder.test.ts`) | W10 slice 1 ✅ |
| RsvpButton (all states, honeypot swallow, throttle copy, focus) | ✅ island shipped (`src/events/rsvp-button.tsx` + `public/islands/rsvp-button.js`, mounted in `src/events/pages.tsx`); contract + drift + binder tests (`test/islands-rsvp-button.test.ts`, `test/islands-rsvp-binder.test.ts`, PR #98) | W10 slice 2 ✅ ([TOG-9839](/TOG/issues/TOG-9839) done) |
| EventsCalendar (list+grid one pass, `?q=` search + logging, month math, Discord transients) | ✅ server side (search + logging, TOG-10105 ✅) + island UI (`test/islands-events-calendar.test.ts`) | W10 slice 3 ✅ |
| PastEvents (20/page, canonicals, no RSVP controls) | ✅ island UI (`test/islands-past-events.test.ts`) | W10 slice 4 ✅ |
| MemberProfile (view/edit, PATCH validation, spam trap, focus) | ✅ island UI (`test/islands-member-profile.test.ts`, `test/member-profile-edit-lifecycle.test.ts`); expired-save drafts preserved until reset (PR #239) | W10 slice 5 ✅ |

## 5. Filament admin (`/admin`, panel `admin`, TWO Moderation brand)

| Legacy surface | Next status | Card |
|---|---|---|
| Panel gate: Discord-role → 403 (no login form), dark brand, CSP stack, `RecordMemberDataAccess` on panel | ✅ custom React rebuild, no Filament (`src/admin/guard.ts`; `test/admin.test.ts` guard pins: guest redirect, non-moderator 403, forged-origin 403, storeless 503) | W11 ✅ (M1) |
| Events resource: table (search/sort/status/series/fill filters, publish/cancel/pause/reopen actions, no delete/bulk) + create-as-draft + edit (UTC↔wall DST carriers) + recurrence fields | ✅ table search/status/series/fill + allowlisted title/starts_at/status sort and 25-row pagination ([TOG-10825](/TOG/issues/TOG-10825) ✅); pause/reopen row + edit actions and `rsvp_open` ternary filter ([TOG-10817](/TOG/issues/TOG-10817) ✅); create-as-draft → edit → publish → cancel audited + wall-time field errors (`test/admin.test.ts`, `test/admin-event-form-errors.test.ts`) | W11 ✅ (M2/M3) |
| `GET /admin/events/create`, `GET /admin/events/:key/edit` (Filament bookmarks) | ✅ merged (PR #105): 301 map to `/admin/events/new`, `/admin/events/:key`; same moderator guard, no resource reads, all queries dropped (`test/legacy-redirects.test.ts`) | [TOG-11156](/TOG/issues/TOG-11156) ✅ |
| `GET /admin/featured-contents`, `GET /admin/featured-contents/create`, `GET /admin/featured-contents/:id/edit` (Filament bookmarks) | ✅ merged (PR #105): 301 map to `/admin/featured`, `/admin/featured/new`, `/admin/featured/{nativeId}`; edit resolves imported `legacy_id` after the guard (404 if missing/invalid, 503 if unavailable), never falls back to a same-number native row; non-canonical native-ID spellings rejected (`test/admin-featured-record-id.test.ts`); all queries dropped (`test/legacy-redirects.test.ts`) | [TOG-11156](/TOG/issues/TOG-11156) ✅ |
| RsvpsRelationManager (read-only roster, `canViewForRecord` 403) | ✅ read-only per-event roster on the admin edit page, subjects access-logged (`src/admin/routes.tsx`; `test/admin-reads.test.ts`) | W12 ✅ (M6) |
| FeaturedContent resource (CRUD + publish window + live preview + safe delete) | ✅ create → publish toggle → reorder → delete, audited (`test/admin.test.ts`); publish-window status + live preview (PR #82; `test/featured-preview.test.ts`); homepage render path (`test/featured.test.ts`) | W11 ✅ (M4) |
| JoinAttempt resource (read-only viewer: outcome/source/request/discord-id) | ✅ read-only viewer, newest-first + outcome filter + exact id search, subjects logged, no write verb (`test/admin-reads.test.ts`, `test/admin-join-attempt.test.ts`) | W12 ✅ (M8) |
| JoinFunnelStats widget (per-outcome counts, 60 s cache, no member data) | ✅ [TOG-11226](/TOG/issues/TOG-11226) ✅ (60 s per-connection cache; injected ADMIN_DB takes precedence; both optional analytics reads start together with one 1500 ms budget after DB resolution; each SELECT has a 400 ms DB-side cap, excluding authorization/access logging; `test/admin-join-funnel.test.ts`) | W12 ✅ (M8 funnel-stats) |
| TopZeroResultSearches widget (normalized queries only) | ✅ TOG-10105 ✅ (dashboard section, moderator gate) | W12 ✅ |
| Moderator admin guide + member-data docs | ✅ `docs/moderator-admin-guide.md` (merged PR #74) | W11 ✅ / W12 ✅ |

## 6. Jobs, queues, scheduler

| Legacy | Next status | Card |
|---|---|---|
| SyncEventToDiscord (unique per eventKey, tries 6, backoff 10/60/300/900/3600, debounce 10 s, grant recheck, terminal stamp) | ✅ `src/jobs/sync-event.ts` + consumer (`src/jobs/consumer.ts`); shape pinned in `test/jobs.test.ts` (unique/debounce/backoff/terminal), real-SQL timing in `test/jobs-scheduled.test.ts` | W13 ✅ |
| CallInternalAction (`role.assign`/`announcement.post` only; production web never dispatches it — drill-only) | ✅ runtime handler `src/jobs/call-internal-action.ts` (`test/jobs.test.ts`, retry-delay/handler-deadline tests); staging drill-only script merged (PR #267): `bin/internal-action-drill.mjs` + `src/probes/internal-action-drill.ts`, fixture-pinned in `test/internal-action-drill.test.ts` (staging guard, production host refused); no-web-dispatch pinned in `test/callinternalaction-no-web-dispatch.test.ts` (PR #361) | W13 ✅ + [TOG-11706](/TOG/issues/TOG-11706) ✅ |
| `events:reconcile` every 10 min (close past, materialize series, re-dispatch stale; single-flight) | ✅ `reconcileEvents` in `src/jobs/cron.ts` (close finished, materialize series, re-dispatch stale) on the pg EventStore (`src/jobs/event-store-pg.ts`); single-flight via `runScheduled` (`test/jobs-scheduled.test.ts`, `test/prune.test.ts`) | W13 ✅ |
| `model:prune` daily ×3 (MemberDataAccessLog, JoinAttempt + AgentEventIdempotencyKey, EventSearchLog; 90 d windows) | ✅ `pruneModelTables` in `src/jobs/cron.ts` (90 d each, legacy constants; `test/prune.test.ts` memory + real Postgres) | W13 ✅ |
| `web_sessions` expiry cleanup (no legacy equivalent — Laravel GC; rows accumulate without one) | ✅ expiry sweep in the same prune pass (`test/prune.test.ts`) | W13 ✅ |
| Bot write-back after every event mutation (`syncAfterCommit`, drafts/past/unmirrored skip) | ✅ per-mutation `writeBack`/`childWriteBacks` in `src/admin/store.ts` (drafts/past/unmirrored skip); tracked write-back via W13 `SYNC_EVENT_QUEUE` with ledger, 10 s debounce + unique lock (PR #68; `test/rsvp-writeback-recovery.test.ts`, `test/rsvp-writeback-outage.test.ts`, PR #247); title-only edit write-back pinned (`test/event-title-edit-writeback.test.ts`). Bot HTTP adapter still pending (no live Discord proof) | [TOG-10815](/TOG/issues/TOG-10815) |

## 7. Console commands

| Legacy | Next status | Card |
|---|---|---|
| `discord:check-moderators` (deploy-time role-config probe) | ✅ ported (PR #38): `src/probes/check-moderators.ts` + `bin/check-moderators.mjs`, fixture-pinned in `test/probes.test.ts` (blank/dev PASS, require-configured FAIL, SySOp-only PASS, doomed-role FAIL); never touches the network. Live W16 rehearsal use stays on the pre-flip card | [TOG-10112](/TOG/issues/TOG-10112) (blocked; parent [TOG-9698](/TOG/issues/TOG-9698)) |
| `bot:internal-action-smoke` (live-against-staging QA) | ✅ ported (PR #38): `src/probes/bot-smoke.ts` + `bin/internal-action-smoke.mjs`, fixture-pinned in `test/probes.test.ts` (signer + staging guard, production host refused, announcement-only mode); staging-only drill entry merged (PR #267; `test/internal-action-drill.test.ts`) | [TOG-10112](/TOG/issues/TOG-10112) (blocked; parent [TOG-9698](/TOG/issues/TOG-9698)) + [TOG-11706](/TOG/issues/TOG-11706) ✅ |
| `queue:check-depth` (box probe) | dropped as a command (no box on Workers) — replaced by `GET /up` | **N3** ✅ ([TOG-9895](/TOG/issues/TOG-9895)) |
| `error-alert:probe`, `queue:poison-probe` (drills) | ✅ re-expressed as Vitest tests (`test/drill-probes.test.ts`: error-alert 1-per-fingerprint/5min critical line against a fixture logger; poison-queue fixture isolated from ordinary queued work; fixture-only, no staging/prod) | [TOG-11732](/TOG/issues/TOG-11732) ✅ |
| `ci:session-cookie` (perf-budget session minter) | unnecessary for the five guest-page budgets; authenticated perf surfaces remain uncovered | [TOG-10845](/TOG/issues/TOG-10845), [coverage](performance-budgets.md) |
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
| EventPolicy (view/drafts/publish/cancel/toggleRsvp/Delete moderator-only) | ✅ drafts 403 non-moderator, cancelled 410 + noindex, JSON/ICS same view rule, writes moderator-only (`src/events/routes.tsx`; `test/event-page.test.ts`, `test/event-gone-surfaces.test.ts`, `test/event-write-member-denied.test.ts`, `test/draft-ics-conditional-access.test.ts`) | W8 ✅ |
| RsvpPolicy (owner-only write; Published + !ended + rsvpOpen create) | ✅ owner-only, Published + !ended + rsvpOpen | W9 ✅ |
| FeaturedContentPolicy (all moderator; public via `currentlyVisible`) | ✅ moderator-only writes (`src/featured-policy.ts`, `ALL /admin/*` guard), public reads exactly `currentlyVisible` (`src/featured.ts`; `test/featured-policy.test.ts`) | W11 ✅ |
| JoinAttemptPolicy (read moderator; writes denied — controller writes direct) | ✅ moderator-only reads (`src/admin/guard.ts` + `src/admin/reads.ts`; `test/admin-join-attempt.test.ts`), zero admin write routes with the single controller insert (`src/join/service.ts` `recordAttempt`; `test/join-attempt-write-policy.test.ts`) | W6 ✅ + W12 ✅ |
| UserPolicy (`updateProfile` self-only) | ✅ owner-only PATCH incl. moderator-refused, no existence oracle (`src/profiles/routes.tsx`; `test/profile-self-only.test.ts`) | W7 ✅ |
| `access-admin` gate (`is_moderator`, recomputed from Discord role IDs each login) | ✅ recompute live + gate enforced: guest bounce, non-moderator 403, failure 503, private no-store (`src/admin/guard.ts`; `test/admin-guard-matrix.test.ts`) | W5 ✅ + W11 ✅ |

## 10. Middleware and edge behavior

| Legacy | Next status | Card |
|---|---|---|
| `secureHeaders`-equivalent (CSP on web+admin+leaves, static anti-framing/sniffing globally) | ✅ global secureHeaders (stricter: no inline/eval — no Livewire to need it) | W3 ✅/W4 ✅ |
| `AddSecurityHeaders::HEADERS` (nosniff, strict-origin-when-cross-origin, X-Frame-Options DENY, Permissions-Policy camera/microphone/geolocation) | ✅ byte-identical `SECURITY_HEADERS` (`src/headers.ts`), pinned against the legacy table in `test/w16b-env-parity.test.ts` | W16b ✅ [TOG-11942](/TOG/issues/TOG-11942) |
| `AddContentSecurityPolicy` directive set | Deltas, each pinned in `test/w16b-env-parity.test.ts`: **stricter** — `script-src`/`style-src` `'self'` (no `unsafe-inline`/`unsafe-eval`; only JSON-LD data blocks are inline), `img-src` self + Discord CDN + exact allowlist (no `https:`/`data:`), `frame-src` Discord widget on `/join` only; **added** — `form-action 'self'` (TOG-7095's admin-logout breakage cannot recur: logout posts same-origin `/logout`), report sink `/csp-reports`; **kept/restored** — `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `connect-src 'self'` (every island fetch is a same-origin path); **omitted** — `upgrade-insecure-requests` (every source list is `'self'` or an explicit `https://` host, so an `http:` subresource is blocked, not upgraded) and HSTS (edge-owned, TOG-8729) | W16b ✅ [TOG-11942](/TOG/issues/TOG-11942) |
| Per-env robots/sitemap + staging noindex | Robots `Sitemap:` and every sitemap `<loc>` name the serving env's own origin; robots body is allow-shaped in every env (as legacy), staging's crawl bar is `X-Robots-Tag: noindex, nofollow` on HTML. Staging deploy smoke (`bin/smoke.mjs`) asserts same-origin robots + sitemap and HTML noindex | W16b ✅ [TOG-11942](/TOG/issues/TOG-11942) |
| One-429-shape (ThrottleEnvelope, all throttles) | ✅ agent ingress; RSVP writes ✅ (rateLimitExceeded); other human routes as they land | W14 ✅ + W9 ✅ |
| Route throttles 10,1 (join/login/QA) and 30,1 (logout/event writes) | ✅ `src/throttle.ts` + every-POST-throttled audit (`test/throttle.test.ts`) | **N5** ✅ |
| VerifyCsrfToken on unsafe web methods | Central same-origin guard for POST/PUT/PATCH/DELETE, two exact machine exemptions, mounted-route audit; no CSRF token scheme ([policy](same-origin.md)) | [TOG-10850](/TOG/issues/TOG-10850) |
| `member-access-log` (arm/flush, fail-closed 503 when enforced) | ✅ `src/access-log.ts` middleware on member routes; admin guard carries the same contract | W7 ✅ + W12 📋 (retention) |
| TrustHosts (APP_URL host only) / trustProxies (nginx socket) | Workers: platform TLS; strict APP_URL hostname allowlist (`src/trust-hosts.ts`), no loopback exemption; malformed Host fails closed, IPv6 supported; worker-first ASSETS fallback covers static traffic, workers.dev disabled | [TOG-10110](/TOG/issues/TOG-10110) |
| Maintenance mode except `/discord` | dropped — Workers deploys are atomic, no maintenance mode; DB-free `/discord` floor preserved | dropped (platform) |
| CompressStaticAssets (gzips Livewire runtime) | dropped — no Livewire runtime; edge compresses static assets | dropped (platform) |

## 11. Services, support, validation

| Legacy | Next status | Card |
|---|---|---|
| EventService (capacity/waitlist under lock, series create/materialize, sync-after-commit) | ✅ capacity floor + FIFO waitlists/promotions under the event `FOR UPDATE` lock; series pending | [TOG-10816](/TOG/issues/TOG-10816) + W11 🔶 + W13 ⛔ |
| InternalActionClient + signer (sole bot speaker; `addMember` sync-only, never queued) | ✅ signer byte-parity; client pending | W14 ✅ + W13 ⛔ |
| EventIcs/EventRss/EventFeed/EventSubscribe/EventGoogleCalendar/EventJsonLd | ✅ | W8 ✅ (JSON-LD) + W9 ✅ (feeds) |
| RsvpRateLimit / AgentEventRateLimit | ✅ / ✅ | W9 ✅ / W14 ✅ |
| SafeRedirect (guarded `next`), SpamTrap (honeypot + 1000 ms floor) | ✅ `safeNext` on login/join/event-CTA returns, incl control-byte rejection / pending | W6 ✅ / W7 📋 + W9 📋 |
| RecurrenceSchedule/RecurrenceInput, EventInput, Rules (IANA tz, wall-time, control chars) | partial: non-integer recurrence counts rejected (`test/recurrence-count-validation.test.ts`); rest pending | W11 🔶 (form) + W13 ⛔ (materialize) |
| MemberStatsSource / Profiles support (rank, stats, milestones) | ✅ `src/profiles/stats.ts`: never-throw read of `web_v1.members` + `web_v1.member_milestones`; member-gated profile block, local fixture coverage | W7 ✅ |
| Home support (Lobby Ledger, ranks, Discord widget iframe) | ✅ shell + upcoming-event teaser; live counts + rank reads merged (`test/home-counts.test.ts`, `test/counts.test.ts`) | W4 ✅ + W6 🔶 (widget) + [TOG-10818](/TOG/issues/TOG-10818) (counts/ranks) ✅ + [TOG-10820](/TOG/issues/TOG-10820) (upcoming) ✅ |
| Counts (never-throw degraded empty state) | live/rank view reads + 60 s isolate cache merged; stale numerals hidden per card; [contract](web-v1-contract.md) | W4 ✅ + [TOG-10818](/TOG/issues/TOG-10818) ✅ |

### Waitlist service contract ([TOG-10816](/TOG/issues/TOG-10816))

- Full-event `going` writes return 201/200 with `status: waitlisted` and one-based `waitlist_position`; they take no seat and spend the same shared per-member 12/min budget. **Requested divergence:** the frozen legacy service refuses full-event `going` with 409 and accepts an explicit `waitlisted` answer; Next automatically joins the line.
- FIFO uses `(created_at, id)` in Postgres, including exact sub-millisecond timestamps. Fresh keys use the database's post-lock `clock_timestamp()`, never the Worker's millisecond clock or transaction-start time. Existing waiters retain priority on re-answer; an older non-waitlisted answer joining the line gets fresh FIFO keys.
- Every accepted RSVP write settles the line under the event-row lock, so a new Going request cannot bypass an existing head and a stale-view explicit Waitlisted answer can immediately take a vacant seat. Withdrawal, a Going downgrade, and admin/JSON event edits also settle available seats within that transaction. Capacity increases promote N heads; removing the cap promotes all. Paused, cancelled, draft and ended events do not promote. Promoted rows reset their Discord mirror stamps; the caller queues one event write-back after commit.
- Member budget/expiry decisions follow all own-row, promotion-row and prune waits. Limited writes do not change answers or promote anyone; accepted writes spend one fresh hit regardless of automatic promotion.
- Capacity below the current Going count is an admin form field error / JSON 422. JSON numeric capacities and title-only PATCH defaults retain the finite cap; malformed capacities cannot erase it.
- The shared position helper supplies RSVP JSON, viewer-specific `/events.json` rows and `/e/{key}`'s `data-waitlist-position` carrier alongside member-only Going attendees. All event pages are private/no-store with `Vary: Cookie` because the guest join pitch depends on the viewer; guests receive no position or attendee identities. Parent time/capacity edits preserve recurrence child write-backs while promoting FIFO. RsvpButton UI states remain the W10 slice 2 deliverable.
- Proof: `test/rsvp-waitlist.test.ts` ports service/HTTP WaitlistTest cases and forces a concurrent withdraw + Going race on an owned disposable Postgres schema, proving the existing head keeps the freed seat and capacity is never exceeded. Tests use only agent-testdb or CI Postgres, never staging/production.

## 12. SEO, shell, content, sessions

| Legacy | Next status | Card |
|---|---|---|
| Share meta (canonical + OG/Twitter, no og:image) + RSS autodiscovery | ✅ layout-level + per-event tags: canonical, og:url/title/description, twitter:title/description/card, no og:image (`src/pages.tsx` Layout, `src/events/pages.tsx` EventDetailShell/EventPage; `test/event-page.test.ts` per-event tags, `test/page-description-metadata.test.ts`, `test/seo.test.ts`) | W4 ✅ + W8 ✅ |
| `site.webmanifest` + icons (192/512/maskable/apple) + theme-color `#0b0714` | ❌ missing (`public/` has styles + islands only) | **N2** (new: manifest/icons) |
| Branded 404/429/500/503 pages | ✅ branded shells; 404 now has a fail-open, 500 ms lookup (3 upcoming published events) and GET `/events?q=` search, without session reads/writes; 500/429 recovery CTA points at the Discord invite (`test/errors-recovery-cta.test.ts`) | **N2** + [TOG-10824](/TOG/issues/TOG-10824) |
| Draft/noindex + gone-410 + past-never-indexed rules | ✅ sitemap side (published-only `src/seo.ts`) + route side (draft/past meta + header noindex, cancelled 410 + noindex, published no signal; `src/events/routes.tsx`, `src/events/pages.tsx`; `test/event-page.test.ts`, `test/event-gone-surfaces.test.ts`) | W8 ✅ |
| `content/privacy-policy-v1.md` (superseded by v2, retained as history) | ❌ see N1 | **N1** |
| `content/faq-preview*.md` (docs-only), `content/welcome/*` (unwired drafts) | copy inlined / never wired | dropped (docs-only / dead) |
| Design-lab routes (non-prod visual experiments) | ✅ correctly absent | dropped (never production) |
| DB sessions, 120-min sliding lifetime | ✅ DB-backed + rotation; 120-minute window re-stamped on login and every authenticated page view (`SESSION_TTL_SECONDS`, `src/sessions.ts`), status cookie follows it. No divergence: the earlier 30 d CPO divergence is withdrawn (privacy v2 keeps the v1 "no remember-me" promise, [TOG-12556](/TOG/issues/TOG-12556)) | W5 ✅ + [TOG-12928](/TOG/issues/TOG-12928) |
| Session cookie `__Host-`, HttpOnly, Lax; OAuth state bound to signed cookie | ✅ | W5 ✅ |
| Lighthouse public-page budgets + per-entry raw/gzip bundle budgets | local fixture worker, real pages/assets; legacy LCP/CLS/mobile profile unchanged, all islands and stylesheet budgeted | [TOG-10845](/TOG/issues/TOG-10845), [performance gates](performance-budgets.md) |

## 13. New cards created by this matrix (all in TWO Web Next, one PR each)

- **N1** ([TOG-9893](/TOG/issues/TOG-9893)) — `/privacy` versioned policy page: render `privacy-policy-v1.md` from disk via `Str::markdown`-equivalent, funnel-style (no session/cache/DB), CSP header. Acceptance: 200 with DB down; version bump = new file + const.
- **N2** ([TOG-9894](/TOG/issues/TOG-9894)) — webmanifest + install icons + theme-color + branded 404/429/500/503. Acceptance: manifest serves, icons resolve, each error code renders brand (no stack traces; 429 shape per W9).
- **N3** ([TOG-9895](/TOG/issues/TOG-9895)) — `GET /up` always-200 `{status, queue{…}}` with warn 20 / critical 100, unknown-not-500. Blocked by W13 (queue visibility). Replaces `queue:check-depth`.
- **N4** ([TOG-9896](/TOG/issues/TOG-9896)) — log-based error alert (1 per fingerprint / 5 min, dont-report list respected) + queue-failing critical line; runbook for tailing. Blocked by W13.
- **N5** ([TOG-9897](/TOG/issues/TOG-9897)) — human-route throttles: 10,1 join/login/QA + 30,1 logout/event writes, one 429 shape, `every-POST-throttled` audit. Rides the W9 throttle mechanism; blocked by W9.
- **N6** ([TOG-9898](/TOG/issues/TOG-9898)) — user-roster write on sign-in/join (`updateOrCreate` Discord id/username/avatar/member flag; never the moderator flag — recompute owns that). The `users` table exists from W3 but nothing writes it; W7/W11 reads need it. Acceptance: repeat login updates the row, no duplicates, moderator flag untouched by the write path.

Unmapped rows remaining: **0**. Dropped rows carry reasons above; every other
row names its card. Re-run 2026-10-03 at `b46a479a`: table scan finds no row
without a card or drop reason, and no new legacy surface appeared (legacy
still pinned at `e1e939a`); this refresh records only post-`e2f8969`
landings, no product code changed. Re-run this matrix before the DNS flip.
