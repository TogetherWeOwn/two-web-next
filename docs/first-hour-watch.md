# First-hour post-flip watch: poll script + escalation ladder

Read-only watch for the first 60 minutes after the DNS flip. No alert
re-fire, no production writes, migrations, credential changes or queue
purges. Production cutover execution and DNS changes stay in the
separately approved operator procedure; this file only scripts the
read-only polls, the warn/critical values and who calls whom.

For the rest of the watch, hand off to the 48h section in
[runbook.md](runbook.md#48h-post-flip-watch). For the freeze, see
[cutover-freeze.md](cutover-freeze.md). For the full gate contract, see
[cutover-check.md](cutover-check.md#phase-contract-and-prerequisites).
For `/up` semantics, see the readiness section in
[runbook.md](runbook.md#read-up-without-mistaking-liveness-for-readiness).
Contract source: [`src/up.ts`](../src/up.ts).

## What to poll

Poll the apex only (`https://togetherweown.com`). Every poll is
unauthenticated GET. OAuth start/callback routes can record
throttles, so run the checker only inside this watch, never as a
casual probe.

**A. `GET /up` on the apex** — readiness, not just liveness:

- HTTP status: 200 means DB/schema ready (`db: "ok"`,
  `pending_migrations: 0`, no `config: "missing"`). Anything else is a
  503 readiness failure, even when the queue looks fine.
- Identity: `X-TWO-Origin: two-web-next` and `Cache-Control: no-store`.
  A missing Next marker, or the legacy marker, means traffic has not
  flipped or has flipped back.
- Body: top-level `status`, `db`, `pending_migrations`, optional
  `config`, plus the queue envelope (`queue.status`,
  `queue.pending`, `queue.delayed`, `queue.reserved`, `queue.total`,
  `queue.failed`, `queue.oldest_pending_age_seconds`, `warn_at`,
  `critical_at`).

**B. Cutover-check after-phase rows** (subset per poll; full gate at
checkpoints):

- Apex `/up` identity row (same as A, via the checker).
- Apex HTTPS direct 200.
- HTTP apex, HTTP/www and HTTPS/www: 301/308 directly to the HTTPS
  apex, preserving path and query.
- One frozen guest URL + one retired URL status (explicit per-route
  statuses; retired diagnostics such as `/health`, `/healthz`,
  `/db-ping` must stay 404 and never return 200 or redirect to `/up`).
- Robots/sitemap/canonical rows only at the full-gate checkpoints
  (crawlable apex, no indexing prohibition on target public HTML,
  universal noindex still on archive HTML).

## Warn/critical values

`warn_at: 20`, `critical_at: 100` are reported thresholds from
`src/up.ts` (`QUEUE_WARN_AT`, `QUEUE_CRITICAL_AT`). The implementation
has **no separate critical status**: `pending >= 20` (including
`>= 100`) reports `degraded`, never down.

| Signal | Warn | Critical (escalate) |
| --- | --- | --- |
| `queue.pending` | `>= 20`: `queue.status` `degraded`, HTTP still 200 when DB/schema ready | `>= 100`: still `degraded`/200; treat as critical backlog, escalate per ladder below |
| `queue.status` `unknown` (all six measurements `null`) | Ledger unreadable or unconfigured; lack of evidence, not recovery | Escalate if it persists across two consecutive polls |
| HTTP 503, `db: "error"`, `pending_migrations` nonzero/non-null, or `config: "missing"` | n/a — always critical | Immediate escalation; readiness failure, not queue lag |
| After-gate red, wrong `X-TWO-Origin`, redirect or frozen/retired row mismatch | n/a — always critical | Immediate escalation |
| `failed`, `delayed`, `reserved`, `total` alone | Never degrade health by themselves; watch `pending` and `oldest_pending_age_seconds` instead | — |

## Cadence: first 60 minutes

T0 is the recorded DNS-flip moment. This dense cadence supersedes the
48h cadence (`/up` every 15 min) for the first hour only.

| Time | Poll |
| --- | --- |
| T+0 | Baseline: `GET /up` + full after-gate, save JSON + timestamp |
| T+2, +4, +6, +8, +10 | Lightweight: `GET /up` + apex HTTPS + one redirect spot-check |
| T+5 (between) | Full after-gate |
| T+15, +20 | Lightweight: `GET /up` + redirect spot-check + one frozen/retired URL |
| T+30 | Full after-gate + `GET /up` |
| T+45 | Lightweight: `GET /up` + redirect spot-check |
| T+60 | Full after-gate + `GET /up`; hand off to the 48h cadence |

Read-only commands (no mutation, no credentials):

```bash
(
  set -euo pipefail
  curl -sS -D - --max-time 10 -o /tmp/up-t0.json https://togetherweown.com/up
  node ci/cutover-check.mjs --phase after --target togetherweown.com --json
)
```

Preserve the JSON plus timestamp for each checkpoint invocation.

## Who watches

One seated watcher owns the clock for the hour and runs every poll
above. Staff the seat from the approved 48h roster; do not leave the
hour unowned. The watcher records UTC time, polled revision, `/up`
status/queue values and gate outcome per checkpoint, and calls the
ladder below. The watcher never live-fixes, purges queues, rotates
secrets or runs migrations.

## Escalation ladder

1. **Watcher** sees warn/critical per the table above. On warn
   (`pending 20–99`, transient `unknown`): keep polling, note it in
   the watch log, re-check on the next cadence slot.
2. **Watcher → DevOps & Reliability Engineer** on any critical:
   503/readiness failure, `pending >= 100`, `unknown` across two
   polls, red after-gate, wrong origin marker, or member-visible
   breakage. DevOps owns containment, release/rollback timing and
   incident evidence per [runbook.md](runbook.md#safety-and-escalation).
   Technical dead-ends go to the Director of Engineering; suspected
   leaked member data goes through the Director to CISO.
3. **DevOps → CEO go/no-go.** The CEO makes the rollback call and
   consolidates owner-reserved approvals (credential rotation/deletion,
   new spend, irreversible data recovery). Do not route ordinary gaps
   to the owner.

## Rollback cross-ref

On a Sev-1 (pager storm, `/up` non-200 or `db:error`/pending nonzero,
a red after-gate, or member-visible breakage): contain per the queue
and outage sections in [runbook.md](runbook.md#queue-containment-drain-and-failed-job-replay),
then roll back with the one-click production rollback workflow to the
version ID recorded before the release
([runbook.md](runbook.md#production-one-click-workflow)). A Worker
rollback does not undo schema, data or Discord side effects. The 48h
clock restarts after the re-flip.
