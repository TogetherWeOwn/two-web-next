# Rollback decision matrix (48h watch one-pager)

Execute, don't debate. T0 is the recorded DNS-flip moment. The freeze in
[cutover-freeze.md](cutover-freeze.md) stays in force until the watch exits.
Full gate contract: [cutover-check.md](cutover-check.md).
First-hour cadence and ladder: [first-hour-watch.md](first-hour-watch.md).
Rollback mechanics: [runbook.md](runbook.md) (Worker rollback, 48h watch).

## Decide in one row

| # | Signal (apex `https://togetherweown.com`) | Verdict | Action |
| --- | --- | --- | --- |
| 1 | `/up` non-200, `db:"error"`, `pending_migrations` nonzero, `config:"missing"`, or wrong `X-TWO-Origin` on any poll | **ROLL BACK** | Contain per runbook queue/outage sections, then roll back (below). No live fix first. |
| 2 | `queue.pending >= 100`, or `queue.status` `unknown` across 2 consecutive polls | **ROLL BACK** | Same as 1. Still `degraded`/200 at this level — do not read HTTP 200 as healthy. |
| 3 | After-gate red (checker exit 1, any finding) at a checkpoint, or member-visible breakage (login, profiles, RSVPs, join) | **ROLL BACK** | Same as 1. |
| 4 | Pager storm (`error.alert` / `queue.failing` firing continuously) or Lighthouse `server-response-time` median > 600 ms / LCP > 2000 ms with member impact | **ROLL BACK** | Same as 1. |
| 5 | `queue.pending 20–99`, transient `unknown` on a single poll, or isolated warn-level Lighthouse miss with no member impact | **HOLD** | Keep polling at cadence; log it; re-check next slot. Escalate only if it persists or worsens. |
| 6 | None of the above for the full 48h; gates green at flip+1h, +24h, +48h | **FORWARD-FIX / EXIT** | DevOps records the exit on the cutover card and lifts the freeze. Minor issues go to normal cards, never to a live fix during the watch. |

Borderline between 4/5 or 3/5: treat as the higher row. When in doubt, roll back — the 48h clock restarts after the re-flip.

## Who decides

1. **Watcher** (seated, named on the roster): polls, logs, calls row 5 a hold, escalates rows 1–4 at once. Never live-fixes, purges queues, rotates secrets, or runs migrations.
2. **DevOps & Reliability Engineer**: owns containment, rollback timing, and evidence. Technical dead-ends go to the **Director of Engineering**; suspected leaked member data goes through the Director to the **CISO**.
3. **CEO makes the rollback call** and consolidates owner-reserved approvals (credential rotation/deletion, new spend, irreversible data recovery). Never route ordinary gaps to the owner.

## How to roll back

- **Worker (primary):** Actions → `rollback-production` → Run workflow on `main`, `version_id` = the known-good Worker Version ID recorded before the release. Workflow: [.github/workflows/rollback-production.yml](../.github/workflows/rollback-production.yml). Equivalent CLI: `npx --no-install wrangler rollback "$GOOD_VERSION" --name two-web-next-production`. Record rollback deployment + version IDs; keep the release workflow from redeploying the bad head.
- **DNS flip-back:** production DNS moves only under the separately approved operator procedure on the cutover card — this page does not authorize it. Reference: staging flip-back rehearsal steps in runbook.md. DNS fact: apex records are proxied with `ttl` 1 (auto); propagation follows Cloudflare edge application, not resolver TTL expiry.
- **Data-freeze/import note:** a Worker rollback does **not** undo schema, data, queue messages, or Discord side effects. Check schema compatibility first; the freeze (no profile/event edits, no merges except the cutover release and Director-approved Sev-1 fixes) holds through rollback and the restarted 48h clock.
