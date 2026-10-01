# W15: auth, sessions, join and QA-login acceptance net

This is the test-port slice for [TOG-10114](/TOG/issues/TOG-10114), under
[TOG-9697](/TOG/issues/TOG-9697). A green suite proves the **mapped Next
contracts**, not full legacy feature parity or permission to flip production.

## Source and disposition rules

The inventory was read from legacy `TogetherWeOwn/two-web` at
`3266015bbfcec3c8dcfeef527125994679a1a27e` (2026-09-30). This is a newer local
snapshot than `e1e939a`, the source pinned by `docs/parity.md`; it includes the
later fixation, replay, return-page and session-UX regressions. Legacy is
read-only. No PHP tests or live deployment/database probes were run.

Paths in the tables are relative to legacy `tests/`. Line references identify
legacy scenario declarations, **not** an assertion that every case in a partly
ported file is covered. Destinations are relative to this repository.

- **Ported/adapted:** portable behavior is asserted in the named Vitest suite.
- **Dropped:** implementation-only Laravel/Livewire/Dusk assertions do not apply.
- **Gap/deferred:** behavior is absent or owned by another slice; **not a pass,
  not a waiver**. The production parity gate stays NEEDS WORK until these rows
  have executable coverage or an authorized disposition.

## Recorded Next divergences

1. **POST QA login**, versus legacy GET: `docs/parity.md:33`. Test POST creates
   a normal session; GET is absent (Hono 404, not Laravel 405); all failed POSTs
   are identical 404s with no session. No redirect/query parameter carries the
   configured QA token.
2. **30-day rotating TTL**, versus the legacy 120-minute sliding session:
   `docs/parity.md:170`, legacy `config/session.php:35`. Assert creation expiry,
   cookie Max-Age, expiry refresh on authenticated read, exact expiry boundary,
   deletion of the old token and logout revocation. Legacy cookie tests do not
   contain a time-advance TTL assertion; this is additional coverage of the
   recorded Next contract, not a fabricated legacy test.
3. **Same-app Discord auto-join**, versus legacy membership-gated login:
   `docs/parity.md:32`, `src/roles.ts:5-11`, `src/join/service.ts:8-23`.
   Assert `identify guilds.join`, direct Discord PUT and bot-token role recompute.
   Failed ordinary-login auto-join still signs in as a non-member; failed
   one-click join renders recovery without issuing a member session. The
   legacy profile-session flash copy is carried by the `join_result` signed
   cookie, which renders the confirmation banner on `/`, `/join`,
   `/profile`, `/events`, and `/e/{key}` — homepage notices remain the `?n=` fallback.
4. **Signed journey cookies**, versus Laravel session keys: attribution and
   safe return survive OAuth, are cleared on completion/denial, and unsafe
   values are omitted. `src/return-journey.ts` carries `login_next` and
   `url.intended` as signed cookies with the legacy precedence
   (explicit next > recorded intended > default landing); gate bounces record
   the requested path for GET/HEAD only.

## Core file mapping

