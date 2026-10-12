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
  resuming delivery or replaying real messages. The staging deploy workflow
  enforces this fail-closed (`node ci/check-jobs-secrets.mjs` runs before the
  jobs Worker deploy and refuses when any of the three names is absent), so an
  automatic deploy after merge can never attach the jobs consumer without them.
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

# 2. Detach: deploy the web Worker without consumers or crons, then remove
# its existing consumers explicitly. The deploy alone does NOT detach:
# Wrangler only adds or updates the consumers listed in the deployed config
# and never deletes one that was dropped from it, so without the removes the
# next step collides with the still-attached worker:two-web-next consumer.
npx wrangler deploy --config wrangler.jsonc --tag "$DEPLOY_SHA"
for q in two-sync-event two-internal-action; do
  if npx --no-install wrangler queues consumer list "$q" | grep -q "two-web-next"; then
    npx --no-install wrangler queues consumer remove "$q" two-web-next
  else
    echo "no two-web-next consumer on $q"
  fi
done
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

`wrangler rollback` only changes which Worker version is active. Queue
consumers are queue-side attachments and cron schedules are trigger settings
applied outside versions, so rolling back both Workers alone leaves
`two-web-jobs` still owning both consumers and both crons. Move them back
explicitly after the version rollbacks (same pre-handoff settings the web
Worker ran with: `max_retries` 10, batch 10, timeout 5):

```bash
# REMOTE MUTATION: run only after the incident's rollback decision.
npx --no-install wrangler rollback "$GOOD_JOBS_VERSION" --name two-web-jobs -y
npx --no-install wrangler rollback "$GOOD_WEB_VERSION" --name two-web-next -y

# Move both consumers back to the web Worker.
npx --no-install wrangler queues consumer remove two-sync-event two-web-jobs
npx --no-install wrangler queues consumer remove two-internal-action two-web-jobs
npx --no-install wrangler queues consumer add two-sync-event two-web-next \
  --message-retries 10 --batch-size 10 --batch-timeout 5
npx --no-install wrangler queues consumer add two-internal-action two-web-next \
  --message-retries 10 --batch-size 10 --batch-timeout 5

# Move both crons back: check out the pre-handoff wrangler.jsonc (it still
# lists both schedules) and apply its triggers, then clear the jobs Worker's
# schedules by applying its produce-only config from the same commit.
# $PRE_HANDOFF_SHA is the pre-handoff main commit: the commit SHA the
# pre-handoff Versions are tagged with (step-0 record, bin/revision-check.mjs).
git show "$PRE_HANDOFF_SHA:wrangler.jsonc" > /tmp/rollback-wrangler.jsonc
git show "$PRE_HANDOFF_SHA:wrangler.jobs.jsonc" > /tmp/rollback-wrangler.jobs.jsonc
npx --no-install wrangler triggers deploy --config /tmp/rollback-wrangler.jsonc
npx --no-install wrangler triggers deploy --config /tmp/rollback-wrangler.jobs.jsonc

# Verify: exactly one consumer again (worker:two-web-next, once per queue).
npx --no-install wrangler queues consumer list two-sync-event
npx --no-install wrangler queues consumer list two-internal-action
npx --no-install wrangler deployments status --name two-web-next --json
npx --no-install wrangler deployments status --name two-web-jobs --json
curl -fsS https://next.togetherweown.com/up
# Resume delivery only if paused.
```

A Worker rollback does not undo schema, data, Discord side effects or queue
messages. Keep required bindings in place; never delete a queue to roll back.
