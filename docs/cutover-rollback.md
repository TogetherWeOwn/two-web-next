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
- Out of scope (needs a DNS-edit principal): DNS flip to the legacy
  target and back. The deploy credential has no DNS edit, so the DNS
  half stays pending until an authorized operator runs it per
  [runbook.md](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back).

## Ordered revert steps (staging rehearsal)

1. Confirm staging is idle: no `ci` or `deploy` run queued, pending,
   or in progress on `main` (Actions page or REST API). A merge
   deploy during the rehearsal overwrites the rollback.
2. Record the rollback pointer: save `wrangler deployments list
   --name two-web-next --json` and note the active (N+1) version ID
   plus the chosen known-good N version ID. Prefer the newest N
   whose sources differ on a public route; adjacent versions are
   often code-identical after workflow-only merges.
3. Baseline: run the 16-route staging smoke
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
  expiry.
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
on staging or proved by a green workflow receipt; the drill log below
records pass/fail per step. A Worker rollback never undoes schema, data,
Discord side effects, queue messages or external-resource changes.

| # | Forward step | Reverse (backout) | How the reverse is tested |
|---|---|---|---|
| 0 | Pre-cutover snapshot (checklist below) | Snapshot is read-only; no reverse. A missing item aborts the cutover | Staging drill records all four snapshot items |
| 1 | Production schema migration (`db-migrate.yml`, target production) | Reviewed forward repair first. PITR restore only with CEO approval: migrations `1017` and `1019` are unmeasurable (see [cutover-migration-ledger.md](cutover-migration-ledger.md)) — only backup/PITR restores them | Staging drill: staging apply receipt + forward-repair path; PITR eligibility verified, never executed against staging data |
| 2 | Production Worker deploy (`deploy-production.yml`) | One-click `rollback-production` workflow to the recorded version ID, then `/up` smoke (200, `db:ok`, zero pending) | Staging drill: `wrangler rollback` N+1 → N → N+1 with smoke before/during/after |
| 3 | DNS flip apex/www to Next | Flip back to the legacy target: delete the flip records, re-attach the custom domain (`PUT /accounts/.../workers/domains`); `wrangler triggers deploy` fallback re-applies the domain from `wrangler.jsonc` | Staging drill: DNS flip to legacy and back on `next.togetherweown.com` |
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

- Staging drill: the Web Engineer on this card executes; no production action, ever.
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

## Drill log

Each drill names the staging revision (Worker N+1 version ID), tests
every reverse step in the map above, and records pass/fail per step.
Staging only: host `next.togetherweown.com`, Worker `two-web-next`.
Never run these steps against `togetherweown.com`, `www`, or
`two-web-next-production`.

| Date (UTC) | Staging revision (N+1) | Snapshot | Worker N+1→N | Worker N→N+1 | Smoke before/during/after | DNS flip-back | Discrepancies |
|---|---|---|---|---|---|---|---|
| 2026-10-02 00:53–00:55 | `62871bf4` | pass (idle, smoke 16/16, pointer recorded) | pass (5.2 s, 0 non-200 of 150) | pass (5.5 s, 0 non-200 of 90) | pass (HEAD smoke; N's own smoke clean) | not run | adjacent versions code-similar; only telemetry proves the switch |
| 2026-10-03 16:35–16:36 | `81da0f67` (c07ad6b) → N `cd470835` (4b12bef, five back) | pass (idle, smoke 16/16, pointer recorded) | pass (4.4 s cmd, settled 5.1 s, 0 non-200 of 48) | pass (4.0 s cmd, settled 8.6 s, 0 non-200 of 42) | pass (16/16 × 3, all-N telemetry in N window) | not run | roll-forward alternated 2.6 s; plain-HTTP discriminator `/e/<lowercase ULID>` 404 on N / 301 on N+1 |
| 2026-10-03 20:36–20:37 | (deployment annotations on staging list) | pass | pass (both directions recorded) | pass | pass (staging restored at 100%) | not run | none |
| pending | this card | | | | | needs a DNS-edit principal | Worker half receipted three times; DNS half never run with an authorized operator |

## Follow-ups

- Run the DNS half with a DNS-edit principal, or record a decision
  accepting the unrehearsed DNS path with compensating controls.
- Keep this record current: append each rehearsal row with timings,
  version IDs, smoke results, and discrepancies.
