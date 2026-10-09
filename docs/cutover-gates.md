# Production cutover go/no-go gates — snapshot

Snapshot taken 2026-10-09 ~17:20 UTC at `main`
`5d1a3977211180cdd45ee06aee46fe088cd3e9f4`, from public repo state only;
all six gates re-checked against the evidence links below at that SHA.
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
| 1 | Release PRs: exact-head green CI (`check`, `gitleaks`, `pr-lint`) + independent review on the same head | QA & Release Engineer (CI baseline) + Code Reviewer (exact-head approval); Director of Engineering owns merge readiness | **NO-GO** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: release PR [#28](https://github.com/TogetherWeOwn/two-web-next/pull/28) is closed (published `v0.3.0` 2026-10-05) and no open release PR was found on the re-check; `main`-head `ci` [succeeded](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37947075057) on `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`, which proves `main` green, not a release-vehicle receipt. Cut procedure: [releases.md](releases.md#cutting-a-release) | Regenerate the release PR from current `main` under a short freeze, get green `check`/`gitleaks`/`pr-lint` plus same-SHA reviewer approval, then reviewer squash-merges |
| 2 | Staging smoke evidence current (deploy pipeline + public-route smoke on the candidate) | DevOps & Reliability Engineer (staging deploy) + QA & Release Engineer (smoke evidence) | **GO (staging only)** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: staging `deploy` workflow [succeeded 2026-10-09](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37948781326) on head `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`, and `e2e-staging` [succeeded 2026-10-09](https://github.com/TogetherWeOwn/two-web-next/actions/runs/37950227862) on the same head; the deploy path ends with `bin/smoke.mjs` public-route smoke plus the JSON contract probe against `https://next.togetherweown.com` (see [runbook deploy section](runbook.md#deploy-and-record-the-rollback-pointer)). This proves staging liveness, not production readiness or DB/schema acceptance | Keep one fresh staging deploy + smoke inside the decision window on the release-candidate head; attach its workflow URL and `/up` output to the release record |
| 3 | Production database receipt (provisioned target, zero-pending migration proof, backup/PITR eligibility recorded) | DevOps & Reliability Engineer (migration + backup execution); CEO consolidates owner-reserved approvals | **NO-GO** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: no production migration `apply`/`verify` receipt, no pre-apply PITR timestamp, no production backup object exists yet — unverified (operator). Target decided: PlanetScale Postgres HA PS-10, AWS `us-east-1`, PG17; staging Neon + production PlanetScale topology in [db-migrations.md](db-migrations.md#topology-target). `migrations.lock` is history reservation only, not an apply receipt | Separately authorized production `db-migrate` run (zero pending, PITR timestamp saved) plus first production backup + restore-into-scratch proof before any flip decision |
| 4 | DNS TTL lowered + flip inputs verified (apex/www records, custom-domain attachment, resolver behavior) | DevOps & Reliability Engineer via authorized Operator step | **NO-GO** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: no TTL-lowering receipt found in repo or runs; production apex/www TTLs and flip inputs are unverified (operator). The runbook notes proxied records use `ttl` 1 (auto) and the flip depends on edge-config apply, not resolver expiry — see [staging rehearsal intro](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back). The staging DNS flip to legacy and back ran on 2026-10-03 (see the [rehearsal record](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back)), so the mechanism is proven on staging; production inputs are still unrecorded | Operator records current apex/www TTLs, lowers them per the cutover plan, and posts the before/after record sets with timestamps |
| 5 | Rollback rehearsed (Worker rollback both directions; DNS flip-back) | DevOps & Reliability Engineer | **GO on staging rehearsal evidence; DevOps to confirm** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: no newer rehearsal found in repo; standing staging receipts in the [rehearsal record](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back): Worker half most recently 2026-10-04 08:51–08:52 UTC (rollback 4.7 s / 5.6 s settled, roll-forward 3.8 s / 5.5 s, 0 non-200 of 100 probes, smoke 17/17 throughout), preceded by 2026-10-03 20:36–20:37 UTC (3.7 s / 3.8 s commands, one switch each way, 0 non-200 of 137 probes) and 16:35–16:36 UTC runs. The DNS flip to legacy and back ran 2026-10-03 18:25 UTC on staging only (flip 1.6 s, marker gone +1.2 s; flip back 2.1 s, marker back +3.2 s, stable +14.7 s; smoke 16/16 before and after; zone clean). Open observation: the staging legacy origin answered 522 for `next.*` in the flip window | Before the production flip, confirm the production legacy origin answers the apex (runbook, [Before the production flip](runbook.md#before-the-production-flip)); DevOps confirms the gate state |
| 6 | 48h watch roster staffed (named owners, cadence, exit criteria, freeze lift) | Director of Engineering (staffing) + DevOps & Reliability Engineer (watch execution) | **NO-GO** | At `main` `5d1a3977211180cdd45ee06aee46fe088cd3e9f4`: freeze window is still `2026-10-14 00:00 UTC` to `2026-10-18 00:00 UTC` with announcement drafts in [cutover-freeze.md](cutover-freeze.md), drafts merged in [#415](https://github.com/TogetherWeOwn/two-web-next/pull/415), and watch procedure defined in [runbook 48h watch](runbook.md#48h-post-flip-watch) — but no named roster or shift plan is posted. Prior watch-link cleanup in [#417](https://github.com/TogetherWeOwn/two-web-next/pull/417) removed private tracker links from the watch set | Staff named primary/secondary per 12h block, pager + `/up` + after-gate cadence owners, and the freeze-lift poster; post the roster on the cutover decision record |

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
