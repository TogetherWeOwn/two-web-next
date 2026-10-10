# Architecture overview

The Together We Own website: Hono on Cloudflare Workers, TypeScript,
Drizzle + Postgres, server-rendered HTML with plain JavaScript islands.
This page says how a request flows through the Worker, where background work
runs, who owns which tables, and what each directory is. For setup and daily
commands see the [README](../README.md); for every binding and secret see
the [configuration reference](./config.md); for deploy, rollback and outages
see the [runbook](./runbook.md).

## 1. Request path: Worker entry to routes to the database

Read from: [src/worker.ts](../src/worker.ts),
[src/index.tsx](../src/index.tsx), [src/db/](../src/db/).

The Worker entry ([src/worker.ts](../src/worker.ts)) is three lines of
wiring: `fetch` goes to the Hono app, `queue` and `scheduled` go to the jobs
handlers in [src/jobs/worker.ts](../src/jobs/worker.ts). All HTTP behavior
lives in the Hono app composed in [src/index.tsx](../src/index.tsx).

Global middleware runs in this order for every request
([src/index.tsx](../src/index.tsx)):

1. Request logging plus static security headers and the staging robots tag,
   with handler errors settled to the branded 500 (`app.use`).
2. `trustHosts()`: refuses foreign `Host` values before routing.
3. `sameOrigin`, `authStatusScript`, `expiredWriteBanner`, `freezeBanner`.

Route-scoped middleware applies per route instead: body-size budgets on the
agent-events and logout/QA posts, admission and throttles on the agent
ingress, and the QA gate on the staging-only QA sign-in.

Routes are a mix of direct handlers and mounted sub-apps
([src/index.tsx](../src/index.tsx)): the static leaves (`registerStaticLeaves`),
the policy/SEO leaves (`registerSeoLeaves`: `/privacy`, `/sitemap_index.xml`,
`/robots.txt`, `POST /csp-reports`), the join journey (`registerJoinRoutes`),
`POST /api/agent-events`, the error handlers, `/admin`,
`/` for profiles, event routes, and the alert probe.

There is no global database pool. Each request builds a short-lived client
from `databaseUrl(c.env)` with `databaseOptions`
([src/index.tsx](../src/index.tsx), `storeFor`/`rosterSqlFor`): sessions and
the roster through `src/sessions.ts` and `src/db/roster.ts`, page reads
through [src/db/](../src/db/). Without a configured database the app fails
closed to guest sessions and unavailable DB features rather than crashing.

## 2. Configuration and secrets

Read from: [src/env.ts](../src/env.ts), [wrangler.jsonc](../wrangler.jsonc),
[docs/config.md](./config.md).

This section names no binding values on purpose. The full inventory — every
`Env`/`JobsEnv` key, its kind, its environments, its default, and what breaks
when it is missing — is the machine-checked table in the
[configuration reference](./config.md), generated from
[src/env.ts](../src/env.ts) and [wrangler.jsonc](../wrangler.jsonc) and
checked by `ci/check-config-docs.mjs` (run via `npm run config:check`).
Secrets are set with `wrangler secret put` and never live in the repo; only
secret **names** appear in docs. The three readiness secrets are
`SESSION_SECRET`, `DISCORD_CLIENT_SECRET`, and `DISCORD_BOT_TOKEN`: when any
is absent or empty, `GET /up` answers 503.

## 3. Queue and cron path

Read from: [src/jobs-worker.ts](../src/jobs-worker.ts),
[src/jobs/worker.ts](../src/jobs/worker.ts),
[src/jobs/constants.ts](../src/jobs/constants.ts),
[src/jobs/](../src/jobs/), [wrangler.jsonc](../wrangler.jsonc),
[wrangler.jobs.jsonc](../wrangler.jobs.jsonc).

