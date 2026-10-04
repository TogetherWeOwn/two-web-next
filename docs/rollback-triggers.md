# Rollback triggers: three trips the matrix does not row

Companion to [rollback-decision-matrix.md](rollback-decision-matrix.md) —
it owns rows 1–6 (`/up` readiness, queue depth ≥ 100, red after-gate,
pager storm, Lighthouse medians, hold/exit). The three triggers below are
deliberately outside those rows. T0 is the recorded DNS-flip moment; the
freeze in [cutover-freeze.md](cutover-freeze.md) holds through rollback
and the restarted 48h clock.

## 1. Static DB-free route off its status

**Signal:** any S-class route misses its expected status: `GET /`, `/about`,
`/faq`, `/rules`, `/privacy`, `/robots.txt` not 200; `GET /discord` or
`/auth/discord` not a 302; `POST /csp-reports` not 204. A database outage
never explains an S failure — these routes stay up without the database.

**How measured:** `node bin/smoke.mjs https://togetherweown.com` (16 public
routes, same shape as the deploy smoke) plus `http.request` log rows for the
route class with `status` and `duration_ms`.

**Owner:** watcher spots it, pages DevOps & Reliability Engineer at once;
the CEO makes the rollback call.

**Rollback:** contain per [runbook.md](runbook.md#48h-post-flip-watch), then
Actions → `rollback-production` on `main` with the recorded known-good Worker
Version ID ([workflow](../.github/workflows/rollback-production.yml),
mechanics in [runbook.md](runbook.md#worker-rollback)). Equivalent CLI:
`npx --no-install wrangler rollback "$GOOD_VERSION" --name two-web-next-production`.

## 2. Queue stuck by age, or failed-history spike with errors

**Signal:** `oldest_pending_age_seconds` over 1800 s, or growing while
`pending` sits high; or `queue.failed` jumps alongside a 5xx rise or pager
burst. Depth alone is the matrix's row — this row is age and failure
evidence: old messages are not draining, or jobs are dying terminally.

**How measured:** the `/up` queue envelope (`pending`,
`oldest_pending_age_seconds`, `failed`, `warn_at`/`critical_at`) across two
consecutive polls; triage newest failed rows first per
[queue-redrive-runbook.md](queue-redrive-runbook.md). Never blind-delete
history or fabricate a replay.

**Owner:** DevOps & Reliability Engineer owns containment and timing;
technical dead-ends go to the Director of Engineering.

**Rollback:** pause delivery per the runbook queue section
([runbook.md](runbook.md#queue-containment-drain-and-failed-job-replay) —
never purge or delete queues), then the same one-click workflow and version
pointer as trigger 1. The 48h clock restarts after the re-flip.

## 3. Suspected member-data exposure in any signal

**Signal:** any hint that member data leaked or crossed accounts — wrong-user
profile content, member data in logs or traces, access-log anomalies. Privacy
outranks availability: this pages even when `/up`, gates and queues are green.

**How measured:** redacted pager receipts and log fingerprints per
[runbook-alerts.md](runbook-alerts.md); raw traces stay the private fallback.
Keep all evidence off the card — no archives or secret-bearing logs attached.

**Owner:** Director of Engineering to CISO immediately; the CEO consolidates
owner-reserved approvals. Full path:
[runbook.md](runbook.md#safety-and-escalation).

**Rollback:** same Worker rollback pointer as trigger 1, but a Worker
rollback does **not** undo data side effects — schema, rows, queue messages
and Discord actions stand. Hold writers, reconcile per the runbook, and keep
the freeze in force until the exit is recorded.
