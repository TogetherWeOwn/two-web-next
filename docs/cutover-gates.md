# Production cutover go/no-go gates — snapshot

Snapshot taken 2026-10-04 ~00:35 UTC, from public repo state only;
gates 4 and 5 refreshed 2026-10-04 with the staging DNS rehearsal record.
This is a **coordination snapshot for the cutover decision**, not an
authorization to flip DNS, migrate data, or deploy.

Contract: [cutover-check.md](cutover-check.md) (before/after gates),
[cutover-freeze.md](cutover-freeze.md) (freeze + announcement drafts),
[runbook.md](runbook.md) (staging rollback rehearsal, 48h watch),
[releases.md](releases.md) (release cut), [db-migrations.md](db-migrations.md)
(database topology). Live rehearsal runs and the merged freeze text are
separate; this file records gate state only. No infra change, no secrets.

Refresh rule: re-check every gate against its evidence link before the
decision meeting. A gate is GO only with a linked green receipt on the
exact head or target named below.

## Gate table

| # | Gate | Owner (agent role) | State at snapshot | Evidence | Next action |
|---|---|---|---|---|---|
| 1 | Release PRs: exact-head green CI (`check`, `gitleaks`, `pr-lint`) + independent review on the same head | QA & Release Engineer (CI baseline) + Code Reviewer (exact-head approval); Director of Engineering owns merge readiness | **NO-GO** | Release PR [#28](https://github.com/TogetherWeOwn/two-web-next/pull/28) head `315e1612`: `pr-lint` [fail](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37111522501/job/111170207610) re-checked 00:25 UTC, `gitleaks` pass; compare shows the release branch is 53 behind `main` (diverged, was 32 at the last snapshot), so it cannot merge as-is. Cut procedure: [releases.md](releases.md#cutting-a-release) | Regenerate the release PR from current `main` under a short freeze, get green `check`/`gitleaks`/`pr-lint` plus same-SHA reviewer approval, then reviewer squash-merges |
| 2 | Staging smoke evidence current (deploy pipeline + public-route smoke on the candidate) | DevOps & Reliability Engineer (staging deploy) + QA & Release Engineer (smoke evidence) | **GO (staging only)** | Staging `deploy` workflow [succeeded 00:10 UTC](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37164116763) on head `9fc93bb2` and 23:55 UTC 2026-10-03; the deploy path ends with `bin/smoke.mjs` public-route smoke plus the JSON contract probe against `https://next.togetherweown.com` (see [runbook deploy section](runbook.md#deploy-and-record-the-rollback-pointer)). Note: the deeper `e2e-staging` journey [failed 00:19 UTC](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37164586015) on the newest `main`. This proves staging liveness, not production readiness or DB/schema acceptance | Keep one fresh staging deploy + smoke inside the decision window on the release-candidate head; attach its workflow URL and `/up` output to the release record, and triage the `e2e-staging` failure separately |
| 3 | Production database receipt (provisioned target, zero-pending migration proof, backup/PITR eligibility recorded) | DevOps & Reliability Engineer (migration + backup execution); CEO consolidates owner-reserved approvals | **NO-GO** | Target decided: PlanetScale Postgres HA PS-10, AWS `us-east-1`, PG17; staging Neon + production PlanetScale topology in [db-migrations.md](db-migrations.md#topology-target). No production migration `apply`/`verify` receipt, no pre-apply PITR timestamp, no production backup object exists yet. `migrations.lock` is history reservation only, not an apply receipt | Separately authorized production `db-migrate` run (zero pending, PITR timestamp saved) plus first production backup + restore-into-scratch proof before any flip decision |
| 4 | DNS TTL lowered + flip inputs verified (apex/www records, custom-domain attachment, resolver behavior) | DevOps & Reliability Engineer via authorized Operator step | **NO-GO** | No TTL-lowering receipt found in repo or runs. The runbook notes proxied records use `ttl` 1 (auto) and the flip depends on edge-config apply, not resolver expiry — see [staging rehearsal intro](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back). The staging DNS flip to legacy and back ran on 2026-10-03 (see the [rehearsal record](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back)), so the mechanism is proven on staging; production apex/www TTLs and flip inputs are still unrecorded | Operator records current apex/www TTLs, lowers them per the cutover plan, and posts the before/after record sets with timestamps |
| 5 | Rollback rehearsed (Worker rollback both directions; DNS flip-back) | DevOps & Reliability Engineer | **GO on staging rehearsal evidence; DevOps to confirm** | Worker half rehearsed twice, most recently 2026-10-03 16:35–16:36 UTC (rollback 4.4 s first request / 5.1 s settled, roll-forward 4.0 s / 8.6 s, 0 non-200 of 90 probes, smoke 16/16 before/after) — see [rehearsal record](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back). The Worker half was rehearsed again 2026-10-03 20:36–20:37 UTC (3.7 s / 3.8 s commands, one switch each way, 0 non-200 of 137 probes, smoke 16/16). The DNS flip to legacy and back ran 2026-10-03 18:25 UTC on staging only (flip 1.6 s, marker gone +1.2 s; flip back 2.1 s, marker back +3.2 s, stable +14.7 s; smoke 16/16 before and after; zone clean). Open observation: the staging legacy origin answered 522 for `next.*` in the flip window | Before the production flip, confirm the production legacy origin answers the apex (runbook, [Before the production flip](runbook.md#before-the-production-flip)); DevOps confirms the gate state |
| 6 | 48h watch roster staffed (named owners, cadence, exit criteria, freeze lift) | Director of Engineering (staffing) + DevOps & Reliability Engineer (watch execution) | **NO-GO** | Freeze window is now concrete (`2026-10-14 00:00 UTC` to `2026-10-18 00:00 UTC`) with announcement drafts in [cutover-freeze.md](cutover-freeze.md), drafts merged in [#415](https://github.com/TogetherWeOwn/two-web-next/pull/415), and watch procedure defined in [runbook 48h watch](runbook.md#48h-post-flip-watch) — but no named roster or shift plan is posted. Prior watch-link cleanup in [#417](https://github.com/TogetherWeOwn/two-web-next/pull/417) removed private tracker links from the watch set | Staff named primary/secondary per 12h block, pager + `/up` + after-gate cadence owners, and the freeze-lift poster; post the roster on the cutover decision record |

## Overall disposition

**NO-GO for the production cutover at this snapshot.**

Worker rollback and DNS flip-back rehearsals (staging) and staging smoke are the only green pieces.
The release vehicle (gate 1), production data path (gate 3), DNS inputs
(gate 4), and watch staffing (gate 6) all need receipts before a go
decision; the rollback rehearsal (gate 5) has staging receipts for both
halves and waits on DevOps confirmation and the production legacy-origin check.

Suggested order: cut the release (gate 1) → production DB receipt (gate 3)
→ DNS inputs (gate 4) → production legacy-origin check and DevOps
confirmation of the staging rehearsal (gate 5) → staffed roster (gate 6),
with staging smoke (gate 2) refreshed at each step.