Two queues, declared in [wrangler.jsonc](../wrangler.jsonc): `two-sync-event`
bound as `SYNC_EVENT_QUEUE` and `two-internal-action` bound as
`INTERNAL_ACTION_QUEUE`, each with a consumer backstop (`max_retries 10`).
The web Worker produces (event writes enqueue a sync message; the alert
probe sends to the internal-action queue) and consumes with the same
`handleQueue`/`handleScheduled` handlers that the jobs-only entry
([src/jobs-worker.ts](../src/jobs-worker.ts)) exports. The jobs-only Worker
(`two-web-jobs`, [wrangler.jobs.jsonc](../wrangler.jobs.jsonc)) currently only
produces; staging keeps consuming in the web Worker until a cutover moves
consumers over, and a queue has exactly one consumer.

Cron triggers in [wrangler.jsonc](../wrangler.jsonc) are `*/10 * * * *` and
`0 0 * * *`, pinned to `RECONCILE_CRON` and `PRUNE_CRON` in
[src/jobs/constants.ts](../src/jobs/constants.ts): every-ten-minutes event
reconciliation and daily model-table pruning, dispatched through
[src/jobs/worker.ts](../src/jobs/worker.ts). Per-call internals of the
reconcile and prune implementations were not line-verified for this page;
read [src/jobs/](../src/jobs/) for the consumer, retry, ledger, redrive, and
replay modules. Missing bot configuration makes bot calls fail as terminal,
alerting job failures, never silent success.

## 4. Tail Worker

Read from: [tail/worker.ts](../tail/worker.ts),
[tail/wrangler.jsonc](../tail/wrangler.jsonc),
[wrangler.jsonc](../wrangler.jsonc).

The Tail Worker in [tail/](../tail/) is the pager and uptime prober. It has
no public route, no database, and no queues of its own. It tails only the
exact app script names `two-web-next` and `two-web-next-production`
([tail/worker.ts](../tail/worker.ts), `APP_SCRIPT_NAMES`), wired via
`tail_consumers` in [wrangler.jsonc](../wrangler.jsonc). It accepts only
allowlisted log lines — `error.alert` on registered routes and
`queue.failing` for known job names — and posts a small allowlisted JSON
summary to the optional ops webhook, muted per isolate for five minutes.
Its cron (`*/5 * * * *` in [tail/wrangler.jsonc](../tail/wrangler.jsonc))
probes the app's `/up` twice per run and pages `uptime.down` only when both
probes fail.

## 5. Data ownership: web-owned tables versus bot-owned views

Read from: [src/db/schema.ts](../src/db/schema.ts),
[src/db/admin-schema.ts](../src/db/admin-schema.ts),
[src/sessions.ts](../src/sessions.ts),
[src/oauth-journeys.ts](../src/oauth-journeys.ts),
[docs/web-v1-contract.md](./web-v1-contract.md).

The web owns and migrates its own tables. In
[src/db/schema.ts](../src/db/schema.ts): `users`, `discord_event_snapshots`,
`join_attempts`, `web_throttle_hits`, `agent_event_grants`,
`agent_event_idempotency_keys`, `agent_event_audits`, `agent_event_hits`,
`profiles`, `job_unique_locks`, `queue_jobs`, `queue_failed_jobs`. In
[src/db/admin-schema.ts](../src/db/admin-schema.ts): `events`,
`eventSyncAttempts`, `featuredContents`, `memberDataAccessLogs`,
`activityLog`, `rsvps`, `eventSearchLogs`. Sessions live in `web_sessions`
and OAuth journey records in `web_oauth_journeys`
([src/sessions.ts](../src/sessions.ts),
[src/oauth-journeys.ts](../src/oauth-journeys.ts)).

The web does **not** own the bot's tables. Homepage counts and ranks come
from the bot-owned read-only views `web_v1.live_counts` and
`web_v1.rank_counts`, consumed frozen-column-only per the
[web-v1 contract](./web-v1-contract.md): single-row live counts with a
10-minute absolute freshness rule and a 60-second cache, ranks ordered by
`rank_order`, failures degrading to hidden counts rather than errors. The
web never migrates bot tables or queries member-level bot data.