| Legacy test file | Disposition and Next proof / explicit omissions |
|---|---|
| `Feature/Auth/DiscordLoginTest.php` (90-506) | **Adapted:** `test/app.test.ts`, `test/auth-acceptance.test.ts`, `test/roster.test.ts`, `test/admin.test.ts`, `test/profiles.test.ts`: scopes/state, identity/display-name/roster, moderator grant/fail-closed roles, auth failure, logout and gates. **Dropped:** Socialite, remember-me cookie, Laravel flash/translation mechanics. **Gap:** exact ordinary-login recovery copy and arbitrary exception-message log redaction are not proven by redirect tests. |
| `Feature/Auth/OAuthReplayAndThrottleTest.php` (88-246) | **Partial port:** missing/mismatched state rejected before exchange in `test/app.test.ts`, `test/auth-acceptance.test.ts`, `test/join.test.ts`; Worker mismatch proof in `test/auth-worker.test.ts`. **Implemented, review pending ([TOG-10354](/TOG/issues/TOG-10354)):** `test/auth-admission.test.ts` competes callbacks with the ORIGINAL signed cookies while the first exchange is blocked; only one exchange/join/session/attempt occurs. `test/oauth-journeys.test.ts` proves independent Postgres-client admission and expiry. Browser cookie deletion alone remains insufficient. Login/QA/logout throttles defer to [TOG-9897](/TOG/issues/TOG-9897) (N5). |
| `Feature/Auth/SessionFixationTest.php` (125,140,157) | **Adapted:** random opaque tokens, authenticated-view rotation, old-cookie rejection and logout replay in `test/app.test.ts`, `test/auth-acceptance.test.ts`, `test/e2e-db.test.ts`, `test/auth-worker.test.ts`. **Dropped:** issuing a new Laravel guest session ID after logout. **Implemented, review pending ([TOG-10354](/TOG/issues/TOG-10354)):** `test/auth-admission.test.ts` proves fresh auth/join invalidates the supplied active token, including already-member re-entry; denial/exchange failure preserve it without minting or elevating. `test/oauth-journeys.test.ts` proves replacement-insert failure rolls back prior-token revocation in real Postgres. |
| `Feature/SessionCookieFlagsTest.php` (17,51,61) | **Ported:** emitted `__Host-`, Secure, HttpOnly, Lax, Path=/, absent Domain in `test/auth-acceptance.test.ts`; TTL and runtime login also covered. **Dropped:** `.env.example` PHP cookie settings and nginx TLS-proxy harness; Workers receives HTTPS directly. |
| `Feature/Auth/ReturnToPageTest.php` (107-231) | **Ported/adapted:** ordinary-login next/intended precedence (107-165), hostile values, one-shot consumption and denial/failure clearing in `test/login-return.test.ts` and `test/auth-worker.test.ts`; join safe return and landing-link propagation in `test/join.test.ts`. Event/calendar CTA integration (223,231) is covered by the guest/member `data-testid="signin"` (carrying the page as `?next=`) and `event-join-pitch`/`discord-join` cases in `test/login-return.test.ts`, plus stale-restart clearing, NUL rejection and failed-join recovery pins. **Dropped:** Laravel session-key mechanics (`login_next`, `url.intended`) become `__Host-two_login_*` signed cookies; the precedence contract is what is pinned. |
| `Unit/SafeRedirectTest.php` (14,21,42) | **Ported:** `safeNext` tests in `test/join.test.ts`: rooted paths/query strings accepted; absolute/protocol-relative/backslash/scheme/whitespace/non-string inputs rejected. The port exposed raw whitespace acceptance; the minimal guard now rejects it before URL normalization. Control bytes (notably NUL, which would 500 in the callback `Location` header) are rejected too — pinned via the hostile-next table in `test/login-return.test.ts`. |
| `Feature/Auth/DiscordRedirectUriTest.php` (47-76) | **Adapted:** configured APP_URL and exact auth/join callback paths in `test/app.test.ts`, `test/join.test.ts`, `test/auth-worker.test.ts`. **Dropped:** Laravel route names, nginx forwarded-proto settings. Forged-host rejection remains the W16 host-policy gate, not proven here. |
| `Feature/Auth/DiscordModeratorRoleIdsTest.php` (75-108) | **Ported:** `test/auth-acceptance.test.ts` parser/multiple IDs/padding/blank/name rejection; `test/app.test.ts` bot role lookup and fail-closed moderator recompute. **Dropped:** PHP config-cache execution. |
| `Feature/Auth/DiscordGuildIdTest.php` (67-81) | **Adapted:** `test/join.test.ts` configured snowflake widget and no-widget fallback. **Dropped:** PHP env default fallback; Next deployment vars supply the guild explicitly. Blank ordinary-login guild behavior is not represented as the legacy membership gate. |
| `Feature/Auth/StagingQaLoginTest.php` (33-123) | **Adapted:** `test/auth-acceptance.test.ts`, `test/app.test.ts`, `test/e2e-db.test.ts`, `test/auth-worker.test.ts`: POST-only normal member/moderator sessions, missing/blank/wrong token, unknown identity, exact staging-origin gate, indistinguishable failures, no Discord calls. Existing admin/profile suites cover normal session authorization. |
| `Unit/StagingQaRouteRegistrationTest.php` (7,47) | **Adapted:** observable 404 off staging in `test/auth-acceptance.test.ts`. **Dropped:** PHP route-collection/cached-route introspection; Hono mounts the POST route but its gate fails closed. |
| `Feature/Auth/DiscordDuskSeamGuardTest.php` (20,30) | **Dropped:** local-only deterministic Socialite/Dusk provider does not exist in Next. Runtime tests bundle a test-only entry under `test/fixtures`; production entry remains `src/worker.ts`. QA-origin exclusion remains covered rather than dropped. |
| `Feature/Auth/CheckDiscordModeratorsTest.php` (65-168) | **Dropped from W15 request tests / deferred:** deploy-time Artisan role-audit command belongs to W16 pre-flip verification (`docs/parity.md:98`); runtime role recompute is covered separately. |
| `Feature/Join/OneClickJoinTest.php` (58-180) | **Adapted:** `test/join.test.ts`, `test/auth-worker.test.ts`: exact scopes, synchronous add, sign-in, source/outcome, safe next, invite recovery; no queued token. Moderator is recomputed, not blindly preserved. The legacy profile confirmation/re-invite UI is the `data-testid="join-result"` banner (added/already-member copy plus `data-testid="reinvite-link"`) pinned in `test/login-return.test.ts`. |
| `Feature/Join/JoinAttemptFunnelTest.php` (69-266) | **Ported/adapted:** `test/join.test.ts`: added/already-member/denied/error/degraded rows, attribution, safe columns and live test-container persistence. Direct Discord PUT has no bot request ID, so null is asserted. Funnel stats/admin gate are covered by `test/admin-reads.test.ts` (W12), not duplicated. |
| `Feature/Join/JoinDenialMatrixTest.php` (71-191) | **Partial port:** `test/join.test.ts`: refused bot=no member session; denial/generic errors=no exchange; exchange outage; already-member and safe return. **Implemented, review pending ([TOG-10354](/TOG/issues/TOG-10354)):** `test/auth-admission.test.ts` adds original-cookie duplicate admission, blank-bot no-OAuth/no-exchange/no-member-session behavior, already-member re-entry, and bot-refusal no-elevation contracts against memory and isolated Postgres. Invalid/unissued/replayed state does not append a terminal attempt; an admitted denial/failure appends at most one. |
| `Feature/Join/JoinCallbackFailureTest.php` (39,77,127) | **Partial adaptation:** `test/join.test.ts`: invalid state recovery, exchange outage503, safe static invite and cleared cookies. This class-based PHPUnit test is included in the inventory even though it lacks Pest `it()` declarations. **Gap:** expired invalid_grant immediate-retry classification versus infrastructure503 is not yet matched. |
| `Feature/Join/AccessTokenIsNeverLoggedTest.php` (13) | **Partial port:** persisted-token hygiene in `test/join.test.ts`; token is confined to intercepted outbound Discord requests in `test/auth-worker.test.ts`. **Gap:** arbitrary nested exception-message redaction across all log channels is stronger and is not proven by table-hygiene tests. |
| `Feature/Join/AlreadyMemberReinviteTest.php` (24,37,45) | **Adapted:** the already-member join flashes `join_result` and the next render of `/`, `/join`, `/profile`, the `/events` calendar, or the `/e/{key}` join landing shows `data-testid="join-result"` with `data-testid="reinvite-link"` → `/discord` (which resolves to the live invite) — pinned in `test/login-return.test.ts` and `test/auth-worker.test.ts`. One-shot: the second render carries no banner, and island fragment swaps never consume the pending flash. |
| `Feature/Join/JoinResultCopyTest.php` (7,31,50,64) | **Adapted:** added/already-member confirmation copy in the `data-testid="join-result"` banner (`test/login-return.test.ts`, `test/auth-worker.test.ts`), homepage notices plus distinct denial, expired-state, bot-refusal and unreachable recovery copy in `test/app.test.ts`, `test/join.test.ts`, `test/auth-worker.test.ts`. **Dropped:** Laravel flash keys/translation calls. The immediate-retry UX gap (JoinCallbackFailureTest) remains. |
| `Feature/Join/JoinWidgetFallbackTest.php` (12,45,64) | **Ported/adapted:** `test/join.test.ts` iframe/fallback link/no-widget copy, sandbox/lazy/no-referrer attributes. **Dropped:** PHP translation-key existence check; Next renders its copy directly. CSP frame-policy readiness still belongs to W16, not proven by an iframe-string assertion. |
| `Feature/Join/JoinQueryCountTest.php` (19,31) | **Adapted:** database-free join leaf uses no store lookup; `test/join.test.ts` landing page and `test/seo.test.ts` zero-store funnel proofs. **Dropped:** Laravel DB query listeners and user-count fixture inflation, which are framework-specific. |
| `Feature/Join/JoinLangCoverageTest.php` (104-194) | **Dropped:** PHP/Blade translation key-set/source scanning and prohibition of hardcoded controller English do not apply to Next's inline JSX copy. Observable rendered failure copy is covered; no localization architecture is invented in this slice. |
| `Feature/Join/JoinAttemptPolicyTest.php` (21-45) | **Deferred outside public auth/join scope:** W12 read-only moderator viewer is covered by `test/admin-reads.test.ts`; Laravel model-policy method introspection is dropped. |
| `Feature/DiscordFunnelTest.php` (17-134) | **Ported/adapted:** `test/seo.test.ts` configured/hostile/static fallback,302,no-store,no dependency reads; `test/join.test.ts` recovery fallback; homepage join CTA. **Dropped:** maintenance-mode harness because Workers deployments are atomic (`docs/parity.md:142`). |
| `Feature/Auth/AuthStatusTest.php` (15-64) | **Gap / dropped from this test-only slice:** no `/auth/status` bool-only endpoint or focus/visibility cross-tab logout script exists. A stale tab is not covered by token-store rotation. Do not expand a test-port into this new feature implicitly. |
| `Feature/Auth/ExpiredSessionWriteTest.php` (77-128) | **Gap / deferred to write-surface acceptance:** durable expiry notice, OAuth return destination and one-shot banner are not implemented here. This legacy test explicitly does not promise input repopulation. DB expiry/guest rendering proves only authentication rejection, not write recovery. |

