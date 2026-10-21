# Production jobs handoff runbook: two-web-next-production → two-web-jobs-production

One-time transfer of the production queue consumers and cron schedules from
the web Worker (`two-web-next-production`, `wrangler.jsonc`
`env.production`) to the jobs Worker (`two-web-jobs-production`,
`wrangler.jobs.jsonc` `env.production`). Same queue names, same bindings,
same payloads, same handlers (`handleQueue`/`handleScheduled` in
`src/jobs/worker.ts`); no Effect, no renames. `test/jobs-worker-config.test.ts`
and `test/probe-workflows.test.ts` pin the split: exactly one consumer per
production queue and one cron owner, and the automatic promotion lane never
attaches production jobs itself.

This is the staging-proven procedure ([jobs-handoff.md](./jobs-handoff.md):
pause, detach before attach, verify, resume; backlog reconciled, never
purged), adapted to the production constraints: versions upload/promote never
touch triggers, and neither `wrangler deploy --env production` nor `wrangler
triggers deploy --env production` may run against the web Worker — both
re-sync routes and custom domains, retry provisioning the already-attached
apex, and fail with Cloudflare 100117. Every trigger move below is either a
queue-side consumer command (which never touches domains) or the domain-safe
schedules API from [runbook.md](./runbook.md) ("Production trigger
reconciliation"), except the jobs Worker deploy itself, which carries no
routes or custom domains and so cannot re-trigger 100117. Never delete or
recreate the apex DNS record or the custom domain.

## What moves and what does not

- Moves: `consumers` for `two-web-next-production-sync-event` /
  `two-web-next-production-internal-action` and both crons (`*/10 * * * *`
  reconcile, `0 0 * * *` prune) to the jobs `env.production`.
- Stays: web producers (`SYNC_EVENT_QUEUE`, `INTERNAL_ACTION_QUEUE`) in the
  web `env.production`, the apex route, preview envs and their disjoint
  queues, staging ownership.
- The jobs `env.production` adds only `placement` (`mode: off`, following
  the web production cutover decision), `tail_consumers` (production pager),
  `version_metadata`, and the production `APP_URL`; never staging guild
  settings and never secrets in source.

## Least-required secrets (Operator step, names only)

Provision on `two-web-jobs-production` with `wrangler secret put --config
wrangler.jobs.jsonc --env production`, never in a file, PR, log or argv value:

- `BOT_ENDPOINT_URL`, `BOT_KEY_ID`, `BOT_SHARED_SECRET` — required for
  delivery. A missing value fails every bot job terminally (`BotTerminalError`,
  `queue.failing` alert, never acked as success). Confirm present before the
  attach step: `node ci/check-jobs-secrets.mjs --env=production` must pass
  (names only, fail-closed) or the transfer stops.
- `QA_AUTH_TOKEN` — never provision on production: it is the staging
  probe token, and `qaEnabled()` requires the staging `APP_URL` anyway.

Do not provision on jobs: `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`SESSION_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_MODERATOR_ROLE_IDS`,
`QUEUE_RECONCILE_*` (separate authorization).

Custody (names only, never values): the three BOT names come through the
existing production secret custodian path. Do not rotate or substitute a
credential to fill a gap, do not copy staging values, and do not provision
`QUEUE_RECONCILE_*` by inference.

## Readiness (jobs has no fetch handler)

- `npx wrangler deployments status --name two-web-jobs-production --json`
  names the active jobs version after the attach.
- `npx wrangler queues consumer list <production queue>` shows exactly one
  consumer (`worker:two-web-jobs-production`) per production queue.
- `node ci/check-production-triggers.mjs` exits 0: live schedules and
  consumers exactly match the reviewed configs. Any drift line is a partial
  success — stop and reconcile per [runbook.md](./runbook.md) before
  resuming delivery.
- Production `GET https://togetherweown.com/up` still answers 200 with the
  queue ledger envelope (`healthy`/`degraded`, never sunk by a queue-only
  read).
- Jobs `queue.failing` traces page through `two-web-next-alerts-production`
  (`APP_SCRIPT_NAMES` includes `two-web-jobs-production`, pinned by
  `test/tail-alerts.test.ts` and `ci/check-config-docs.mjs`).

## Coordinated hold (required before any transfer mutation)

The transfer needs a bounded exclusive hold. Versions upload/promote never
touch triggers, so an automatic promotion cannot disturb the consumer/cron
moves — but it changes the web version under test and confuses every
before/after receipt, and a queued promotion behind the transfer would
promote into an unverified topology. Freeze the lane for the window:

- Set the hold before the first mutation: `gh variable set
  PRODUCTION_HOLD_UNTIL --body "<ISO-8601 UTC, at most 2h out>"`. The gate
  (`ci/production-deploy-gate.mjs`) refuses values more than 24h ahead and
  pauses automatic and manual promotion while the hold is in the future; the
  emergency rollback lane takes no hold variable and stays open.
- Confirm no `deploy-production` run is in flight (waiting, queued, or
  running) and no `db-migrate` production run is queued or in progress on the
  Actions pages before the first mutation, and re-confirm between mutations.
  A run that appears mid-window aborts the transfer: stop, re-record the
  rollback pointers and the backlog, and re-enter under a fresh hold.
- Record the hold on the transfer card thread with named owner
  acknowledgement, a start time and an expiry (at most 2h; release explicitly
  when done). An expired hold is not a hold: re-acknowledge before continuing.
- Release the hold when the transfer is done or aborted: `gh variable delete
  PRODUCTION_HOLD_UNTIL`, then verify `gh variable list` no longer shows it.
  If the transfer rolled back, keep the hold until the cause is fixed.
- Source changes to this runbook or the pinned configs need ordinary
  exact-head CI and an independent review before they count as the packet.

## Transfer sequence (authorized Operator, serialized)

Run under the coordinated hold above with no deploy in flight. Re-verify
exact-SHA CI before each Cloudflare mutation. Detach before attach so two
consumers never exist. Tokens come from the environment, never argv.

```bash
# 0. Record the rollback pointers and the backlog (read-only).
npx --no-install wrangler deployments status --name two-web-next-production --json
npx --no-install wrangler queues consumer list two-web-next-production-sync-event
npx --no-install wrangler queues consumer list two-web-next-production-internal-action
npx --no-install wrangler queues info two-web-next-production-sync-event
npx --no-install wrangler queues info two-web-next-production-internal-action
# Record each queue's pre-transfer delivery state: the step-7 resume and any
# rollback resume only queues this transfer paused, and preserve pauses that
# predate it. wrangler queues info prints no delivery state, so the read is
# the Queues REST API's settings.delivery_paused, like the staging rollback
# (token from the environment, never argv). A failed or unknown read fails
# the run instead of recording a guess.
for q in two-web-next-production-sync-event two-web-next-production-internal-action; do
  delivery=$(CF_TOKEN="$CLOUDFLARE_API_TOKEN" CF_ACCT="$CF_ACCOUNT_ID" QUEUE="$q" node -e '
    (async () => {
      const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + process.env.CF_ACCT + "/queues", {
        headers: { authorization: "Bearer " + process.env.CF_TOKEN },
      });
      const d = await r.json();
      if (!d.success) { console.error(JSON.stringify(d.errors)); process.exit(1); }
      const found = (d.result ?? []).filter((x) => x.queue_name === process.env.QUEUE);
      if (found.length !== 1) { console.error(process.env.QUEUE + ": expected exactly one queue, got " + found.length); process.exit(1); }
      const paused = found[0].settings?.delivery_paused;
      if (paused === true) console.log("paused");
      else if (paused === false) console.log("active");
      else { console.error(process.env.QUEUE + ": unknown delivery state " + JSON.stringify(paused)); process.exit(1); }
    })();
  ') || exit 1
  echo "$q: pre-transfer delivery is $delivery (step-0 record)"
done
curl -fsS https://togetherweown.com/up
# Assert the exact transitional diff: the probe must report ONLY web-owned
# consumers/crons plus the undeployed jobs script. Any other drift aborts.
node ci/check-production-triggers.mjs

# 1. Provision the three BOT secrets on the jobs Worker (names only above),
# then gate the attach on them. A missing secret stops here, before any
# consumer moves: without delivery credentials every bot job fails
# terminally and the backlog leaves the queue needing manual replay.
node ci/check-jobs-secrets.mjs --env=production

# Pin the deploy tag before the first mutation: step 4 tags the jobs Worker
# version with the exact SHA of this verified checkout, so the version stays
# traceable to the CI run that passed on it. An empty or short value fails
# here, before any consumer moves, instead of tagging the deploy with junk.
DEPLOY_SHA="$(git rev-parse HEAD)" || exit 1
printf '%s' "$DEPLOY_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "DEPLOY_SHA is not an exact commit SHA: $DEPLOY_SHA" >&2; exit 1; }

# 2. Pause delivery (reversible; producers keep enqueueing, backlog retained).
npx --no-install wrangler queues pause-delivery two-web-next-production-sync-event
npx --no-install wrangler queues pause-delivery two-web-next-production-internal-action

# 3. Detach: remove the web Worker's existing consumers explicitly. A
# versions promotion never detaches: without the removes the next step
# collides with the still-attached worker:two-web-next-production consumer.
for q in two-web-next-production-sync-event two-web-next-production-internal-action; do
  # Capture before parsing: a failed list piped into grep reads as "no
  # consumer" without pipefail, and the attach then collides with the
  # still-attached web consumer. A failed list fails the run instead.
  # Uses --json with exact script-name matching: table grep would match the
  # queue name inside wrangler's empty-list message (No consumers found for
  # queue "two-web-next-production-sync-event"), so re-entry after the web
  # consumer is already gone would try to remove a nonexistent consumer.
  out=$(npx --no-install wrangler queues consumer list "$q" --json) || exit 1
  present=$(CONSUMERS_JSON="$out" QUEUE="$q" node -e '
    const d = JSON.parse(process.env.CONSUMERS_JSON);
    if (!Array.isArray(d)) { console.error(process.env.QUEUE + ": consumer list is not an array"); process.exit(1); }
    console.log(d.some((c) => (c.script ?? c.script_name ?? null) === "two-web-next-production") ? "yes" : "no");
  ') || exit 1
  if [ "$present" = "yes" ]; then
    npx --no-install wrangler queues consumer remove "$q" two-web-next-production
  else
    echo "no two-web-next-production consumer on $q"
  fi
done
npx --no-install wrangler queues consumer list two-web-next-production-sync-event
npx --no-install wrangler queues consumer list two-web-next-production-internal-action
# Both lists are empty; messages accumulate, none are lost.

# 4. Attach: deploy the jobs Worker with consumers and both crons. The jobs
# config carries no routes or custom domains, so this deploy cannot touch
# the apex. Run from the exact-SHA checkout whose full CI passed.
npx wrangler deploy --config wrangler.jobs.jsonc --env production --tag "$DEPLOY_SHA"
npx --no-install wrangler queues consumer list two-web-next-production-sync-event
npx --no-install wrangler queues consumer list two-web-next-production-internal-action
# Each list shows exactly worker:two-web-jobs-production, once.

# 5. Clear the web Worker's schedules through the domain-safe API. `wrangler
# triggers deploy --env production` is banned: it re-syncs the apex and
# fails 100117. PUT replaces the whole schedule set; read back until the web
# script holds none and the jobs script holds both. If the API refuses an
# empty replacement, stop and reconcile per runbook.md instead of forcing it.
CF_TOKEN="$CLOUDFLARE_API_TOKEN" CF_ACCT="$CF_ACCOUNT_ID" node -e '
  const token = process.env.CF_TOKEN;
  const acct = process.env.CF_ACCT;
  (async () => {
    for (const [script, crons] of Object.entries({
      "two-web-next-production": [],
      "two-web-jobs-production": ["*/10 * * * *", "0 0 * * *"],
    })) {
      const put = await fetch("https://api.cloudflare.com/client/v4/accounts/" + acct + "/workers/scripts/" + script + "/schedules", {
        method: "PUT",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(crons.map((cron) => ({ cron }))),
      });
      const updated = await put.json();
      if (!updated.success) { console.error(JSON.stringify(updated.errors)); process.exit(1); }
      const read = await fetch("https://api.cloudflare.com/client/v4/accounts/" + acct + "/workers/scripts/" + script + "/schedules", {
        headers: { authorization: "Bearer " + token },
      });
      const live = await read.json();
      if (!live.success) { console.error(JSON.stringify(live.errors)); process.exit(1); }
      const got = (live.result?.schedules ?? []).map((s) => s.cron).sort();
      if (JSON.stringify(got) !== JSON.stringify([...crons].sort())) {
        console.error(script + " schedules mismatch: " + JSON.stringify(got));
        process.exit(1);
      }
    }
    console.log("live schedules ok: web owns none, jobs owns both crons");
  })();
'

# 6. Verify: the probe is clean, exactly one owner per queue and cron.
node ci/check-production-triggers.mjs
npx --no-install wrangler deployments status --name two-web-next-production --json
npx --no-install wrangler deployments status --name two-web-jobs-production --json
curl -fsS https://togetherweown.com/up

# 7. Resume the existing transport and reconcile. Resume only queues the
# step-0 record shows were active before the transfer: a queue paused before
# the transfer stays paused (skip its resume line).
npx --no-install wrangler queues resume-delivery two-web-next-production-sync-event
npx --no-install wrangler queues resume-delivery two-web-next-production-internal-action
curl -fsS https://togetherweown.com/up
```

Backlog is reconciled, never purged: queue names are unchanged so transport
messages survive the redeploys; the Postgres ledger plus the single-flight
advisory lock serialize the cron passes; tracked sends with the unique lock
and immutable idempotency keys keep bot side effects from duplicating. Do not
purge, delete/recreate queues, age-delete ledger rows or clear unique locks
as a shortcut. Never `wrangler queues purge` here.

Brief double-ownership of the crons between steps 4 and 5 is safe by
construction: the reconcile pass takes the Postgres single-flight advisory
lock, and the prune pass is an idempotent delete. Double-ownership of a
consumer is never safe, which is why step 3 detaches before step 4 attaches.

Record with the transfer evidence: the step-0 readouts (including the
pre-transfer delivery state per queue), the probe outputs at steps 0 and 6,
the secrets-gate pass, both jobs versions, the before/after consumer lists
and schedule read-backs, and the before/after `/up` queue envelopes
(pending/delayed/failing counts). The transfer is done when the step-6 probe
exits 0 and delivery is resumed.

## Rollback (restores ownership once)

Rolling back a Worker version never restores queue-side consumers or trigger
schedules: `wrangler rollback` only changes which version is active. Move
both back explicitly. The jobs production Worker has no prior application
version on its first transfer, so there is no jobs version to roll back to —
detach it instead.

1. Keep the promotion hold until the cause is fixed (see Coordinated hold).
   Cancel or reject every waiting, queued, or running `deploy-production`
   run first — waiting runs hold the `production-worker-mutation` lock —
   then confirm the live versions and re-read the consumer lists and live
   schedules. The step-0 record stays immutable: never overwrite the
   pre-transfer version pointers.
2. Pause delivery on both production queues (owned pauses; producers keep
   enqueueing).
3. Move consumers back state-aware: for each production queue, read `wrangler
   queues consumer list --json` first. A failed list fails the run instead of
   reading as empty; an unexpected consumer (neither
   `two-web-next-production` nor `two-web-jobs-production`) fails instead of
   being blindly touched. Remove the jobs consumer where present, then add
   the web consumer where missing with the reviewed settings:
   `npx wrangler queues consumer add <queue> two-web-next-production
   --message-retries 10 --batch-size 10 --batch-timeout 5`.
4. Move both crons back through the domain-safe schedules API (never
   `wrangler triggers deploy --env production`): `PUT
   .../workers/scripts/two-web-next-production/schedules` with
   `[{"cron": "*/10 * * * *"}, {"cron": "0 0 * * *"}]`, then `PUT
   .../workers/scripts/two-web-jobs-production/schedules` with `[]`, then
   read both back until they match.
5. Verify: the probe reports exactly the step-0 transitional diff again
   (web owns everything, jobs holds nothing) — that output proves the
   restore. Re-read both consumer lists (exactly
   `worker:two-web-next-production`, once per queue) and confirm
   `https://togetherweown.com/up` is healthy or degraded.
6. Resume delivery per the step-0 pre-transfer record, after re-confirming
   the hold is active, no deploy or migrate run appeared, and `/up` is
   healthy or degraded: resume a queue the transfer paused (active at step
   0, paused now) and a queue only this rollback paused; leave a queue
   paused before the transfer paused. Never purge, delete/recreate queues,
   age-delete ledger rows or clear unique locks.

A Worker rollback does not undo schema, data, Discord side effects or queue
messages. Keep required bindings in place; never delete a queue to roll back.

## Steady state after the transfer

Later production trigger changes go through [runbook.md](./runbook.md)
("Production trigger reconciliation"), which reconciles only the changed
trigger kind without touching the apex. Steady-state jobs Worker code
deploys and promotion-lane probe wiring are separate, deliberately sequenced
follow-ups — never part of this one-time transfer.
