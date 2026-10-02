# Configuration reference

Source of truth: [`src/env.ts`](../src/env.ts), the Worker entrypoint's `JobsEnv`
contract, and [`wrangler.jsonc`](../wrangler.jsonc). This is a configuration
reference, not a deployment, credential-provisioning or operational runbook.
Only secret **names** are documented; never copy secret values into this file,
PRs, logs or command arguments.

## Environment model

- **dev:** local Wrangler plus untracked `.dev.vars`; SQL tests use only
  `agent-testdb`, database `two_web_next`, user `agent_test`, empty password.
  CI uses its disposable Postgres service. Never test/probe/verify production
  or staging databases. On a credential failure, stop without substitution.
- **staging:** the checked-in **top-level** Worker configuration points at
  `next.togetherweown.com`. The GitHub Environment `staging` is a deployment
  gate, not a Wrangler named environment. Worker name is `two-web-next`;
  Hyperdrive's resource name is not a Worker selector or isolation guarantee.
- **prod (planned):** configuration requirements below describe intended use at
  cutover, not existing deployment evidence or permission to deploy. There are
  currently **no `env.staging` or `env.production` blocks** and no production
  deployment job. Do not infer isolation from a var's name or these labels.

`dev/staging/prod` in the table means the setting is applicable in each, with
production still planned. Optional settings are not supplied by Wrangler unless
stated. Required TypeScript fields do **not** imply runtime startup validation;
the application has no central validator. Absence and connection/API failure
are separate cases, and there is no credential failover after an error.

## Checked Worker inventory

The marked table is machine-checked. Keep exactly one row for each distinct
`Env`/`JobsEnv` key, including inherited `AgentEventsEnv` fields. Default means
an actual code fallback or a checked-in Wrangler value, not a recommended value.

