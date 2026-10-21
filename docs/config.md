# Configuration reference

Source of truth: [`src/env.ts`](../src/env.ts), the Worker entrypoint's `JobsEnv`
contract, [`wrangler.jsonc`](../wrangler.jsonc), and the reviewed Kit staging
configuration [`web/wrangler.staging.jsonc`](../web/wrangler.staging.jsonc). This
is a configuration reference, not a deployment, credential-provisioning or
operational runbook.
Only secret **names** are documented; never copy secret values into this file,
PRs, logs or command arguments.

## Environment model

- **dev:** local Wrangler plus untracked `.dev.vars`; SQL tests use the central
  `testDatabaseUrl` guard: `agent-testdb:5432` with user `agent_test`, an empty
  password, and database `postgres`, `two_web_next`, `w15_tests`, or numeric
  `two_web_next_tog<digits>`. Arbitrary database names are refused. The disposable
  CI Postgres service is accepted only with both CI flags set to `true` and its
  `localhost:5432/postgres` coordinates plus `postgres:ci` credentials. Full
  local checks use a fresh run-owned database, not shared `two_web_next`. Never
  test/probe/verify production or staging databases. On a credential failure, stop
  without substitution.
- **staging:** the reviewed Kit Worker configuration is
  [`web/wrangler.staging.jsonc`](../web/wrangler.staging.jsonc); it points at
  `next.togetherweown.com` and defaults both Kit route families to Hono. The
  `deploy.yml` workflow's automatic main-CI path resets both families to Hono;
  a `workflow_dispatch` on `main` selects `hono`, `archive`, or cumulative
  `archive-static`. The GitHub Environment `staging` supplies deployment-scoped
  values; it is not a human approval gate or Wrangler named environment. Worker
  name is `two-web-next`; Hyperdrive's resource name is not a Worker selector
  or isolation guarantee. `wrangler.jsonc` remains the Hono config and
  production cutover template.
- **prod (cutover template, not live):** [`wrangler.jsonc`](../wrangler.jsonc)
  declares a named **`env.production`** block (isolated Worker name, apex
  route, queues, Hyperdrive binding and explicit vars; bindings and vars are
  not inherited), and
  [`.github/workflows/deploy-production.yml`](../.github/workflows/deploy-production.yml)
  promotes automatically on `e2e-staging` completion plus a daily schedule
  backstop (keeping manual dispatch), gated by
  `PRODUCTION_DEPLOY_ENABLED`, the live `production` Environment's protection,
  exact-SHA CI and the Hyperdrive sentinel check, with a 30-minute staging
  soak, already-live skip, pending-migration stop and `PRODUCTION_HOLD_UNTIL`. By default, protection requires
  reviewers with self-review prevented; with `PRODUCTION_AUTO_APPROVE=true`, the
  gate instead requires a main-only deployment policy and successful staging
  deploy and `e2e-staging` runs on the same SHA, with an executed, passing
  `staging-quality` job. Neither the checked-in template nor the workflow
  is permission to deploy: production deployment, DNS and database/queue
  provisioning stay separately gated until cutover authorization. There is no
  `env.staging` block. Do not infer isolation from a var's name or these labels.

`dev/staging/prod` in the table means the setting is applicable in each, with
production still planned. Optional settings are not supplied by Wrangler unless
stated. Required TypeScript fields do **not** imply runtime startup validation;
there is no central startup validator; `/up` readiness is the gate (absent
secrets fail `config: "missing"`, a weak `SESSION_SECRET` fails
`config: "weak"`). Absence and connection/API failure
are separate cases, and there is no credential failover after an error.

## Checked Worker inventory

The marked table is machine-checked. Keep exactly one row for each distinct
`Env`/`JobsEnv` key, including inherited `AgentEventsEnv` fields. Default means
an actual code fallback or a checked-in Wrangler value, not a recommended value.