## 6. Auth and sessions

Read from: [src/sessions.ts](../src/sessions.ts),
[src/session-revocation.ts](../src/session-revocation.ts),
[bin/revoke-sessions.mjs](../bin/revoke-sessions.mjs),
[src/discord.ts](../src/discord.ts), [src/oauth-journeys.ts](../src/oauth-journeys.ts),
[src/auth-status.ts](../src/auth-status.ts), [src/roles.ts](../src/roles.ts),
[src/qa.ts](../src/qa.ts), [src/index.tsx](../src/index.tsx).

Sign-in is Discord OAuth2 with the `identify` and `guilds.join` scopes
([src/discord.ts](../src/discord.ts)); the access token is used for the join
request and never stored. The session cookie (`__Host-two_session`) carries
only a random `two_` token while the row in `web_sessions` carries identity,
member/moderator flags, and expiry ([src/sessions.ts](../src/sessions.ts),
[src/index.tsx](../src/index.tsx)); tokens are SHA-256 hashed at rest,
sessions last 120 minutes with rotation on authenticated reads
(`SESSION_TTL_SECONDS`), and logout revokes the row. Operators can revoke
one member's active sessions with
[bin/revoke-sessions.mjs](../bin/revoke-sessions.mjs) (dry-run count by
default, `--apply` revokes), implemented in
[src/session-revocation.ts](../src/session-revocation.ts). OAuth state rides a
short-lived signed cookie plus a single-use hashed journey record
(`web_oauth_journeys`, 10-minute TTL)
([src/oauth-journeys.ts](../src/oauth-journeys.ts)); moderator status is
recomputed at login from Discord role-ID intersection, failing closed on a
blank allowlist or failed lookup ([src/roles.ts](../src/roles.ts)); the QA
seam ([src/qa.ts](../src/qa.ts)) works only on the exact staging `APP_URL`
with its configured token and otherwise answers 404.

## 7. Companion trees and their status

Read from: [web/package.json](../web/package.json),
[web/src/lib/server/hono.ts](../web/src/lib/server/hono.ts),
[spike/hyperdrive-semantics/findings.md](../spike/hyperdrive-semantics/findings.md),
[e2e/fixtures.ts](../e2e/fixtures.ts), [e2e/worker.ts](../e2e/worker.ts),
[ci/check-config-docs.mjs](../ci/check-config-docs.mjs),
[bin/smoke.mjs](../bin/smoke.mjs), [bin/json-smoke.mjs](../bin/json-smoke.mjs).

- [web/](../web/) (`two-web-next-kit` in
  [web/package.json](../web/package.json)) is the experimental SvelteKit
  strangler preview, not the primary Worker: unported routes fall through to
  the unchanged Hono app
  ([web/src/lib/server/hono.ts](../web/src/lib/server/hono.ts)). Status:
  experimental spike, not serving production traffic.
- [spike/](../spike/) holds the Hyperdrive-semantics probe only. Status:
  acceptance remains **not verified** per
  [its findings](../spike/hyperdrive-semantics/findings.md); the live
  staging attempt ended in a pre-SQL refusal.
- [e2e/](../e2e/) holds Playwright browser journeys. Offline-first:
  [fixtures](../e2e/fixtures.ts) block non-localhost traffic and the
  [stub worker](../e2e/worker.ts) fakes Discord OAuth; staging-guarded
  journeys run separately.
- [ci/](../ci/) holds the offline PR and deploy gates run by `npm run check`
  (for example the config-docs drift check in
  [ci/check-config-docs.mjs](../ci/check-config-docs.mjs), bundle budgets,
  accessibility, cutover and shadow selftests). It has no README; the command
  list lives in `package.json` scripts. Status: active.
