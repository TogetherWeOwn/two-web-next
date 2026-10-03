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
| 2026-10-03 20:36–20:37 | Worker rollback and roll-forward (deployment annotations on staging list) | both directions recorded; staging restored to pre-rehearsal version at 100% |
| 2026-10-03 ~22:30 | Rehearsal scoping for this card: staging `/up` 200 `db:ok` 0 pending, staging idle (no `ci`/`deploy` in flight on `main`), Worker at merge-deploy version | Worker half already receipted twice same-day; DNS half still pending DNS-edit principal |
| pending | DNS flip to legacy and back | needs a DNS-edit principal |

## Follow-ups

- Run the DNS half with a DNS-edit principal, or record a decision
  accepting the unrehearsed DNS path with compensating controls.
- Keep this record current: append each rehearsal row with timings,
  version IDs, smoke results, and discrepancies.
