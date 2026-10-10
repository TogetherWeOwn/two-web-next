# M5: post-cutover hardening milestone

Agreed definition of the post-cutover milestone, carried forward from the v8
roadmap proposal so the next roadmap run adopts it instead of re-mining settled
scope. M5 starts only after the cutover decision. Nothing in M5 touches
production data, DNS, or the flip itself.

## Entry criteria

All three hold before any M5 item is carded:

1. **Cutover decision recorded.** [cutover-gates.md](cutover-gates.md#gate-table)
   reads GO at the release head with linked receipts, and the decision is
   recorded with its [overall disposition](cutover-gates.md#overall-disposition).
   Contract: [cutover-check.md](cutover-check.md).
2. **Production Worker serving.** The production deploy receipt and public-route
   smoke are recorded per
   [runbook.md](runbook.md#deploy-and-record-the-rollback-pointer), and the
   release was cut per [releases.md](releases.md#cutting-a-release).
3. **Staging database move complete.** Staging runs on the managed Postgres
   branch: Hyperdrive repointed, migrations at zero pending, legacy database
   retired. Topology: [db-migrations.md](db-migrations.md#topology-target).

## Carried items

Each item is one PR-sized slice with its gate. None is cardable before entry.

| Item | Outcome | Gate |
|---|---|---|
| R13 — production-planner access-path proof | Prove the hot-path index set wins under the production planner, not just with forced index use | `EXPLAIN` on production-shape data without `enable_seqscan = off` shows index use on the hot shapes; the existing forced-planner proof in `../test/hot-path-indexes.test.ts` plus `../test/schema-hot-path.test.ts` stays green; deferred scope is ledger row A6 in [w15-events-acceptance-ledger.md](w15-events-acceptance-ledger.md#deferred-and-dropped-rows) |
| R18 — field-data performance budgets | Ratchet Lighthouse and bundle budgets from production field data | Confirm the Cloudflare Web Analytics RUM source first (no in-repo collector exists today: only lab Lighthouse in [performance-budgets.md](performance-budgets.md#performance-gates); edge `POST /cdn-cgi/rum` handling is documented in `../e2e/watch-guard.mjs` and collects without a Worker deploy); then two weeks of production field data collected, budgets ratcheted with CI enforcing the new ceilings |
| L7 — whole-schema retention ledger | Publish one ledger row per table: retention window, prune mechanism, proof | The `activity_log` retention decision lands first so the ledger does not ship stale; claims pinned by tests per [member-erasure.md](member-erasure.md#what-is-retained-and-why) |
| Tier-0 — report-only gates | Validator property tests, role-by-route authorization matrix, `EXPLAIN` sequential-scan check | All three run in CI report-only (`continue-on-error`); land only after production plus the 48-hour watch in [runbook.md](runbook.md#48h-post-flip-watch); flip the low-false-positive ones to required afterwards |

## Non-goals

- No production touch: no deploys, migrations, DNS edits, data imports, or
  secret changes.
- No re-planning or reassigning of existing cards; no pre-cutover items.
- No budget ratchets before production field data exists.
- No new gates invented alongside the Tier-0 work; it wires into the reusable
  Tier-0 workflow when that lands.

## Target

Two weeks after the cutover decision, except R18, which closes once its
collector has banked two weeks of production field data and so may run past
the target.