<!-- config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
| `APP_URL` | Public var, required | dev/staging/prod | Main Wrangler: `https://next.togetherweown.com`; local config: `http://localhost:8787`; no code fallback | Used for callback/canonical URLs, exact Origin checks, and the TrustHosts request-host allowlist: only this hostname is admitted, others get the branded DB-free 404. Bad configuration can break those paths; invalid/nonproduction origins are noindexed. |
| `ASSETS` | Optional Fetcher binding | dev/staging/prod | Main Wrangler and local config: `ASSETS` bound to `./public` with `run_worker_first` | Static requests pass the Worker host guard before any asset lookup (`run_worker_first`). The guarded 404 fallback serves admitted GET/HEAD misses from `ASSETS`; refused hosts get the branded DB-free 404 with no asset read. Where unbound, the fallback skips the lookup and keeps the branded 404. |
| `DISCORD_CLIENT_ID` | Public var, required | dev/staging/prod | Main Wrangler: configured Owen application ID; local config: blank; no code fallback | Missing/wrong ID breaks OAuth exchange: ordinary login redirects with `signin_failed`; join shows recovery (503). |
| `DISCORD_GUILD_ID` | Public var, required | dev/staging/prod | Main Wrangler: configured TWO guild ID (production guild, even on the staging web host); local config: blank | Invalid snowflake hides the join widget; auto-join/lookup failures deny member/moderator status without blocking ordinary sign-in. Scheduled-event reads degrade. |
| `DISCORD_INVITE_URL` | Public var, required | dev/staging/prod | Main Wrangler and invite helper: configured WEB-HOMEPAGE campaign invite; local config: blank (helper uses fallback) | `/discord` and join recovery reject non-HTTPS/non-Discord URLs, warn and use the built-in invite. Other rendered links use the raw setting; validation is not universal. |
| `RULES_LAST_UPDATED` | Optional public var (`YYYY-MM-DD`) | dev/staging/prod | Unset; no stamp | Empty hides the stamp; invalid syntax or impossible month/day combinations warn and hide it. Checks month lengths and Gregorian leap years while preserving four-digit year strings. |
| `DB` | Optional Hyperdrive binding | dev: omitted in local config; staging/prod: provisioned database binding | Main Wrangler: configured `DB` Hyperdrive binding; local config: unbound | Web falls back to this when the explicit URL is empty/absent. Missing both sources yields guest-only nonpersistent sessions and unavailable DB features. Connection failures do not retry another source. |
| `DISCORD_CLIENT_SECRET` | Secret, required | dev/staging/prod | None | Missing/invalid OAuth credentials fail exchange; ordinary login redirects with `signin_failed`, join shows recovery (503). Absent or empty fails `/up` readiness (503, `config: "missing"`). |
| `DISCORD_BOT_TOKEN` | Secret, required | dev/staging/prod | None | Must belong to the client application; the bot must be in the target guild with Create Instant Invite permission for auto-join. Failed auto-join/role lookup denies member/moderator status but ordinary login continues; join offers invite recovery, calendar reads return an error/empty state. Absent or empty fails `/up` readiness (503, `config: "missing"`). |
| `SESSION_SECRET` | Secret, required | dev/staging/prod | None; local example recommends 32+ random bytes | Invalid signatures become guest/failed OAuth state. Absent or empty (including whitespace-only) fails `/up` readiness (503, `config: "missing"`); there is no strength check or graceful configuration fallback, and a missing value can break signing. |
| `DATABASE_URL` | Optional connection string; treat credential-bearing URLs as secrets | dev: test database; staging/prod: optional explicit override, normally use `DB` | None in runtime; local example uses the test container | Normal web selection is explicit URL then `DB`. No source means guest-only sessions, no-op roster persistence and unavailable DB-backed features. Generic human throttles use only this URL and allow requests when missing or failing. Jobs and `/up` use different precedence (below). |
| `DISCORD_MODERATOR_ROLE_IDS` | Optional public var (comma-separated snowflakes) | dev/staging/prod | Main Wrangler: approved SySOp `508654771276873729`; local/unset: blank, no moderators | Only trimmed 10–25 digit role IDs survive parsing. Blank/invalid allowlist or lookup failure gives `moderator=false`; sign-in continues. Deployment preflight requires exactly SySOp from the same top-level source config published by Wrangler; extras fail. This is source policy, not live binding/isolation evidence. |
| `QA_AUTH_TOKEN` | Optional secret | staging only; leave unset in dev/prod | Unset; QA route disabled | QA route requires exact `APP_URL=https://next.togetherweown.com` plus the matching nonempty token. Missing/bad token or unknown identity returns 404. Throttle executes before the gate. |
| `MEMBER_ACCESS_LOG_ENFORCE` | Optional boolean-like var | dev/staging/prod | On | Trimmed, case-insensitive `false`, `0`, `no` disable enforcement; all other values enable it. Failed access-log writes refuse member/admin reads with 503 by default; disabled enforcement logs and serves instead. |
| `CSP_REPORT_SAMPLE_RATE` | Optional numeric var | dev/staging/prod | `1.0` | Absent/nonfinite values fall back to 1; parsed values clamp to 0–1 (`parseFloat` accepts numeric prefixes). Changes logging only; report sink remains 204. |
| `BOT_ENDPOINT_URL` | Optional signed bot base URL | dev: stub only; staging: provision separately; prod: no new access implied | None | Missing/non-HTTPS URL fails read observation closed to `bot_unreachable`; redirects are refused. |
| `BOT_KEY_ID` | Optional bot signing key identifier | dev/staging/prod | None | Missing ID fails observation closed; no implicit production key selection. |
| `BOT_SHARED_SECRET` | Optional signing secret | dev: fixture value; staging/prod: separately authorized secret binding | None | Missing/invalid secret fails observation closed. Never logged or substituted; one attempt, 2.5 s deadline. |
| `FEATURED_IMAGE_HOSTS` | Optional public var (comma-separated exact DNS hosts) | dev/staging/prod | Main Wrangler: blank; Discord CDN always allowed | Additional approved HTTPS image hosts (e.g. `images.unsplash.com`), shared by admin validation, rendering and CSP. Invalid, IP/private/reserved names are ignored; no wildcard or subdomain expansion. Unapproved remote images are rejected on writes and suppressed on reads. See [image policy](../README.md#image-and-frame-policy). |
| `AGENT_DB` | Optional connection-string binding | dev: test injection; staging/prod: leave unbound so ingress shares the public events database | Unbound in Wrangler; falls back to the shared web database (`DATABASE_URL`, then `DB`) | When bound it overrides the shared database for ingress only (grants/audits/replays and events must then live there). Unbound with no shared database returns 503 `ingress_unavailable`; DB execution failures return 500 and never fail over. |
| `AGENT_EVENTS_ENABLED` | Optional flag var | dev/staging: opt-in; prod: keep disabled pending separate authorization | Off | Only exact `true` or `1` enables ingress; otherwise 404 `ingress_disabled`. |
| `AGENT_EVENTS_CALLER_AGENT_ID` | Optional caller allowlist var | dev/staging: admitted caller; prod: no production grant implied | Empty; nobody admitted | Unset/wrong caller denies grants with 403 `wrong_caller`. |
| `AGENT_EVENTS_GUILD_ID` | Optional admitted guild var | dev/staging: staging guild; prod: no production grant implied | Code: staging guild `1545644954272137297` when absent/empty | A grant for another guild is denied with 403. Independent of web `DISCORD_GUILD_ID`. |
| `AGENT_EVENTS_PRODUCTION_GUILD_ID` | Optional production-audience identifier var | dev/staging/prod | Code: production guild `326474832151838730` when absent/empty | Labels denied production-audience grants `production_guild`; does not enable production ingress. |
| `AGENT_EVENTS_ROUTE_PER_MINUTE` | Optional positive-integer var | dev/staging/prod | `60` | Invalid/nonpositive values use 60; outer shield over budget returns 429 with Retry-After. |
| `SYNC_EVENT_QUEUE` | Required Queue producer binding (`JobsEnv`) | dev: local Queue; staging/prod: provisioned Queue | Main Wrangler: `two-sync-event`; local config: `two-sync-event-local` | Scheduler uses this for tracked reconciliation sends; no in-memory production fallback. Missing/failing queue prevents sends. Bot/event adapters remain reject-all stubs, not live parity. |
| `INTERNAL_ACTION_QUEUE` | Required Queue producer binding (`JobsEnv`) | dev: local Queue; staging/prod: provisioned Queue | Main Wrangler: `two-internal-action`; local config: `two-internal-action-local` | Declared/configured but no consumer reads this producer property in current source; both configured queue consumers share the Worker dispatch path. No application-side default. |
| `HYPERDRIVE` | Optional Hyperdrive legacy alias (`JobsEnv`) | dev/staging/prod | Unbound in Wrangler | Jobs prefer this over `DB`, then the explicit URL. With no usable database source, job DB selection throws. No retry fallback after a connection error. |
<!-- config-docs:end -->

### Connection selection is not uniform

Do not assume setting `DATABASE_URL` overrides every binding:

| Consumer | Selection order | Source |
| --- | --- | --- |
| Normal web reads, admin, roster and sessions | Nonempty `DATABASE_URL`, then `DB.connectionString` | [`src/db/connection.ts`](../src/db/connection.ts) |
| Queue/scheduled jobs | `HYPERDRIVE`, then `DB`, then `DATABASE_URL` (nullish selection) | [`src/jobs/worker.ts`](../src/jobs/worker.ts) |
| `/up` queue-depth read | `DB.connectionString`, then `DATABASE_URL` | [`src/index.tsx`](../src/index.tsx) |
| Generic human-route throttle | `DATABASE_URL` only; fail-open on missing/erroring store | [`src/throttle.ts`](../src/throttle.ts) |
| Agent-event ingress | `AGENT_DB` when bound, otherwise nonempty `DATABASE_URL`, then `DB.connectionString` (same as public events) | [`src/agent-events/route.ts`](../src/agent-events/route.ts) |

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
[`src/agent-events/service.ts`](../src/agent-events/service.ts).

## Settings outside the checked Worker contract

These names are deliberately **not** extra rows in the marked inventory:

- **Unbound event write-back carrier:** `EVENT_SYNC_QUEUE` is an optional
  `SyncQueue` extension in [`src/events/sync.ts`](../src/events/sync.ts), present
  only in Wrangler comments, not an actual binding. It uses a different message
  shape from `SYNC_EVENT_QUEUE`. Missing binding warns; send failures log without
  throwing. If it becomes a deployed binding, add it to `src/env.ts` and the
  checked inventory in the same change.
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
- **Alerts:** [`src/alerts.ts`](../src/alerts.ts) uses a fixed five-minute
  per-isolate rate window. There are no alert environment variables in the
  current Worker contract. Do not invent settings from proposed work.
- **CI/tooling secrets:** deployment uses `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; backup automation additionally references
  `NEON_STAGING_DATABASE_URL`. These are workflow inputs, not Worker bindings,
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
from `wrangler.jsonc` and `wrangler.local.jsonc`, including named-environment
overrides if added. Binding declarations include name-based Durable Objects,
email and rate limits; nested JSON var data is not a declaration. It rejects:

- Missing documentation for any required **or optional** property.
- A marked-table key no longer present in `Env`/`JobsEnv`.
- An actual Wrangler var/binding absent from the types or documentation.
- Duplicate rows, blank metadata, malformed/absent inventory markers or invalid
  source/config input. Mentions in prose and commented-out bindings do not count.

The companion selftest covers inherited/optional/job keys, comments, nested
fields, JSONC strings/trailing commas, scoped Wrangler keys and both directions
of drift using local fixtures only. `npm run check` includes both commands, so
CI's required `check` job executes them before Vitest. This check proves names
and row completeness, not the semantic correctness of descriptions or live
provider configuration; reviewers must verify those against source.