<!-- config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
| `APP_URL` | Public var, required | dev/staging/prod | Main and Kit staging Wrangler: `https://next.togetherweown.com`; local config: `http://localhost:8787`; no code fallback | Used for callback/canonical URLs, exact Origin checks, and the TrustHosts request-host allowlist: only this hostname is admitted, others get the branded DB-free 404. Bad configuration can break those paths; invalid/nonproduction origins are noindexed. |
| `ASSETS` | Optional Fetcher binding | dev/staging/prod | Hono main/local Wrangler: `ASSETS` bound to `./public`; Kit staging config: `.svelte-kit/cloudflare`; both use `run_worker_first` | Static requests pass the Worker host guard before any asset lookup (`run_worker_first`). Hono's guarded 404 fallback serves admitted GET/HEAD misses from `ASSETS`; the Kit adapter admits its generated assets. Refused hosts get the branded DB-free 404 with no asset read. Where unbound, Hono skips the lookup and keeps the branded 404. |
| `CF_VERSION_METADATA` | Optional Worker Version Metadata binding | staging + production | Kit staging config: `version_metadata` binding `CF_VERSION_METADATA`; root Wrangler also declares it at top level and in `env.production` (bindings are not inherited); jobs Wrangler declares it at top level; never in local config | Absent binding, or one without a string `id`, leaves `/up` unchanged (no `revision` key) and structured log lines carry `build_sha`/`release: null`. When present, `/up` adds `revision: { version_id, commit }`: the Worker Version ID that `wrangler rollback` takes, and the deploy commit parsed from the version tag (a full lowercase 40-hex SHA, or the first component of production's `<sha>-<run-id>-<attempt>` tag), else `null`; the same parsed commit tags every structured log line. Informational: it never changes the HTTP status. |
| `DISCORD_CLIENT_ID` | Public var, required | dev/staging/prod | Main and Kit staging Wrangler: configured Owen application ID; local config: blank; no code fallback | Missing/wrong ID breaks OAuth exchange: ordinary login redirects with `signin_failed`; join shows recovery (503). |
| `DISCORD_GUILD_ID` | Public var, required | dev/staging/prod | Main and Kit staging Wrangler top level (staging guild `1545644954272137297`): staging guild; env.production (guild `326474832151838730`): production guild; local config: blank | Invalid snowflake hides the join widget; auto-join/lookup failures deny member/moderator status without blocking ordinary sign-in. Scheduled-event reads degrade. |
| `DISCORD_INVITE_URL` | Public var, required | dev/staging/prod | Main and Kit staging Wrangler and invite helper: configured WEB-HOMEPAGE campaign invite; local config: blank (helper uses fallback) | `/discord` and join recovery reject non-HTTPS/non-Discord URLs, warn and use the built-in invite. Other rendered links use the raw setting; validation is not universal. |
| `RULES_LAST_UPDATED` | Optional public var (`YYYY-MM-DD`) | dev/staging/prod | Unset; no stamp | Empty hides the stamp; invalid syntax or impossible month/day combinations warn and hide it. Checks month lengths and Gregorian leap years while preserving four-digit year strings. |
| `DB` | Optional Hyperdrive binding | dev: omitted in local config; staging/prod: provisioned database binding | Main and Kit staging Wrangler: configured `DB` Hyperdrive binding; local config: unbound | Web falls back to this when the explicit URL is empty/absent. Missing both sources yields guest-only nonpersistent sessions and unavailable DB features. Connection failures do not retry another source. |
| `DISCORD_CLIENT_SECRET` | Secret, required | dev/staging/prod | None | Missing/invalid OAuth credentials fail exchange; ordinary login redirects with `signin_failed`, join shows recovery (503). Absent or empty fails `/up` readiness (503, `config: "missing"`). |
| `DISCORD_BOT_TOKEN` | Secret, required | dev/staging/prod | None | Must belong to the client application; the bot must be in the target guild with Create Instant Invite permission for auto-join. Failed auto-join/role lookup denies member/moderator status but ordinary login continues; join offers invite recovery, calendar reads return an error/empty state. Absent or empty fails `/up` readiness (503, `config: "missing"`). |
| `SESSION_SECRET` | Secret, required | dev/staging/prod | None; local example recommends 32+ random bytes | Invalid signatures become guest/failed OAuth state. Absent or empty (including whitespace-only) fails `/up` readiness (503, `config: "missing"`). A configured value under 32 characters or with leading/trailing whitespace fails readiness too (503, `config: "weak"`); the body names neither the secret nor its value, and the server log names the secret and the requirement, never the value. There is no graceful configuration fallback, and a missing value can break signing. See [strength and rotation](#session_secret-strength-and-rotation). |
| `DATABASE_URL` | Optional connection string; treat credential-bearing URLs as secrets | dev: test database; staging/prod: optional explicit override, normally use `DB` | None in runtime; local example uses the test container | Normal web selection is explicit URL then `DB`. No source means guest-only sessions, no-op roster persistence and unavailable DB-backed features. Generic human throttles use the same selection (nonempty explicit URL, then `DB`); with neither source configured they allow the request, and a selected store that fails to connect or errors also allows it — the other source is never retried after that failure. Web producers, jobs and `/up` share explicit URL then `DB` selection, with jobs accepting the legacy alias last (below). |
| `BOT_DB` | Optional Hyperdrive binding | dev: unset (use `BOT_DATABASE_URL`); staging/prod: bot-reader Hyperdrive binding | Unbound; staging/prod bindings land with the bot-reader wiring | Homepage counts and profile stats read the bot-owned `web_v1` views through this binding (read-only `two_web_reader` grant). Missing both bot sources hides the counts and the stats block; the web `DB` is never read for them. Connection failures do not retry another source. |
| `BOT_DATABASE_URL` | Optional connection string; treat credential-bearing URLs as secrets | dev: test database carrying `web_v1`; staging/prod: optional explicit override, normally use `BOT_DB` | None in runtime | Counts and profile-stats selection is explicit URL then `BOT_DB`. No bot source means hidden counts and hidden stats block. Never point tests or local runs at a production or staging bot database. |
| `DISCORD_MODERATOR_ROLE_IDS` | Optional public var (comma-separated snowflakes) | dev/staging/prod | Main and Kit staging Wrangler top level (staging guild `1545644954272137297`): staging Owner+Moderator pair `1546211363578191873,1545648550329851946`; env.production (guild `326474832151838730`): production pair `1546777855801954408,1546777856984481792`; local/unset: blank, no moderators | Only trimmed 10–25 digit role IDs survive parsing. Blank/invalid allowlist or lookup failure gives `moderator=false`; sign-in continues. Deployment preflight requires exactly the guild-bound Owner+Moderator pair from the same source config published by Wrangler: each environment's pair must belong to the guild it queries, so a production pair in the staging config (or vice versa) fails. Role IDs are guild-scoped and the two pairs are unrelated — never copy one guild's IDs into the other. This is source policy, not live binding/isolation evidence. |
| `QA_AUTH_TOKEN` | Optional secret | staging only; leave unset in dev/prod | Unset; QA route disabled | QA route requires exact `APP_URL=https://next.togetherweown.com` plus the matching nonempty token. Missing/bad token or unknown identity returns 404. Throttle executes before the gate. |
| `QUEUE_RECONCILE_PREVIEW_ENABLED` | Optional operational flag var | staging only; leave unset elsewhere | Unset; disabled | Only exact `true`, exact staging `APP_URL`, and a valid non-QA operator ID admit the read-only preview namespace; otherwise DB-free 404. No Worker config sets this flag. Activation requires independent security review and separate authorization. |
| `QUEUE_RECONCILE_OPERATOR_ID` | Optional operational principal var (Discord snowflake) | staging only; no grant provisioned | Unset; nobody admitted | Exactly one 10–25 digit non-QA identity, plus the live session moderator bit, is required. Invalid/missing configuration disables previews; any other actor gets 403. QA tokens do not grant operational authority. |
| `SOURCE_EVIDENCE_VERIFIER_ENABLED` | Optional evidence-verifier flag var (runtime-only, never Worker config) | staging only; leave unset elsewhere | Unset; verifier inert | Only exact `true` with exact staging `APP_URL` admits the evidence path; otherwise DB-free 404. Provisioning requires separate execution authorization; teardown removes it. |
| `SOURCE_EVIDENCE_VERIFIER_TOKEN` | Evidence-verifier one-time bearer secret (runtime-only, never Worker config) | staging only; no grant provisioned | Unset; verifier inert | At least 32 characters, compared timing-safe against the `Authorization` header. Missing/short/mismatched token gets 403 without a source read. |
| `SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID` | Evidence-verifier authorized incident var (runtime-only, never Worker config) | staging only; no grant provisioned | Unset; verifier inert | Canonical positive ID only, and the request path ID must equal it. Unparseable/mismatched ID gets 403 (non-canonical path IDs get 422) without a source read. |
| `SOURCE_EVIDENCE_VERIFIER_ISSUED_AT` | Evidence-verifier authorization start, epoch ms (runtime-only, never Worker config) | staging only; no grant provisioned | Unset; verifier inert | With the expiry instant it pins an issued-to-expiry window of at most one hour containing now; otherwise 403 without a source read. |
| `SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT` | Evidence-verifier authorization end, epoch ms (runtime-only, never Worker config) | staging only; no grant provisioned | Unset; verifier inert | Must be after now and within the one-hour window from the issued instant; otherwise 403 without a source read. |
| `MEMBER_ACCESS_LOG_ENFORCE` | Optional boolean-like var | dev/staging/prod | On | Trimmed, case-insensitive `false`, `0`, `no` disable enforcement; all other values enable it. Failed access-log writes refuse member/admin reads with 503 by default; disabled enforcement logs and serves instead. |
| `CSP_REPORT_SAMPLE_RATE` | Optional numeric var | dev/staging/prod | `1.0` | Absent/nonfinite values fall back to 1; parsed values clamp to 0–1 (`parseFloat` accepts numeric prefixes). Violation sampling precedes the shared per-isolate log budget; setting 1 does not bypass that budget. Report sink remains 204. |
| `BOT_ENDPOINT_URL` | Optional signed bot base URL | dev: stub only; staging: provision separately; prod: no new access implied | None | Missing/non-HTTPS URL fails read observation closed to `bot_unreachable`; redirects are refused. The jobs Worker (`JobsEnv`) uses the same three bindings to send sync/announcement/role jobs; if any is missing the job fails terminally and alerts (`queue.failing`), never acks as success. A URL that is not bare HTTPS (another scheme, embedded credentials, query or fragment, missing host, or unparseable) sends no signed request: the job sees `bot unreachable` and retries as it would for a down bot; a 3xx answer is refused, not followed. |
| `BOT_KEY_ID` | Optional bot signing key identifier | dev/staging/prod | None | Missing ID fails observation closed; no implicit production key selection. |
| `BOT_SHARED_SECRET` | Optional signing secret | dev: fixture value; staging/prod: separately authorized secret binding | None | Missing/invalid secret fails observation closed. Never logged or substituted; one attempt, 2.5 s deadline. |
| `FEATURED_IMAGE_HOSTS` | Optional public var (comma-separated exact DNS hosts) | dev/staging/prod | Main and Kit staging Wrangler: blank; Discord CDN always allowed | Additional approved HTTPS image hosts (e.g. `images.unsplash.com`), shared by admin validation, rendering and CSP. Invalid, IP/private/reserved names are ignored; no wildcard or subdomain expansion. Unapproved remote images are rejected on writes and suppressed on reads. See [image policy](../README.md#image-and-frame-policy). |
| `FREEZE_BANNER_ENABLED` | Optional flag var | dev/staging/prod | Off | Only exact `true` or `1` renders the cutover freeze banner; unset or anything else leaves pages byte-identical. Needs `FREEZE_BANNER_DATES` too — the flag alone never renders. |
| `FREEZE_BANNER_DATES` | Optional public var | dev/staging/prod | Unset; no banner | Human freeze window carried verbatim into the cutover freeze banner (e.g. `12–14 Oct UTC`). HTML-escaped before render; blank means no banner even when the flag is on. |
| `KIT_PARITY_FIXTURE_EVENT_DETAIL` | Optional flag var (runtime-only, never Worker config) | local Kit parity fixture only; leave unset in dev/staging/prod | Unset; the shipped manifest keeps the live event detail (GET /e/:key) on Hono | Only exact `true` on a generated worker whose `APP_URL` is an http loopback enables the detail in the fixture manifest (`fixtureManifestFor`); any other value or a non-loopback/deployed `APP_URL` leaves the shipped manifest untouched. Enabling the shipped entry is the separate RSVP-companion rollout. |
| `KIT_PARITY_FIXTURE_MEMBER_BOARD` | Optional flag var (runtime-only, never Worker config) | local Kit parity fixture only; leave unset in dev/staging/prod | Unset; the shipped manifest owns the member board on Kit (the fixture flag is redundant for this entry) | Only exact `true` on a generated worker whose `APP_URL` is an http loopback enables the board in the fixture manifest (`fixtureManifestFor`); any other value or a non-loopback/deployed `APP_URL` leaves the shipped manifest untouched. Returning the shipped entry to `enabled: false` restores Hono ownership as the rollback. |
| `WEBMCP_PILOT_ENABLED` | Optional flag var | dev/staging: opt-in; prod: keep disabled pending separate authorization | Off | Only exact `true` or `1` injects the model-context island on the four pilot pages (`/`, `/events`, `/e/:key`, `/join`); unset or anything else leaves pages byte-identical. Reads no session, cookie or database, so it adds no session-dependent markup of its own: every viewer gets the same island. |
| `E2E_PUBLIC_READ_BUDGET` | Optional positive-integer var (CI loopback workers only) | `e2e/wrangler.jsonc` and the generated Kit fixture (`ci/kit-worker-dev.mjs`) only; leave unset in dev/staging/prod | `60` | Absent/invalid/nonpositive values keep the production 60; both loopback workers set `600` so the sequential suites stop tripping the shared off-edge `anon` bucket. No deployed config sets this var. |
| `AGENT_DB` | Optional connection-string binding | dev: test injection; staging/prod: leave unbound so ingress shares the public events database | Unbound in Wrangler; falls back to the shared web database (`DATABASE_URL`, then `DB`) | When bound it overrides the shared database for ingress only (grants/audits/replays and events must then live there). Unbound with no shared database returns 503 `ingress_unavailable`; DB execution failures return 500 and never fail over. |
| `AGENT_EVENTS_ENABLED` | Optional flag var | dev/staging: opt-in; prod: keep disabled pending separate authorization | Off | Only exact `true` or `1` enables ingress; otherwise 404 `ingress_disabled`. |
| `AGENT_EVENTS_CALLER_AGENT_ID` | Optional caller allowlist var | dev/staging: admitted caller; prod: no production grant implied | Empty; nobody admitted | Unset/wrong caller denies grants with 403 `wrong_caller`. |
| `AGENT_EVENTS_GUILD_ID` | Optional admitted guild var | dev/staging: staging guild; prod: no production grant implied | Code: staging guild `1545644954272137297` when absent/empty | A grant for another guild is denied with 403. Independent of web `DISCORD_GUILD_ID`. |
| `AGENT_EVENTS_PRODUCTION_GUILD_ID` | Optional production-audience identifier var | dev/staging/prod | Code: production guild `326474832151838730` when absent/empty | Labels denied production-audience grants `production_guild`; does not enable production ingress. |
| `AGENT_EVENTS_ROUTE_PER_MINUTE` | Optional positive-integer var | dev/staging/prod | `60` | Invalid/nonpositive values use 60; outer shield over budget returns 429 with Retry-After. |
| `SYNC_EVENT_QUEUE` | Required Queue producer binding (`JobsEnv`) | dev: local Queue; staging/prod: provisioned Queue | Main Wrangler: `two-sync-event`; local config: `two-sync-event-local` | Admin/JSON event and RSVP writes plus reconciliation use tracked sends with a unique lock and 10-second debounce; no in-memory production fallback. Missing/failing queue prevents sends; committed dirty revisions remain recoverable. The event store is wired; the bot HTTP adapter still rejects as unwired, not live Discord parity. |
| `INTERNAL_ACTION_QUEUE` | Required Queue producer binding (`JobsEnv`) | dev: local Queue; staging/prod: provisioned Queue | Main Wrangler: `two-internal-action`; local config: `two-internal-action-local` | Declared/configured but no consumer reads this producer property in current source; both configured queue consumers share the Worker dispatch path. No application-side default. |
| `HYPERDRIVE` | Optional Hyperdrive legacy alias (`JobsEnv`) | dev/staging/prod | Unbound in Wrangler | Jobs use this only when nonempty `DATABASE_URL` and `DB.connectionString` are both absent/empty. With no usable database source, job DB selection throws. No retry fallback after a connection error. |
| `KIT_ROUTE_ARCHIVE` | Optional staging route-rollout var | staging only; leave unset in dev/prod | `web/wrangler.staging.jsonc`: `false`; missing or any other value defaults to Hono | Only exact `true` enables Kit for `GET /events/past`. All other routes and methods stay Hono-owned. Automatic main-CI deploys select Hono; a reviewed `workflow_dispatch` may opt into `archive`. |
| `KIT_ROUTE_STATIC` | Optional staging route-rollout var | staging only; leave unset in dev/prod | `web/wrangler.staging.jsonc`: `false`; missing or any other value defaults to Hono | Only exact `true` together with `KIT_ROUTE_ARCHIVE=true` enables Kit for `GET /about` and `GET /faq`; static cannot precede archive. Automatic main-CI deploys select Hono; `archive-static` is cumulative. |
<!-- config-docs:end -->

### `SESSION_SECRET` strength and rotation

The floor is **at least 32 characters as configured, with no leading or
trailing whitespace** (enforced by `/up` readiness, implemented in
[`src/up-config.ts`](../src/up-config.ts)). Generate with 32+ random bytes,
for example `openssl rand -base64 48` (64 characters), `openssl rand -base64
32` (44 characters with padding), or `openssl rand -hex 32` (64 characters).
Length is the floor for randomly generated secrets; no entropy estimator
runs. Only secret **names** appear in this file, PRs, logs and command
arguments; never paste a value.

Rotate without downtime:

1. Generate the replacement secret on the operator machine.
2. Install it with `wrangler secret put SESSION_SECRET` on the target
   Worker (staging first, production only under its own authorization).
   Both the old and the replacement satisfy the floor, so `/up` stays
   ready throughout the swap.
3. Confirm `GET /up` answers 200 with no `config` key before and after.
4. Sessions signed under the previous secret stop verifying and degrade
   to guest state; affected members simply sign in again via Discord
   OAuth. There is no dual-secret overlap (session-format changes are
   out of scope), so prefer low-traffic windows. No data migration runs.
5. Confirm no log line carries a value: readiness diagnostics name the
   secret and the requirement, never the value.

## Tail Worker inventory

The Tail pager returns silently when its optional configuration is absent,
so this marked table is machine-checked separately from the app inventory.
Keep exactly one row for each Tail `TailEnv` key, Tail Wrangler var, Tail
worker service name, app `tail_consumers` service and accepted app script
name. Secret names only, never values. Named Tail environments are listed
explicitly because Wrangler never inherits top-level vars (or
`tail_consumers`) into a named environment.

<!-- tail-config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
| `UPTIME_URL` | Optional public var (Tail) | tail staging/prod (top-level + `env.production`, not inherited) | Tail config staging: `https://next.togetherweown.com/up`; production: `https://togetherweown.com/up` | Unset `UPTIME_URL` makes `scheduled()` return early with no probing work at all. A missing production row silently leaves the production prober with nothing to probe. |
| `OPS_ALERT_WEBHOOK_URL` | Optional secret (Tail; name only) | tail staging/prod (installed separately per environment) | None; install with `wrangler secret put` on the Tail Worker, never in a file | Missing/invalid webhook makes both `tail()` and `scheduled()` return early with no parsing, logging or outbound work. A missing production binding deploys successfully but pages nothing. |
| `ALERT_AGGREGATOR` | Optional Durable Object binding (Tail) | tail staging/prod (top-level + `env.production`, not inherited) | Tail config `AlertAggregator` class, migration tag `v1` (`new_sqlite_classes`) in both environments | Missing/failing binding falls back to per-isolate aggregate counts and health windows: spikes across isolates may page late or not at all, but per-fingerprint paging is unaffected. A missing production block silently leaves production aggregation per-isolate. |
| `two-web-next-alerts` | Tail worker name / app `tail_consumers` service | tail staging | Tail config name `two-web-next-alerts`; Kit staging config and jobs config each declare `tail_consumers` service `two-web-next-alerts` | A missing or mismatched staging consumer detaches the Tail pager: app deploys may fail on a missing target, or staging traces never reach the pager. |
| `two-web-next-alerts-production` | Tail worker name / app `tail_consumers` service | tail production | Tail `env.production` name `two-web-next-alerts-production`; app `env.production` `tail_consumers` service `two-web-next-alerts-production` | A missing or mismatched production consumer silently leaves production traces unpaged; `tail_consumers` are not inherited from the top level. |
| `two-web-next` | App script name accepted by Tail (`APP_SCRIPT_NAMES`) | app staging web (Tail accepts) | Tail `APP_SCRIPT_NAMES` includes `two-web-next` | Traces from an undocumented script name are ignored by `tail()`; paging for that Worker is silently disabled. Never match by prefix. |
| `two-web-next-production` | App script name accepted by Tail (`APP_SCRIPT_NAMES`) | app production (Tail accepts) | Tail `APP_SCRIPT_NAMES` includes `two-web-next-production` | Production traces arrive under the production app name; without this exact entry production pages are silently ignored. |
| `two-web-jobs` | App script name accepted by Tail (`APP_SCRIPT_NAMES`) | app staging jobs (Tail accepts) | Tail `APP_SCRIPT_NAMES` includes `two-web-jobs`; jobs top-level `tail_consumers` service `two-web-next-alerts` | Jobs traces arrive under the jobs app name; without this exact entry staging queue/cron failures page nothing. Never match by prefix. |
<!-- tail-config-docs:end -->

### CSP report log budget

`POST /csp-reports` has no session, auth or database dependency. All sink paths
return an empty, no-store `204`, including suppressed logs; there is no `429` or
`Retry-After`. Body size and read deadlines still apply.

One token bucket per Worker isolate permits a burst of 20 warnings and refills
one token every 3 seconds (20 per minute), capped at 20 stored tokens. Valid
violation reports, sampled-in malformed reports, sink-failure diagnostics and
`csp.report.dropped_oversize` warnings share this budget, so no input shape
bypasses the cap. Sampled-out and empty reports do not consume tokens.
Budget-exhausted drops fold into the bounded `csp.report.shed` signal (at most
one warn per refill window): no per-drop warning amplifies a flood. The bucket
stores only two numbers, not IPs or report contents, and uses no database,
network calls or background timers.

`CSP_REPORT_SAMPLE_RATE` remains an additional gate for valid and malformed
reports only. Lower it to reduce ordinary violation and malformed log volume;
`1` includes every valid report **eligible for the bucket**, not every received
report. It cannot bypass the cap. Oversize and sink-failure diagnostics do not
use the sample rate but are capped too.

This is best-effort **per-isolate log suppression**, not a request-rate or
fleet-wide cost guarantee. Isolates refill independently; eviction, restart and
new isolates start with a fresh burst. A flood can spend the shared budget and
hide legitimate CSP warnings. Absence of warnings does not prove absence of
violations. Workers invocation logs and other application log keys are not
limited by this bucket.

### Connection selection is not uniform

Do not assume setting `DATABASE_URL` overrides every binding:

| Consumer | Selection order | Source |
| --- | --- | --- |
| Normal web reads, admin, roster and sessions | Nonempty `DATABASE_URL`, then `DB.connectionString` | [`src/db/connection.ts`](../src/db/connection.ts) |
| Event write-back producer, queue/scheduled jobs | Nonempty `DATABASE_URL`, then `DB.connectionString`, then legacy `HYPERDRIVE.connectionString` | [`src/db/connection.ts`](../src/db/connection.ts), [`src/jobs/worker.ts`](../src/jobs/worker.ts) |
| `/up` DB/schema readiness and queue-depth read | Nonempty `DATABASE_URL`, then `DB.connectionString` (one client for both reads) | [`src/index.tsx`](../src/index.tsx) |
| Generic human-route throttle | Nonempty `DATABASE_URL`, then `DB.connectionString`; fail-open when neither source is configured or the selected store errors, with no retry against the other source | [`src/throttle.ts`](../src/throttle.ts) |
| Agent-event ingress | `AGENT_DB` when bound, otherwise nonempty `DATABASE_URL`, then `DB.connectionString` (same as public events) | [`src/agent-events/route.ts`](../src/agent-events/route.ts) |
| Homepage bot counts and profile stats (`web_v1`) | Nonempty `BOT_DATABASE_URL`, then `BOT_DB.connectionString`; no web-DB fallback (the web database holds no `web_v1` views) | [`src/db/connection.ts`](../src/db/connection.ts), [`src/counts.ts`](../src/counts.ts), [`src/profiles/routes-stores.ts`](../src/profiles/routes-stores.ts) |

Local development must keep **all** supplied bindings test-only, not just the
explicit URL. Tests must never use production/staging connections. No database
URL value or credentials should be logged when troubleshooting configuration.

### Auth and content consumers

Register both `${APP_URL}/auth/discord/callback` **and**
`${APP_URL}/join/callback` on the Discord application. Use the same application
for the public client ID, client secret and bot token.

Failure/default details are implemented in [`src/index.tsx`](../src/index.tsx),
[`src/join/route.ts`](../src/join/route.ts), [`src/invite.ts`](../src/invite.ts),
[`src/roles.ts`](../src/roles.ts), [`src/qa.ts`](../src/qa.ts),
[`src/access-log.ts`](../src/access-log.ts),
[`src/admin/guard.ts`](../src/admin/guard.ts),
[`src/csp-reports.ts`](../src/csp-reports.ts) and
[`src/agent-events/types.ts`](../src/agent-events/types.ts) (defaults) and
[`src/agent-events/ingress.ts`](../src/agent-events/ingress.ts) (admission).

## Settings outside the checked Worker contract

These names are deliberately **not** extra rows in the marked inventory:

- **Local Hyperdrive tooling:**
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` is a Wrangler process
  variable, not a Worker `Env` property. It overrides the local Hyperdrive
  connection, not the remote binding. Miniflare requires a nonempty password,
  so our authorized passwordless test URL does not work with this override.
  Use [`wrangler.local.jsonc`](../wrangler.local.jsonc) and the explicit
  `DATABASE_URL` as shown in the README instead; do not substitute credentials.
  The local config has no Hyperdrive/remote bindings and uses local Queue names.
  Official reference:
  [Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).
- **Probe-only configuration:**
  [`spike/hyperdrive-semantics/wrangler.probe.jsonc`](../spike/hyperdrive-semantics/wrangler.probe.jsonc)
  and its separate probe `Env` have `TEST_DB_CONNECTION_STRING` and `DB`.
  The explicit string wins; missing/nonexact test URL gives 400
  `test_database_required`. This fixture accepts only the separate local
  `agent-testdb` control database, user `agent_test`, empty password. The probe
  is local-only, must not be remotely developed/deployed, and is **not** proof
  of real Hyperdrive pooling. It is not part of the main Worker configuration.
- **Injected test seams:** `SESSION_STORE`, `ROSTER_STORE`, `QUEUE_DEPTH_STORE`,
  `ADMIN_DB`, `AGENT_EVENT_SQL`, `THROTTLE_STORE`, `JOIN_DEPS`, `DISCORD_EVENTS` are in-process
  dependency/store objects, not Wrangler string vars or secrets. They are
  absent from normal deployment configuration; tests inject local fixtures.
- **Alerts (app Worker):** [`src/alerts.ts`](../src/alerts.ts) uses a fixed five-minute
  per-isolate rate window. There are no alert environment variables in the
  app Worker `Env`/`JobsEnv` contract. Do not invent settings from proposed work.
- **Tail Worker settings (separately machine-checked):** the Tail pager names
  live in the Tail Worker inventory above, not in the app table. The separate
  Tail Worker ([`tail/wrangler.jsonc`](../tail/wrangler.jsonc),
  [`tail/worker.ts`](../tail/worker.ts)) reads public var `UPTIME_URL` and
  secret `OPS_ALERT_WEBHOOK_URL` (secret name only, never a value; install
  with `wrangler secret put`, never in a file), attaches via
  `tail_consumers` services and accepts only the listed app script names.
  They are not app `Env`/`JobsEnv` keys. See
  [runbook-alerts](runbook-alerts.md) for the install procedure.
- **CI/tooling secrets:** deployment uses `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; backup automation additionally references
  `PLANETSCALE_STAGING_DATABASE_URL`. These are workflow inputs, not Worker bindings,
  have no default and must not be used as test credentials. Their procedures
  are outside this reference.

Wrangler serves `public/` through `assets.directory` with the named `ASSETS`
binding and `run_worker_first`, so static requests pass the Worker host guard
before any asset lookup. Queue consumer names, cron expressions, the Hyperdrive resource
ID and route configuration are deployment metadata, not additional `Env` keys.

## Drift check and selftest

```sh
npm run config:check
```

[`ci/check-config-docs.mjs`](../ci/check-config-docs.mjs) uses the locked
TypeScript 7 native API to resolve `Env` and `JobsEnv` properties (including
intersections/inheritance) and parses the actual JSONC Wrangler vars/bindings
from `wrangler.jsonc`, `wrangler.local.jsonc` and `wrangler.jobs.jsonc`,
including named-environment overrides if added. It separately resolves Tail
`TailEnv` keys from
`tail/worker.ts`, Tail vars (names only) from `tail/wrangler.jsonc` top level
and named environments without assuming inheritance, Tail worker service names
and app `tail_consumers` services, and accepted app script names
(`APP_SCRIPT_NAMES`) from `tail/worker.ts` against the Tail inventory above.
It does not read `spike/hyperdrive-semantics/wrangler.probe.jsonc`; those
settings stay documented under "Settings outside the checked Worker contract"
above. Binding declarations include name-based Durable Objects,
email and rate limits; nested JSON var data is not a declaration. It rejects:

- Missing documentation for any required **or optional** property.
- A marked-table key no longer present in `Env`/`JobsEnv`.
- An actual Wrangler var/binding absent from the types or documentation.
- A Tail `TailEnv` key, Tail Wrangler var, Tail worker name, app
  `tail_consumers` service or accepted app script name absent from the Tail
  inventory, an obsolete/misspelled Tail row, or an app `tail_consumers`
  service without its Tail worker (either direction silently disables paging).
- Duplicate rows, blank metadata, malformed/absent inventory markers or invalid
  source/config input. Mentions in prose and commented-out bindings do not count.

The companion selftest covers inherited/optional/job keys, comments, nested
fields, JSONC strings/trailing commas, scoped Wrangler keys, synthetic Tail
aliases, top-level/named-environment Tail config and both directions
of drift using local fixtures only. `npm run check` includes both commands, so
CI's `check` job executes them before Vitest. This check proves names
and row completeness, not the semantic correctness of descriptions or live
provider configuration; reviewers must verify those against source.