## Adjacent file slices (not silently omitted)

| Legacy test file | Disposition |
|---|---|
| `Unit/ProductionRouteAllowlistTest.php` (138-156) | QA exclusion is adapted in `test/auth-acceptance.test.ts`; whole-app Laravel route snapshot is dropped from this auth slice. |
| `Feature/TrustedHostsTest.php` (13-63) | Configured callback origin and safe invite are covered. Actual foreign-Host refusal is deferred to W16 (`docs/parity.md:141`), not a PASS here. PHP proxy/password-reset assertions are dropped; no Next password-reset surface exists. |
| `Feature/Throttling/ThrottleEnvelopeTest.php` (15-50,100) | Join429 budget/Retry-After covered by `test/join.test.ts`. Full human-route envelope and browser parity defer to [TOG-9897](/TOG/issues/TOG-9897). |
| `Feature/Throttling/ThrottleCoverageTest.php` (60-106) | Deferred to [TOG-9897](/TOG/issues/TOG-9897). Laravel middleware introspection is dropped, but audit-every-POST intent is retained. |
| `Feature/Livewire/MemberProfileTest.php` (841-917 only) | Session-loss form-preservation/banner/reset behavior belongs to W7/W10 profile-island acceptance, not the session-store contract. `test/islands-member-profile.test.ts` does not establish all of these legacy expired-save expectations. Livewire property/event APIs are dropped, user behavior is a gap if absent. |
| `Feature/Livewire/RsvpButtonTest.php` (461-508 only) | Expired RSVP/withdrawal/accessible-login UX belongs to W9/W10 RSVP acceptance. Existing skipped rows in `test/islands-rsvp-button.test.ts` are not counted as passing; Livewire/419 transport implementation is dropped, UX is not waived. |

