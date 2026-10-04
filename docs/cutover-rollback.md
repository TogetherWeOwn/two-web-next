# Cutover rollback rehearsal (staging)

Staging-only Worker rollback and DNS flip/restoration evidence, plus a
non-executable production recovery capability map and import/schema limits.
The Worker rollback procedure it rehearses lives in
[runbook.md](runbook.md#worker-rollback); the release/deploy gates it
assumes live in [cutover-gates.md](cutover-gates.md). Never run these
steps against `togetherweown.com`, `www`, or
`two-web-next-production`.

## Scope of this rehearsal

- In scope: Worker rollback N+1 to N and back on staging host
  `next.togetherweown.com`, Worker `two-web-next`; ordered staging
  checklist with import recovery limits and schema-compat notes below.
- Rehearsed separately (needs a DNS-edit principal): DNS flip to the
  legacy target and back. The deploy credential has no DNS edit, so an
  authorized operator ran it on 2026-10-03 per
  [runbook.md](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back);
  timings are in the record below.

## Ordered revert steps (staging rehearsal)

1. Require a confirmed exclusive staging deploy/migration hold, coordinated
   by the DevOps & Reliability Engineer with the staging release owner and
   authorized migration/import operators. Hold automatic/manual deploy
   admission and schema/import writes; resolve queued/active work safely,
   without casually cancelling in-flight DDL. Record acknowledgements, hold
   mechanisms, targets, window and release procedure in the receipt as in
   [runbook step 1](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back).
   No confirmed hold means no drill. Historical runtimes or a quiet Actions
   page do not establish exclusion. Keep and re-confirm the hold through
   final verification; record live version/bindings and applied schema/journal
   identity from authorized release/migration evidence before selecting N.
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
6. Re-confirm the hold and unchanged live schema/bindings before rolling
   forward to N+1; on an intervening release/schema change, use the collision
   response below instead. Repeat the baseline smoke and save the final
   deployment list. Compare newly added deployment IDs: exactly the two
   recorded rehearsal IDs with expected allocations, no other new deployment
   in the drill window, and unchanged overlapping entries. Allow oldest entries
   to roll off the ten-entry history window; eviction alone is not a collision.
   Missing expected IDs or insufficient overlap is inconclusive, not pass
   ([runbook step 7](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back)).
   Confirm the pre-rehearsal version at 100% and unchanged schema/bindings, then
   obtain the authorized owners' hold-release acknowledgements.

## Staging DNS restoration and import recovery limits

- **Staging legacy → Next restoration:** the runbook's flip-back block
  deletes the rehearsal records, re-attaches the `next.togetherweown.com`
  custom domain (`PUT /accounts/.../workers/domains`), and reads back
  exactly one custom domain plus the Worker's read-only record. Its
  `wrangler triggers deploy` fallback selects top-level **staging**
  `wrangler.jsonc`; never use it for production recovery. Proxied records
  use `ttl` 1 (auto), so the flip depends on edge-config apply, not resolver
  expiry. The staging restoration took 2.1 s to run; the Next marker
  returned 3.2 s later, stable after 14.7 s.
- **Production Next → legacy recovery is the opposite direction:** remove
  the Next custom-domain attachments and restore the saved legacy apex/www
  records and their recorded proxy/TTL settings. Re-attaching Next is not
  a reverse. This drill does not supply a reviewed executable production
  DNS recovery procedure; the authorized cutover/incident operator must
  validate the host/attachment inventory and procedure before use. The
  staging legacy origin answered 522 for `next.*`; that is not proof that
  the production legacy origin is ready ([runbook](runbook.md#before-the-production-flip)).
- **Import re-run is not a general undo.** Corrected same-key upserts can
  repair values only where the importer update rules permit; identical
  rows are no-ops and destination IDs are preserved. Wrong identities or
  keys, extra rows and lost overwritten state need separately approved
  backup/repair recovery under writer holds. Re-running does not delete
  rows absent from the source, and newer destination users may be retained.
  See [import-users-profiles.md](import-users-profiles.md) and
  [import-events-rsvps.md](import-events-rsvps.md). Never perform ad hoc
  row deletion or reconstruct/delete ledger rows by hand.
- **Queue containment is environment-specific.** The runbook's commands
  target staging queues `two-sync-event` and `two-internal-action` only.
  A production incident must hold the relevant producers/writers and
  pause delivery to `two-web-next-production-sync-event` and
  `two-web-next-production-internal-action` with the authorized production
  principal; verify both targets, scope and readback in the incident
  procedure, not by copying the staging block. Delivery pause does not stop
  producers or the scheduled handler: reviewed holds must cover cron and
  shared-database writers as well. No executable production containment/
  resume procedure or hold mechanism is supplied here. Resume only after
  implementation, holds, receiver/adapter and replay gates clear. Never
  purge, delete/recreate queues or remove consumers to hide an incident.
  This drill did not test production containment.

## Production cutover capability ↔ reverse map

This is a **non-chronological capability map**, not an execution sequence:
row IDs identify related effects and reverses, not independently ordered steps.
The current `wrangler deploy --env production` claims the apex custom domain
and installs production queue consumers and crons in the same deployment;
it is not a code-only preparation followed by separate DNS/queue activation.
Before any traffic-bearing deployment, legacy writes must be paused, the
import destination quiescent, and migration/import verification complete under
those holds. A route-free or consumer-free preparation path would need a
separately reviewed implementation; this document does not supply one.

The evidence column states what actually ran; the result table below
separates pass, partial and not run. Staging analogues are not proof that a
production recovery procedure is complete or tested. A Worker rollback never
undoes schema, data, Discord side effects, queue messages or external-resource
changes. This record does not establish fully rehearsed cutover readiness.

| # | Forward capability / effect (not an ordered step) | Reverse (backout) | Rehearsal evidence (actually recorded) |
|---|---|---|---|
| 0 | Pre-apply snapshot (checklist below) | Snapshot is read-only; no reverse. A missing prerequisite aborts the cutover | Partial staging analogue: CI gate, `/up` readiness and Worker pointers recorded; no migration plan/PITR evidence. Six-item breakdown in the result table |
| 1 | Production schema migration (`db-migrate.yml`, target production), completed and verified before traffic | Reviewed forward repair first. PITR restore requires owner-reserved approval consolidated by the CEO: migrations `1017` and `1019` are unmeasurable (see [cutover-migration-ledger.md](cutover-migration-ledger.md)) — only backup/PITR restores them | Not run: no staging forward repair or PITR restore; schema/config compatibility checked only (see result table) |
| 2 | Traffic-bearing production Worker deploy (`deploy-production.yml`): apex custom domain, queue consumers and crons | `rollback-production` to a recorded compatible version ID when available, then `/up` smoke (200, `db:ok`, zero pending). Code-version rollback is not DNS/data/queue recovery; see rows 3–5 | Pass on staging, 2026-10-04: `wrangler rollback` N+1 → N → N+1 with smoke before/during/after; production workflow not executed |
| 3 | DNS/public traffic to Next: apex is claimed by the deployment in row 2; www needs separate provisioning | Remove Next custom-domain attachments for the affected hosts and restore saved legacy apex/www record sets, including proxy/TTL settings. Do not re-attach Next or use the unqualified staging `wrangler triggers deploy` fallback. Executable production DNS recovery remains a reviewed operator prerequisite, not a procedure supplied here | Pass for staging flip/restoration only, 2026-10-03 18:25: `next.togetherweown.com` moved to legacy and back; legacy answered 522. Production DNS reverse not tested |
| 4 | Member-data import under paused legacy writes and a quiescent destination, verified before traffic-bearing deployment | Same-key corrections only where importer update rules permit. Wrong identities/keys, extra rows or lost overwritten state need separately approved backup/repair recovery under writer holds. Idempotent upsert is not an inverse; never perform ad hoc deletion or hand-edit the ledger | Not run: dry run failed closed; no staging import receipts. Idempotency has fixture coverage only (see result table) |
| 5 | Queue/cron activity installed by production deployment, not a later independent activation | Reviewed holds must cover producers, cron and shared-database writers; delivery pause alone does not stop them. Pause delivery to `two-web-next-production-sync-event` and `two-web-next-production-internal-action` with the authorized production principal and verify containment. Production containment/resume procedure and hold mechanism remain missing prerequisites; do not copy staging targets. Never purge, delete/recreate queues or remove consumers; resume only after implementation, holds, receiver/adapter and replay gates clear | Not run: read-only staging queue info, not production pause/resume, was recorded (see result table) |
| 6 | 48h post-flip watch ([cutover-freeze.md](cutover-freeze.md) in force) | On Sev-1: contain, then use the applicable approved code/DNS/data recovery above. The 48h clock restarts after the re-flip | Not run: no post-flip watch or watch-triggered rollback was rehearsed (see result table) |

## Pre-apply snapshot (record all six before migration or traffic changes)

1. Release SHA with exact-head green CI (`check`, `gitleaks`, `pr-lint`, `ci-ok`) plus same-SHA reviewer approval.
2. Production migration **plan** receipt identifying the target database/branch, validated journal prefix and pending web migration list. Pending migrations are expected before apply; do not require zero pending here. Independently verify history retention/PITR eligibility for the actual production provider and the approved recovery procedure before writes; a timestamp alone does not prove recoverability.
3. Worker rollback pointer: current production Worker version ID (not deployment ID), if one exists. An initial deployment needs the approved legacy recovery path rather than an invented previous version.
4. DNS inputs: saved pre-change apex/www record sets with TTL/proxy settings and custom-domain attachment inventory, plus planned targets. Observed post-change records are captured after the change, not required in this pre-change snapshot.
5. Watch roster: named primary/secondary per 12h block, pager + `/up` + after-gate cadence owners, freeze lifter.
6. Freeze posted: window from [cutover-freeze.md](cutover-freeze.md) announced on the cutover card; legacy/destination writer holds identified before import.

### Migration completion gate (after apply, before traffic-bearing deployment)

Keep the production apply/verify receipt for the release SHA and target branch.
`apply` records the pre-migration PITR timestamp immediately before mutation;
record that emitted timestamp in this receipt, not as evidence emitted by `plan`.
Successful apply/verify must establish the expected journal prefix and zero
pending web migrations before deployment. Preserve verified recovery eligibility
and writer holds through migration/import verification; neither a timestamp nor
zero pending proves that a PITR restore was tested. The CLI's historical
"Neon PITR" timestamp label does not establish recovery capability on the
production provider. No production migration or restore was performed by
this staging drill.

## Abort triggers

Abort the cutover (stop forward steps, hold position, decide rollback on
the incident card) on any of these:

- Pre-cutover: any NO-GO gate in [cutover-gates.md](cutover-gates.md), or a missing snapshot item above.
- `/up` non-200, `db:error`, or `pending_migrations` nonzero on the new target.
- Pager storm (`error.alert` / `queue.failing` delivery).
- Red after-gate (`node ci/cutover-check.mjs --phase after --target togetherweown.com --json`).
- Member-visible breakage (sign-in, profiles, RSVPs, event pages).
- During a staging drill: loss of the confirmed deploy/migration hold,
  unexpected deploy/migration activity or live schema/binding drift, any new
  deployment ID other than the two recorded rehearsal IDs, changed overlapping
  history, or baseline smoke changing mid-drill. Oldest entries rolling off
  the ten-entry history window are not a collision; missing expected IDs or
  insufficient overlap makes the evidence inconclusive, not pass.

### Staging collision response

Stop further drill mutations and preserve the evidence; do not automatically
restore the pre-drill version. With the staging release owner and authorized
migration operator, re-establish the hold and bring any in-flight deploy or
migration to a safe disposition without casually cancelling DDL. Inspect the
current serving Worker version, deployment history, live schema/applied journal
and bindings from authorized release/migration evidence. The earlier N/N+1
source diff and `/up` zero pending do not prove compatibility with a concurrent
N+2 release or its schema.

Select a compatible recovery target with the staging release owner, or use a
reviewed forward repair; keeping a healthy intervening release may be the right
disposition. Normal pre-drill restoration is permitted only with a confirmed
hold, no intervening release/schema change and verified live compatibility.
Record the collision, current state, recovery decision and result; the affected
drill is invalid or inconclusive, not a pass. Re-run only with a fresh baseline
and confirmed exclusive hold. This is staging-only and grants no production
recovery authority.

## Who calls rollback

- Staging drill: the engineer running the drill executes; no production action, ever.
- Production incident: the **DevOps & Reliability Engineer** owns
  containment, release/rollback timing and incident evidence, and calls
  the rollback (runbook ownership in [runbook.md](runbook.md)).
- Technical disputes or missing implementation escalate to the **Director
  of Engineering**; security/access or suspected leaked member data go
  through the Director to CISO.
- The **CEO** consolidates owner-reserved approvals for credential
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
| 2026-10-04 08:51–08:53 | Worker rollback `2e803af9` (487ef4a4) to `44878468` (4c65217e) and back | 4.7 s / 3.8 s commands, first request on target +5.6 s / +5.5 s, one switch each way, 0 non-200 of 100 probes, smoke 17/17 on `2e803af9`, `44878468` (49 of 49 telemetry events N) and `2e803af9` again; no deploy landed in the window; staging restored at 100% |

### Per-step result, 2026-10-04 drill (staging revision `2e803af9`)

Pass means the reverse was executed on staging and its check held (this drill,
or the dated record above). Not run means no reverse was executed; the reason
is stated and nothing is claimed.

| # | Cutover step | Result | Evidence or reason |
|---|---|---|---|
| 0 | Pre-apply snapshot | partial (staging analogue): items 1–2 partial, item 3 pass; items 4–6 not run | Item 1: deploy gate follows green exact-SHA `ci`, but no same-SHA review receipt was saved. Item 2: `/up` `db:ok`, `pending_migrations` 0 only; no migration plan receipt, pre-apply PITR timestamp or eligibility verification recorded. Item 3: `dep-before.json` saved with active version `2e803af9` and chosen N `44878468`. DNS inputs were read in the separate 2026-10-03 18:25 run, not an apex/www snapshot; roster and freeze are production-only |
| 1 | Production schema migration | not run | No harmful migration exists on staging to repair. Compatibility only: no `drizzle`, `migrations.lock`, `ci/neon-migrate.mjs` or `wrangler.jsonc` difference between N and N+1; `/up` `db:ok`, 0 pending on both. PITR is not drilled (irreversible; owner-reserved approval consolidated by the CEO) |
| 2 | Production Worker deploy | pass (staging code-version rollback only) | `wrangler rollback` N+1 → N → N+1 on `two-web-next`, 100% each time, deployments `a58f67e3` and `77c4c9b9` the only additions, final state `2e803af9`@100; smoke 17/17 before, on N, and after. The production path is the `rollback-production` workflow, which this drill does not run |
| 3 | DNS flip | pass (staging flip/restoration 2026-10-03 18:25 only; production reverse not tested) | Flip to legacy and back, marker returned at +3.2 s, stable at +14.7 s, zone clean. Caveat: the staging legacy origin answered 522, so the production legacy origin must be proven first ([runbook](runbook.md#before-the-production-flip)) |
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
- As observed on 2026-10-04, staging `e2e-staging` (Staging critical
  journeys) failed after the 08:15 and 08:29 UTC deploys; it must pass
  before the production deploy. A successful workflow with skipped
  journey jobs is not a passing journey receipt.
- Keep this record current: append each rehearsal row with timings,
  version IDs, smoke results, and discrepancies.
