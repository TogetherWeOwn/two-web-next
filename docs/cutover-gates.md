# Production cutover go/no-go gates — closed

Record closed 2026-10-31 at `main`
`47dd89b885ff0d9ef78edeeb72ec0caed211e5b2`, from public repo state only.
**The production cutover is complete.** The apex `togetherweown.com` has
served the production Worker (`two-web-next-production`) since the DNS flip
at 2026-10-10 00:52 UTC. The 48h post-flip watch ran to 2026-10-12 00:52 UTC,
and the cutover closed on 2026-10-12.

This file is a historical record, not an authorization to flip DNS, migrate
data, or deploy. Nothing here was probed: every production fact below is
cited from a receipt already recorded in this repository. Operator receipts
that are not in this repository (DNS record sets, roster names, backup
objects) stay on the cutover card in the team tracker.

Contract: [cutover-check.md](cutover-check.md) (before/after gates),
[cutover-migration-ledger.md](cutover-migration-ledger.md) (production apply
outcome), [runbook.md](runbook.md) (rollback, 48h watch),
[releases.md](releases.md) (release mechanics), [parity.md](parity.md)
(legacy parity matrix). The pre-flip snapshot (taken 2026-10-11 at `main`
`4c211e66`, public repo state only) is in this file's git history.

## Gate table

| # | Gate | Owner (agent role) | Final state | Evidence | Follow-up |
|---|---|---|---|---|---|
| 1 | Release vehicle: a staging-verified commit with green required checks is promoted to production | QA & Release Engineer + Director of Engineering | **GO (closed)** | Production flipped to the release at `15423dc9` on 2026-10-10 00:52Z ([migration ledger](cutover-migration-ledger.md#production-apply-outcome)). The flip predates the `v1.0.0` tag, which was cut later on `754b10b3` (2026-10-18). Later releases follow the promote flow in [releases.md](releases.md#cutting-a-release) | None. Each later promote follows the release contract |
| 2 | Staging smoke evidence current (deploy pipeline + public-route smoke on the candidate) | DevOps & Reliability Engineer + QA & Release Engineer | **GO (closed)** | The staging deploy path still runs `bin/smoke.mjs` and `bin/json-smoke.mjs` on every deploy ([runbook deploy section](runbook.md#deploy-and-record-the-rollback-pointer)); every production promote needs green `main` CI on the exact SHA. The repo variable `PRODUCTION_AUTO_APPROVE` picks the approval path: when it is `true`, the gate requires exact-SHA `deploy` and `e2e-staging` evidence instead of a human Environment review, for automatic and manual promotes alike; with any other value, the gate refuses automatic promotes, and a manual promote needs the human review and skips the staging-evidence check ([production deploy gate](../ci/production-deploy-gate.mjs)) | None. Staging smoke is a standing deploy gate |
| 3 | Production database receipt (target, zero-pending migration proof, backup/PITR) | DevOps & Reliability Engineer; CEO for owner-reserved approvals | **GO (closed)** | Production `/up` reported healthy with `db ok` and **0 pending migrations** at the flip, and stayed at 0 pending through the 2h watch close (02:52Z) and the 48h close (2026-10-12 00:57Z) ([migration ledger](cutover-migration-ledger.md#production-apply-outcome)). Backup and PITR receipts are on the cutover card, not in this repository | Later migrations reach production through the `db-migrate` workflow ([migration ledger](cutover-migration-ledger.md#gated-apply-path)) |
| 4 | DNS flip inputs verified (apex/www records, custom-domain attachment) | DevOps & Reliability Engineer via authorized Operator step | **GO (closed)** | The apex has served the production Worker since 2026-10-10 ([runbook](runbook.md)). The before/after record sets are on the cutover card, not in this repository | DNS recovery to legacy follows the [recovery map](cutover-rollback.md#staging-dns-restoration-and-import-recovery-limits) |
| 5 | Rollback rehearsed (Worker rollback both directions; DNS flip-back) | DevOps & Reliability Engineer | **GO (closed)** | Staging Worker rollback and DNS flip-back rehearsals are recorded in the [rehearsal record](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back). Production Worker rollback uses the [production rollback workflow](../.github/workflows/rollback-production.yml) | None |
| 6 | 48h watch staffed and run (owners, cadence, exit criteria) | Director of Engineering + DevOps & Reliability Engineer | **GO (closed)** | The 48h watch ran 2026-10-10 00:52 UTC to 2026-10-12 00:52 UTC ([runbook 48h watch](runbook.md#48h-post-flip-watch), [archived freeze note](cutover-freeze.md)). The early-watch sign-in errors came from host role grants and recovered within the watch ([migration ledger](cutover-migration-ledger.md#production-apply-outcome)) | None. The watch section stays as the procedure for any re-flip |

## Overall disposition

**GO, and complete: the production cutover closed on 2026-10-12.**

Evidence: production `/up` healthy with `db ok` and 0 pending migrations from
the flip through the 48h close, and the [parity matrix](parity.md) at **0
unmapped rows** (every legacy row is ✅, names its card, or is dropped with a
reason). Production now changes only through the gated promote, rollback and
`db-migrate` workflows described in [README.md](../README.md) and
[runbook.md](runbook.md).