## Executable must-pass criteria

- **Given** a fresh client, **when** Discord login starts, **then** the configured
  callback URI, `identify guilds.join` scopes and signed ten-minute state appear.
- **Given** missing/forged state, **when** a callback arrives, **then** no Discord
  exchange or member session occurs.
- **Given** a valid callback, **when** Discord answers, **then** a hashed opaque
  session is issued and member/moderator flags follow the Next contract.
- **Given** an active session, **when** its page is read, **then** its token is
  rotated and the old cookie is rejected.
- **Given** two reads of one token, **when** rotation competes, **then** exactly
  one replacement is committed (memory and test-container Postgres proof).
- **Given** the refreshed thirty-day boundary, **when** the cookie is reused,
  **then** the request is a guest and no replacement cookie is minted.
- **Given** an active session, **when** same-origin POST logout completes,
  **then** replay cannot authenticate. GET does not revoke; foreign-origin POST
  refuses without altering the row.
- **Given** a safe join return, **when** one-click OAuth succeeds, **then** it
  redirects to that rooted path and clears journey cookies.
- **Given** denied consent or unavailable join, **when** recovery renders,
  **then** a usable invite/retry appears without upstream error echo.
- **Given** a valid QA fixture token on the exact staging APP_URL, **when** POST
  login completes, **then** a normal fixture session is issued without Discord.
