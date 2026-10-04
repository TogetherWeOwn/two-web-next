# Cutover rollback rehearsal (staging)

Staging-only rehearsal of the production cutover rollback path: ordered
revert steps, DNS/import backout, and compatibility notes. The Worker
rollback procedure it rehearses lives in
[runbook.md](runbook.md#worker-rollback); the release/deploy gates it
assumes live in [cutover-gates.md](cutover-gates.md). Never run these
steps against `togetherweown.com`, `www`, or
`two-web-next-production`.

## Scope of this rehearsal

- In scope: Worker rollback N+1 to N and back on staging host
  `next.togetherweown.com`, Worker `two-web-next`; ordered revert
  checklist with import backout and schema-compat notes below.
- Rehearsed separately (needs a DNS-edit principal): DNS flip to the
  legacy target and back. The deploy credential has no DNS edit, so an
  authorized operator ran it on 2026-10-03 per
  [runbook.md](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back);
  timings are in the record below.

## Ordered revert steps (staging rehearsal)

1. Confirm staging is idle: no `deploy` run queued, pending, or in
   progress on `main` (Actions page or REST API). A merge deploy during
   the rehearsal overwrites the rollback. A `ci` push run in progress
   does not block the drill: its deploy reaches the Worker upload about
   9 minutes after `ci` succeeds, and the Worker half takes about 3.
   Under a merge burst (a `main` push about every 13 minutes) waiting
   for no `ci` run never ends; the clean window opens when a deploy lands.
2. Record the rollback pointer: save `wrangler deployments list
   --name two-web-next --json` and note the active (N+1) version ID
   plus the chosen known-good N version ID. Prefer the newest N
   whose sources differ on a public route; adjacent versions are
   often code-identical after workflow-only merges.
3. Baseline: run the staging smoke (17 routes)
   (`node bin/smoke.mjs https://next.togetherweown.com`) and record
   the result. The rehearsal compares against this baseline.
4. Roll back with `wrangler rollback <N_VERSION> --name two-web-next
   -m "<reason>" -y`; record command time, first request served by N,
   settle time, and non-200 probe count.
5. Prove N serves (telemetry `$workers.scriptVersion.id` plus a
   public-path status discriminator when versions differ on one),
   then run N's own smoke from `git archive <N_SHA> bin ci`.
6. Roll forward to N+1 the same way, repeat the baseline smoke, and
   confirm the deployment list differs from step 2 only by the two
   rehearsal deployments. Restore staging to the pre-rehearsal
   version at 100%.

## DNS and import backout

- DNS backout is the runbook's flip-back block: delete the rehearsal
  records, re-attach the custom domain
  (`PUT /accounts/.../workers/domains`), and read back exactly one
  custom domain plus the Worker's read-only record. If the re-attach
  fails, `wrangler triggers deploy` re-applies the domain from
  `wrangler.jsonc` without uploading code. Proxied records use `ttl`
  1 (auto): the flip depends on edge-config apply, not resolver
  expiry. Rehearsed on staging: the flip back took 2.1 s to run and
  the Next marker returned 3.2 s later, stable after 14.7 s.
- The production rollback is the same flip to legacy, so the legacy
  origin must answer for the apex. On staging it answered 522 for
  `next.*`; confirm production legacy before the flip, per the
  [runbook](runbook.md#before-the-production-flip).
- Import backout: the member-data importers are idempotent upserts
  (users/profiles upsert, events upsert on `event_key` in
  parent-first order, RSVPs upsert on the resolved key; re-runs
  preserve destination row IDs and write nothing when identical).
  A bad import is therefore backed out by re-running the corrected
  import, not by deleting rows — see
  [import-users-profiles.md](import-users-profiles.md) and
  [import-events-rsvps.md](import-events-rsvps.md). Never reconstruct
  or delete ledger rows by hand.
- Queue backout: pause delivery per the runbook's containment block;
  never purge, delete/recreate queues, or remove consumers to hide
  an incident.

## Production cutover step ↔ reverse map

Every production cutover step and its backout. "Tested" means rehearsed
on staging or proved by a green workflow receipt; the per-step result table below
records pass/fail per step. A Worker rollback never undoes schema, data,
Discord side effects, queue messages or external-resource changes.

| # | Forward step | Reverse (backout) | How the reverse is tested |
|---|---|---|---|
| 0 | Pre-cutover snapshot (checklist below) | Snapshot is read-only; no reverse. A missing item aborts the cutover | Staging drill records all four snapshot items |
| 1 | Production schema migration (`db-migrate.yml`, target production) | Reviewed forward repair first. PITR restore only with CEO approval: migrations `1017` and `1019` are unmeasurable (see [cutover-migration-ledger.md](cutover-migration-ledger.md)) — only backup/PITR restores them | Staging drill: staging apply receipt + forward-repair path; PITR eligibility verified, never executed against staging data |
| 2 | Production Worker deploy (`deploy-production.yml`) | One-click `rollback-production` workflow to the recorded version ID, then `/up` smoke (200, `db:ok`, zero pending) | Staging drill: `wrangler rollback` N+1 → N → N+1 with smoke before/during/after |
| 3 | DNS flip apex/www to Next | Flip back to the legacy target: delete the flip records, re-attach the custom domain (`PUT /accounts/.../workers/domains`); `wrangler triggers deploy` fallback re-applies the domain from `wrangler.jsonc` | Staging drill: DNS flip to legacy and back on `next.togetherweown.com`, 2026-10-03 18:25 (Rehearsal record) |
| 4 | Member-data import run | Re-run the corrected import: importers are idempotent upserts that preserve destination row IDs and write nothing when identical. Never delete rows or hand-edit the ledger | Importer dry-run workflow plus staging import receipts |
| 5 | Queue traffic on the new Worker | Pause delivery per the runbook containment block. Never purge, delete/recreate queues, or remove consumers | Containment block in [runbook.md](runbook.md#queue-containment-drain-and-failed-job-replay) |
| 6 | 48h post-flip watch ([cutover-freeze.md](cutover-freeze.md) in force) | On Sev-1: contain, then the production rollback pointer (step 2 reverse). The 48h clock restarts after the re-flip | Watch spec in [runbook.md](runbook.md#48h-post-flip-watch) plus run records |

## Pre-cutover snapshot (record all six before any forward step)

1. Release SHA with exact-head green CI (`check`, `gitleaks`, `pr-lint`) plus same-SHA reviewer approval.
2. Production `db-migrate` plan receipt: zero pending web migrations, pre-apply PITR timestamp recorded and eligible.
3. Worker rollback pointer: current production Worker version ID (not deployment ID).
4. DNS inputs: current apex/www record sets with TTLs, before and after.
5. Watch roster: named primary/secondary per 12h block, pager + `/up` + after-gate cadence owners, freeze lifter.
6. Freeze posted: window from [cutover-freeze.md](cutover-freeze.md) announced on the cutover card.

## Abort triggers

Abort the cutover (stop forward steps, hold position, decide rollback on
the incident card) on any of these:

- Pre-cutover: any NO-GO gate in [cutover-gates.md](cutover-gates.md), or a missing snapshot item above.
- `/up` non-200, `db:error`, or `pending_migrations` nonzero on the new target.
- Pager storm (`error.alert` / `queue.failing` delivery).
- Red after-gate (`node ci/cutover-check.mjs --phase after --target togetherweown.com --json`).
- Member-visible breakage (sign-in, profiles, RSVPs, event pages).
- During a staging drill: a merge deploy landing in the window (the
  deployment list differs by more than the two rehearsal deployments), a
  `ci`/`deploy` run starting on `main`, or the baseline smoke changing
  mid-drill. Restore the pre-drill version and re-run in a quiet window.

## Who calls rollback

- Staging drill: the engineer running the drill executes; no production action, ever.
- Production incident: the **DevOps & Reliability Engineer** owns
  containment, release/rollback timing and incident evidence, and calls
  the rollback (runbook ownership in [runbook.md](runbook.md)).
- Technical disputes or missing implementation escalate to the **Director
  of Engineering**; security/access or suspected leaked member data go
  through the Director to CISO.
- Owner-reserved approvals stay with the **CEO**: credential
  rotation/deletion, new spend, and irreversible data recovery (PITR
  restore). Silence is never approval.

## Compatibility notes

- A Worker rollback does not undo schema, data, Discord side
  effects, queue messages, or external-resource changes. Check schema
  compatibility before rolling back: staging migrations stay
  backward-compatible (expand/contract) with the Worker they
  precede, and after a harmful migration the runbook prefers a
  reviewed forward repair over a down migration.
- A rollback can only target the last 100 published versions, and
  resource/class-lifecycle changes can prevent it — record the
  pointer before every release.
- Keep the release workflow from redeploying the bad head after a
  rollback. Production rollback is the one-click
  `rollback-production` workflow (same request and protection gates
  as a deploy); it smokes `/up` for HTTP 200 with `db:ok` and zero
  pending migrations afterward.

## Rehearsal record

| Date (UTC) | Step | Result |
|---|---|---|
| 2026-10-02 00:53–00:55 | Worker rollback and roll-forward | 5.2 s / 5.5 s commands, 0 non-200 of 150 / 90 probes |
| 2026-10-03 16:35–16:36 | Worker rollback `81da0f67` to `cd470835` and back | 4.4 s / 4.0 s commands, settled 5.1 s / 8.6 s, 0 non-200 of 90 probes, smoke 16/16 before/during/after |
| 2026-10-03 18:25 | DNS flip `next.*` to legacy and back (staging only) | flip 1.6 s, marker gone +1.2 s, 10 consecutive probes without it at +11.2 s; flip back 2.1 s, marker back +3.2 s, stable +14.7 s; smoke 16/16 before and after; zone clean; legacy edge answered 522 and intermittent 503 |
| 2026-10-03 20:36–20:37 | Worker rollback `59a88ba7` to `da612f07` and back | 3.7 s / 3.8 s commands, one switch each way (+4.5 s / +9.6 s), 0 non-200 of 137 probes, smoke 16/16 on `59a88ba7`, `da612f07` and `59a88ba7` again; staging restored at 100% |
| 2026-10-03 ~22:30 | Rehearsal scoping for this card: staging `/up` 200 `db:ok` 0 pending, staging idle (no `ci`/`deploy` in flight on `main`), Worker at merge-deploy version | Worker half already receipted twice same-day; the DNS half had already run at 18:25 (row above), which this scoping did not know |
| 2026-10-04 08:51–08:53 | Worker rollback `2e803af9` (72c4f435) to `44878468` (4c65217e) and back | 4.7 s / 3.8 s commands, first request on target +5.6 s / +5.5 s, one switch each way, 0 non-200 of 100 probes, smoke 17/17 on `2e803af9`, `44878468` (49 of 49 telemetry events N) and `2e803af9` again; no deploy landed in the window; staging restored at 100% |

### Per-step result, 2026-10-04 drill (staging revision `2e803af9`)

Pass means the reverse was executed on staging and its check held (this drill,
or the dated record above). Not run means no reverse was executed; the reason
is stated and nothing is claimed.

| # | Cutover step | Result | Evidence or reason |
|---|---|---|---|
| 0 | Pre-cutover snapshot | pass (items 1–3 on the staging analogue); items 4–6 not run | Deploy gate follows a green `ci` for the SHA; `dep-before.json` saved with active version `2e803af9` and chosen N `44878468`; `/up` `db:ok`, `pending_migrations` 0. DNS inputs were read in the 2026-10-03 18:25 run; roster and freeze are production-only |
| 1 | Production schema migration | not run | No harmful migration exists on staging to repair. Compatibility only: no `drizzle`, `migrations.lock`, `ci/neon-migrate.mjs` or `wrangler.jsonc` difference between N and N+1; `/up` `db:ok`, 0 pending on both. PITR is not drilled (CEO approval, irreversible) |
| 2 | Production Worker deploy | pass | `wrangler rollback` N+1 → N → N+1 on `two-web-next`, 100% each time, deployments `a58f67e3` and `77c4c9b9` the only additions, final state `2e803af9`@100; smoke 17/17 before, on N, and after. The production path is the `rollback-production` workflow, which this drill does not run |
| 3 | DNS flip | pass (2026-10-03 18:25, not repeated 2026-10-04) | Flip to legacy and back, marker returned at +3.2 s, stable at +14.7 s, zone clean. Caveat: the staging legacy origin answered 522, so the production legacy origin must be proven first ([runbook](runbook.md#before-the-production-flip)) |
| 4 | Member-data import | not run | The dry run fails closed until a staging-safe snapshot is provisioned (follow-up below). Idempotent re-run is covered by `test/import-*.test.ts` only |
| 5 | Queue traffic | not run | The runbook marks `pause-delivery` as incident-only and `resume-delivery` as unsafe on today's stubs. Read-only `wrangler queues info` on `two-sync-event` and `two-internal-action` showed one producer and one consumer (`worker:two-web-next`) each |
| 6 | 48h watch | not run | Applies after a real flip; the production rollback pointer is step 2 |

## Follow-ups

- Importer dry-run: dispatched on 2026-10-03 and failed closed in 29 s
  by design, because `LEGACY_STAGING_SNAPSHOT_DATABASE_URL` is not
  provisioned on the staging environment. Re-dispatch once a
  staging-safe snapshot is in place; never substitute production or
  test databases.
- Legacy edge: the staging legacy origin answered 522 for `next.*`
  during the DNS rehearsal. Confirm that the production legacy origin
  answers the apex before the flip (runbook, "Before the production
  flip").
- Staging `e2e-staging` (Staging critical journeys) failed after the
  08:15 and 08:29 UTC deploys; it must pass before the production deploy.
- Keep this record current: append each rehearsal row with timings,
  version IDs, smoke results, and discrepancies.
