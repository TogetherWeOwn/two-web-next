# Staging jobs handoff runbook: two-web-next → two-web-jobs

Staging-only transfer of the queue consumers and cron schedules from the web
Worker (`two-web-next`, `wrangler.jsonc`) to the jobs Worker (`two-web-jobs`,
`wrangler.jobs.jsonc`). Same queue names, same bindings, same payloads, same
handlers (`handleQueue`/`handleScheduled` in `src/jobs/worker.ts`); no Effect,
no renames. `test/jobs-worker-config.test.ts` and `test/jobs-handoff.test.ts`
pin the split: exactly one consumer per queue and one cron owner.

## What moves and what does not

- Moves: `consumers` for `two-sync-event` / `two-internal-action` and both
  crons (`*/10 * * * *` reconcile, `0 0 * * *` prune) to the jobs top level.
- Stays: web producers (`SYNC_EVENT_QUEUE`, `INTERNAL_ACTION_QUEUE`), routes,
  `env.production` cutover template, preview envs and their disjoint queues.
- Jobs top level adds only `placement` (eu-central-1, beside staging Neon),
  `tail_consumers` (staging pager), `keep_vars` and `APP_URL`; never preview
  production guild settings and never secrets in source.

## Least-required secrets (Operator step, names only)

Provision on `two-web-jobs` with `wrangler secret put --config
wrangler.jobs.jsonc`, never in a file, PR, log or argv value:

- `BOT_ENDPOINT_URL`, `BOT_KEY_ID`, `BOT_SHARED_SECRET` — required for
  delivery. A missing value fails every bot job terminally (`BotTerminalError`,
  `queue.failing` alert, never acked as success). Confirm present before
  resuming delivery or replaying real messages.
- `QA_AUTH_TOKEN` — staging only; gates the alert-probe path through
  `qaEnabled()` with the staging `APP_URL`.

Do not provision on jobs: `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`SESSION_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_MODERATOR_ROLE_IDS`,
`QUEUE_RECONCILE_*` (separate authorization). The jobs preview keeps
`APP_URL https://two-web-jobs-preview.invalid` so `qaEnabled()` stays false.

## Readiness (jobs has no fetch handler)

- `npx wrangler deployments status --name two-web-jobs --json` names the
  active version; `npx wrangler queues consumer list <queue>` shows exactly
  one consumer (`worker:two-web-jobs`) per staging queue.
- Staging `GET /up` still answers 200 with the queue ledger envelope
  (`healthy`/`degraded`, never sunk by a queue-only read).
- Jobs `queue.failing` traces page through `two-web-next-alerts`
  (`APP_SCRIPT_NAMES` includes `two-web-jobs`).
- Synthetic: the staging-only internal-action drill
  (`bin/internal-action-drill.mjs`, throwaway channel/identity) and the alert
  probe; both refuse production targets.

## Handoff sequence (authorized Operator, serialized)

Run under an exclusive staging deploy/migration hold with no deploy in flight.
Re-verify exact-SHA CI (`node ci/staging-deploy-gate.mjs`) before each
Cloudflare mutation. Detach before attach so two consumers never exist.

```bash
# 0. Record the rollback pointers and the backlog (read-only).
npx --no-install wrangler deployments status --name two-web-next --json
npx --no-install wrangler deployments status --name two-web-jobs --json
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
npx --no-install wrangler queues info two-sync-event
npx --no-install wrangler queues info two-internal-action
curl -fsS https://next.togetherweown.com/up

# 1. Pause delivery (reversible; producers keep enqueueing, backlog retained).
npx --no-install wrangler queues pause-delivery two-sync-event
npx --no-install wrangler queues pause-delivery two-internal-action

# 2. Detach: deploy the web Worker without consumers or crons.
npx wrangler deploy --config wrangler.jsonc --tag "$DEPLOY_SHA"
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
# Both lists are empty; messages accumulate, none are lost.

# 3. Attach: deploy the jobs Worker with consumers and both crons.
npx wrangler deploy --config wrangler.jobs.jsonc --tag "$DEPLOY_SHA"
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
# Each list shows exactly worker:two-web-jobs, once.

# 4. Resume the existing transport and reconcile.
npx --no-install wrangler queues resume-delivery two-sync-event
npx --no-install wrangler queues resume-delivery two-internal-action
curl -fsS https://next.togetherweown.com/up
```

Backlog is reconciled, never purged: queue names are unchanged so transport
messages survive the redeploys; the Postgres ledger plus the single-flight
advisory lock serialize the cron passes; tracked sends with the unique lock
and immutable idempotency keys keep bot side effects from duplicating. Do not
purge, delete/recreate queues, age-delete ledger rows or clear unique locks
as a shortcut. Never `wrangler queues purge` here.

## Rollback (restores ownership once)

```bash
# REMOTE MUTATION: run only after the incident's rollback decision.
npx --no-install wrangler rollback "$GOOD_JOBS_VERSION" --name two-web-jobs -y
npx --no-install wrangler rollback "$GOOD_WEB_VERSION" --name two-web-next -y
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
# Exactly one consumer again (worker:two-web-next at the pre-handoff
# versions); resume delivery only if paused.
```

A Worker rollback does not undo schema, data, Discord side effects or queue
messages. Keep required bindings in place; never delete a queue to roll back.