- **Given** missing/wrong token, unknown fixture or off-staging APP_URL,
  **when** QA POST is attempted, **then** no session is issued and 404 is returned.

Golden/error/minimum/boundary/concurrency/backward-compatibility and attempt-row
telemetry are covered above. Performance: only a smoke-run duration is reported;
this slice is not a load test. Browser focus/accessibility and staging deployment
are **not verified** by Miniflare HTML/API tests. No staging/production database
is used, including for verification.

## Admission state retention and failure contract

[TOG-10354](/TOG/issues/TOG-10354) adds `web_oauth_journeys` alongside the
runtime session-store DDL. Only SHA-256 state hashes, `auth`/`join` flow,
server expiry and consumption time persist; no code, access token or raw state.
A journey expires ten minutes after server issuance regardless of browser cookie
retention. An atomic conditional UPDATE admits one callback across isolates.
Consumption precedes exchange, terminal-attempt writes and session issuance,
including valid denial and incomplete-code callbacks. Tombstones remain through
expiry. Both starts sweep expired rows opportunistically; idle expired rows can
remain until the next start, but cannot authorize anything before or after GC.
A missing/unavailable admission store never permits an upstream exchange.

Fresh successful authentication atomically inserts the new session and revokes
the supplied signed prior token. Denial/exchange failure does not touch the prior
session. Failed one-click join issues no session; failed ordinary auto-join retains
the recorded Next divergence of an identified non-member session, always with
`member=false, moderator=false`, replacing the prior token. The 30-day rotating
TTL and POST-only QA contract are unchanged. Tests are request/Worker and isolated
Postgres evidence; browser proof, exact-head CI and independent auth/security
review remain required before this implementation is called delivered. Other
mapping gaps and production/cutover holds remain unchanged.

## Reproduce

Install development tools even if the agent environment defaults to omitting dev
packages:

```sh
npm ci --include=dev
npm run typecheck
# Only agent-testdb locally, or the workflow's own Postgres service container:
export DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next_w15_tog10114
npm run db:migrate
npm test -- test/app.test.ts test/auth-acceptance.test.ts test/auth-admission.test.ts test/oauth-journeys.test.ts test/auth-worker.test.ts test/sessions.test.ts test/e2e-db.test.ts test/join.test.ts
```

Use an isolated test-container database; never use a deployment URL.
`test/auth-worker.test.ts` bundles the production Worker entry with only the
session-store test seam. Its Miniflare `outboundService` intercepts all network
calls, validates the Discord request shape, and rejects unmatched requests.
Real persistence is tested separately on agent-testdb. `esbuild` and Miniflare
are explicit dev dependencies at the same versions already locked by Wrangler;
no deployed dependencies or compatibility flags change. The locked Miniflare5
alpha exposes `convertV4MiniflareOptions`; the test uses that supported adapter.

The full suite's existing ten skipped RSVP-island rows remain explicitly
blocked on their W9/W10 implementation, not on database availability. The scoped
W15 suites must have **zero skipped tests with DATABASE_URL set**.
