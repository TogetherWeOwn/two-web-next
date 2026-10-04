# Cutover go/no-go checklist (one-pager, docs-only)

Decision aid for the production cutover GO. This ships no code, runs no
probe, and authorizes no DNS flip, deploy, migration, or credential step.
Execution stays in the separately approved operator procedure. Overall
rule: **all five gates GO, else NO-GO.** The CEO owns the final GO;
each gate names the role that owns its verdict.

Conventions: T0 is the recorded DNS-flip moment. "Recorded evidence"
means JSON plus timestamp, version ID, or redacted receipt already on
file — never a claim from a merged PR, a local selftest, or a dry run.

| # | Gate | GO (all must hold) | NO-GO / unknown | Recorded evidence (2026-10-04) | Verdict owner |
| --- | --- | --- | --- | --- | --- |
| 1 | Apex marker + 301 (before-gate) | Live `before` gate green on the candidate: apex `/up` carries the legacy marker, candidate `/up` carries `X-TWO-Origin: two-web-next` with `no-store`, and HTTP apex, HTTP/www, HTTPS/www each answer 301/308 straight to the HTTPS apex preserving path/query. JSON + timestamp preserved. | Any finding, any missing legacy marker, any non-301/308, or no live run on the candidate — including a green local selftest alone. | Checker contract in [cutover-check.md](cutover-check.md#phase-contract-and-prerequisites). No live before-gate run on the candidate is on file; selftests are loopback-only by design. → **NO-GO / unknown.** | DevOps & Reliability Engineer (gate verdict); CEO (GO). |
| 2 | Staging E2E green on candidate | `e2e-staging` green on the exact candidate SHA against `next.togetherweown.com`: QA sign-in, events list, fixture RSVP round-trip, keyboard profile edit, moderator draft/cancel, with fixtures cancelled in `finally`. | Any red journey, any run on a different SHA, or CI-only (`e2e.yml`) green standing in for staging. | Journeys and evidence bar in [critical-journeys.md](critical-journeys.md#staging-post-deploy-journeys). No candidate-linked green staging run is on file. → **NO-GO / unknown.** | QA & Release Engineer (journey verdict); CEO (GO). |
| 3 | Rollback target provable | Known-good Worker Version ID recorded before the release **and** the staging rehearsal proves the pointer works: telemetry `served_versions` shows the switch, both smokes match baseline, both rehearsal deployments listed with no deploy in between. | No recorded version ID, a deployment ID passed as a version ID, or the DNS half still pending a DNS-edit principal. | Worker half proved 2026-10-02 and 2026-10-03 (first request ~4–6 s, settle ~5–12 s, 0 non-200, 16/16 smokes) in [runbook.md](runbook.md#staging-rehearsal-worker-rollback-and-dns-flip-back); one-click workflow and version-UUID rule in [runbook.md](runbook.md#worker-rollback). The cutover-specific GOOD_VERSION is not yet recorded; DNS half pending. → **NO-GO / unknown until the pointer is recorded.** | DevOps & Reliability Engineer (records pointer + proof); CEO (rollback call). |
| 4 | Pager probe delivered | Staging probe on the tested revision returns **both** new `ops.alert.delivered` receipts (request + queue) for the probe's UUID within 90 s; only the script's redacted JSON result plus tested SHA retained. | HTTP 500 alone, one receipt, a foreign/old/delivery-failed receipt, a mute-window repeat, or a merged/dry-run build claimed as delivery. | Chain and probe script in [runbook-alerts.md](runbook-alerts.md#probe-parity-request-error--self-failing-queued-job). No redacted receipt pair for the candidate is on file. → **NO-GO / unknown.** | DevOps & Reliability Engineer (delivery verdict). |
| 5 | Dead-letter triage | Live `/up` `queue.failed` inspected newest-first; each failed row has a disposition (retry-once via the original producer with fresh job ID, or discard after confirmed recovery) per the loop; no blind delete, purge, or fabricated replay. | `failed` rising with 5xx/pager, `oldest_pending_age_seconds` over 1800 s, `unknown` across two polls, or no live triage on file. | Loop in [queue-redrive-runbook.md](queue-redrive-runbook.md); thresholds in [48h-watch-spec.md](48h-watch-spec.md#queue-depth-and-db-errors). Live triage for the cutover window is not on file. → **NO-GO / unknown.** | DevOps & Reliability Engineer (triage verdict); technical dead-ends to the Director of Engineering, suspected member-data exposure through the Director to CISO. |

## How to flip a row to GO

Run only inside the approved operator procedure, then file the receipt:
gate 1, the `before` JSON + timestamp; gate 2, the `e2e-staging` run URL
on the candidate SHA; gate 3, the GOOD_VERSION plus rehearsal timings;
gate 4, the probe's redacted JSON + SHA; gate 5, the `/up` values plus
per-row dispositions. After the flip the 48h watch in
[48h-watch-spec.md](48h-watch-spec.md) and the matrix in
[rollback-decision-matrix.md](rollback-decision-matrix.md) take over;
borderline rows round up, and the 48h clock restarts after any re-flip.
The freeze in [cutover-freeze.md](cutover-freeze.md) holds until the
watch exits.