- [bin/](../bin/) holds staging-only post-deploy probes such as the
  public-routes smoke ([bin/smoke.mjs](../bin/smoke.mjs)) and the QA session
  JSON smoke ([bin/json-smoke.mjs](../bin/json-smoke.mjs)). Status: active;
  never production test commands.

Not verified: production-environment behavior (the `env.production` block in
[wrangler.jsonc](../wrangler.jsonc) is a disabled cutover template, not live
evidence), any future SvelteKit cutover plan, and line-level internals of
the reconcile/prune job implementations beyond the entry wiring cited above.

## 8. Module map

Areas group modules by what they do. `entry` is the Worker and app
composition; `http-guard` is global request middleware (security headers,
host, origin, banners, body limits, throttles); `auth` is sign-in, sessions,
and roles; `content` is public pages, SEO, privacy, featured content, and
static-asset policy; `join` is the join journey; `profiles` is member data;
`events`, `admin`, `agent-events`, `jobs`, `persistence`, `bot`, and
`frontend` follow their `src/` directories; `observability` is health,
alerts, logging, and probes. Every `src/` root file and directory appears
exactly once.

<!-- module-map:start -->
| Path | Area |
| --- | --- |
| `src/access-log.ts` | observability |
| `src/admin/` | admin |
| `src/agent-events/` | agent-events |
| `src/alert-probe-error.ts` | observability |
| `src/alert-probe.ts` | observability |
| `src/alerts.ts` | observability |
| `src/auth/` | auth |
| `src/auth-status.ts` | auth |
| `src/body-limit.ts` | http-guard |
| `src/bot/` | bot |
| `src/counts.ts` | content |
| `src/csp-report-body.ts` | http-guard |
| `src/csp-report-uri.ts` | http-guard |
| `src/csp-reports.ts` | http-guard |
| `src/db/` | persistence |
| `src/discord-http.ts` | auth |
| `src/discord-widget.ts` | join |
| `src/discord.ts` | auth |
| `src/env.ts` | entry |
| `src/errors.tsx` | entry |
| `src/events/` | events |
| `src/featured-image.ts` | content |
| `src/featured-policy.ts` | content |
| `src/featured-status.tsx` | content |
| `src/featured.ts` | content |
| `src/freeze-banner.ts` | http-guard |
| `src/headers.ts` | http-guard |
| `src/image-policy.ts` | content |
| `src/index.tsx` | entry |
| `src/invite.ts` | join |
| `src/islands/` | frontend |
| `src/jobs/` | jobs |
| `src/jobs-worker.ts` | jobs |
| `src/join/` | join |
| `src/member-erasure.ts` | profiles |
| `src/member-reads.ts` | profiles |
| `src/not-found-suggestions.ts` | content |
| `src/oauth-journeys.ts` | auth |
| `src/page-shell.tsx` | content |
| `src/pages.tsx` | content |
| `src/pinned-assets.ts` | content |
| `src/privacy-content.ts` | content |
| `src/privacy.ts` | content |
| `src/probes/` | observability |
| `src/profiles/` | profiles |
| `src/qa.ts` | auth |
| `src/request-log.ts` | observability |
| `src/return-journey.ts` | auth |
| `src/roles.ts` | auth |
| `src/rules-last-updated.ts` | content |
| `src/same-origin.ts` | http-guard |
| `src/screens/` | content |
| `src/security-txt.ts` | content |
| `src/seo.ts` | content |
| `src/seo-leaves.tsx` | entry |
| `src/session-revocation.ts` | auth |
| `src/sessions.ts` | auth |
| `src/static-leaves.tsx` | entry |
| `src/throttle.ts` | http-guard |
| `src/trust-hosts.ts` | http-guard |
| `src/up.ts` | observability |
| `src/worker.ts` | entry |
| `src/write-recovery.tsx` | auth |
<!-- module-map:end -->
