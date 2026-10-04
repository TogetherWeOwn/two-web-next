# 48h post-flip watch: run-record sheet

Blank sheet the watch writes into. Procedure lives elsewhere; this file
records evidence only. Everything here is read-only or GET-only: no
production writes, migrations, credential changes or queue purges.

- Watch procedure and cadence:
  [runbook.md](runbook.md#48h-post-flip-watch). The first 60 minutes use
  the denser poll script in [first-hour-watch.md](first-hour-watch.md);
  record each of its checkpoints in §3 below.
- Staffing: the approved 48h roster (roles pre-filled per block in §2;
  start/end UTC are set at the CEO go). Handoffs go on the cutover card
  at T+12, T+24, T+36 and T+48.
- Pager meaning and redaction: [runbook-alerts.md](runbook-alerts.md).
  Record redacted fingerprints and classes only, never raw traces,
  tokens or member data.
- After-gate contract:
  [cutover-check.md](cutover-check.md#phase-contract-and-prerequisites).
- Freeze: [cutover-freeze.md](cutover-freeze.md) stays in force until the
  watch exits; the B4 primary records the exit and lifts the freeze.
- Escalation: seated watcher → DevOps & Reliability Engineer → Director
  of Engineering → CEO go/no-go. Host or secret steps go on an
  `Operator:` card to the CEO. On a Sev-1, contain per the runbook queue
  and outage sections, then roll back with the
  [one-click production rollback](../.github/workflows/rollback-production.yml)
  to the version ID recorded in §1. A Worker rollback undoes no schema,
  data or Discord side effects, and the 48h clock restarts after the
  re-flip.

Copy this sheet offline (print or duplicate the file) and fill it in UTC.
One row per checkpoint; a blank cell means "not yet checked", never
"checked and fine".

## 1. Flip record

Staging `/up` reports `revision.version_id`; production `/up` carries no
revision until a cutover PR declares the binding, so record both version IDs
here at flip.

| Field | Value |
| --- | --- |
| T0: DNS-flip moment (UTC) | |
| App version ID before release | |
| Tail Worker version ID before release | |
| Recorded by (role + name) | |

## 2. Shift roster and handovers

| Block | Window (T+) | Primary | Secondary | Seated names | `/up` tally (green/total) | After-gate due | Pager summary | Handoff posted (by/at) | Incoming ack |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | T+0–12 | DevOps & Reliability Engineer | QA & Release Engineer | | | +1h (primary runs, secondary witnesses) | | | |
| B2 | T+12–24 | QA & Release Engineer | Web Engineer | | | +24h at handoff (primary runs jointly with incoming B3 primary); Lighthouse + guest journeys (§6) | | | |
| B3 | T+24–36 | Founding Engineer | QA & Release Engineer | | | none (steady state) | | | |
| B4 | T+36–48 | DevOps & Reliability Engineer | Founding Engineer | | | +48h (primary runs); exit + freeze lift (§8) | | | |

Pager owner per block: the primary.

## 3. `/up` checkpoints

Cadence: every 15 minutes for the first 4h, then hourly. Green bar:
HTTP 200 with `db:ok`, `pending_migrations:0`, `X-TWO-Origin: two-web-next`
and `Cache-Control: no-store`. Warn (`pending` 20–99, transient `unknown`):
keep polling, re-check next slot. Critical (escalate per §7): any 503,
`db:error`, nonzero pending, `config:missing`, red gate, wrong origin
marker, `pending >= 100`, or `unknown` across two consecutive polls.

| Time (UTC) | HTTP | db | pending_migrations | queue.pending / status | Origin marker | Verdict | Watcher |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
| | | | | | | | |
| | | | | | | | |

## 4. After-gate checkpoints

`node ci/cutover-check.mjs --phase after --target togetherweown.com --json`
(GET-only, no database client). Full gate at flip+1h, +24h and +48h.

| Checkpoint | Time (UTC) | Result (green/red) | Run by | Notes |
| --- | --- | --- | --- | --- |
| +1h | | | | |
| +24h | | | | |
| +48h | | | | |

## 5. Pager watch (one row per block)

- Q1 source-log filter (`error.alert` / `queue.failing` tail lines).
  Expected baseline in a healthy window: zero lines; each line is one
  page candidate.
- Q2 delivery receipts (`ops.alert.delivered` / `ops.alert.delivery_failed`).
  Expected: one `delivered` per source line; `delivery_failed` means the
  Discord POST failed and the event is not durably retried.
- `uptime.down` pages come from the Tail Worker's own prober and have no
  source-log line by design; they still produce delivery receipts caught
  by Q2.
- Read mute-aware: five-minute source + Tail mutes per fingerprint, so
  silence after a page can mean muted, not fixed. Duplicates across
  isolates are possible.

| Block | Q1 lines | Q2 delivered / failed | `uptime.down` pages | Notes |
| --- | --- | --- | --- | --- |
| B1 | | | | |
| B2 | | | | |
| B3 | | | | |
| B4 | | | | |

## 6. Lighthouse + guest journeys (once within first 24h; B2 owns)

- Lighthouse against the production origin, held to the repo thresholds
  in [ci/lighthouserc.cjs](../ci/lighthouserc.cjs); thresholds are never
  relaxed to turn a build green.
  Run `npm run lighthouse:origin -- https://togetherweown.com` or dispatch
  [watch-lighthouse](../.github/workflows/watch-lighthouse.yml); record
  the run URL and the per-route verdicts from its summary below.
- Playwright GET-only guest journeys: homepage, static leaves, events
  list, one published event, robots/sitemap. No sign-in, no RSVP, no
  join, no writes of any kind.
  Run via the dispatch-only
  [watch-guest-journeys](../.github/workflows/watch-guest-journeys.yml)
  workflow (`e2e/watch/`, origin input `https://togetherweown.com`) and
  record the run URL in the table below.

| Check | Time (UTC) | Result | Within budget |
| --- | --- | --- | --- |
| Lighthouse | | | |
| Guest journeys | | | |

## 7. Escalation log

| Time (UTC) | Raised by | Signal | Escalated to (owner) | Outcome / decision |
| --- | --- | --- | --- | --- |
| | | | | |
| | | | | |

## 8. Go/no-go annotations

A block exits green only if ALL hold for its span: pager quiet
(mute-aware), `/up` green throughout, after-gate green where due,
journeys within budget where due. Any Sev-1 (pager storm, `/up` non-200
or `db:error`/pending nonzero, red after-gate, member-visible breakage):
contain, roll back, clock restarts.

| Block | Exit verdict | Notes |
| --- | --- | --- |
| B1 | | |
| B2 | | |
| B3 | | |
| B4 | | |
| Final 48h exit | | Exit recorded on the cutover card; freeze lifted by B4 primary |
