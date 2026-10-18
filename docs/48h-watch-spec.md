# 48h post-flip watch: alert-threshold and panel spec (golden signals)

Spec-only watch contract for the 48 hours after the production DNS flip.
No production writes, migrations, credential changes, queue purges or new
infrastructure. Execution, DNS changes and database or secret steps stay in
the separately approved operator procedure.

- First-hour dense polls and ladder: `GET /up` every 2 min for the
  first 10 min, then at T+15, +20, +30, +45 and +60; full after-gate at
  T+0, +5, +30 and +60. Hands off to the 48h cadence below at T+60.
  First-hour escalation: watcher polls on warn and calls DevOps &
  Reliability Engineer at once on any critical (details in
  [Escalation ladder](#escalation-ladder)).
- 48h cadence, exit criteria and rollback pointer:
  [runbook.md](runbook.md#48h-post-flip-watch).
- Pager source, redaction and delivery:
  [runbook-alerts.md](runbook-alerts.md).
- Log correlation: [runbook-logs.md](runbook-logs.md).
- Queue dead-letter loop:
  [queue-redrive-runbook.md](queue-redrive-runbook.md).
- Freeze text: [cutover-freeze.md](cutover-freeze.md) is an archived
  withdrawn proposal, not a live instruction. The current rule lives in
  [runbook.md](runbook.md#48h-post-flip-watch): no freeze is implied by this
  watch; any future freeze needs a separate declaration with new dates, an
  owner and explicit lift terms.
- After-gate contract: [cutover-check.md](cutover-check.md#phase-contract-and-prerequisites).
- Readiness contract source: [`src/up.ts`](../src/up.ts).
  Queue measurement source: [`src/jobs/postgres.ts`](../src/jobs/postgres.ts).

## Route classes

| Class | Routes | Expected steady state |
| --- | --- | --- |
| R readiness | `GET /up` on the apex | 200, `db: "ok"`, `pending_migrations: 0`, no `config` key, `X-TWO-Origin: two-web-next`, `Cache-Control: no-store` |
| S static DB-free | `GET /`, `/about`, `/faq`, `/rules`, `/privacy`, `/robots.txt`, `/join` (GET), `GET /discord` (302 invite), `POST /csp-reports` (204) | Stay 200/302/204 during a database outage; never 5xx for a DB reason |
| G guest reads (DB-backed) | `GET /events`, `/events/past`, `/events.rss`, `/events.ics`, `/events/:key.ics`, `/e/:key`, `/sitemap_index.xml` event lookups | Event list/feed routes return 200 guest HTML/RSS/iCal when available; missing event DB returns plain-text 503. Classified DB outages use the shared sanitized 503. Other failures use 500 HTML on list/feed routes; `/e/:key` refuses failed reads with plain-text 503. |
| M member writes | OAuth callback, join callback, `PUT/DELETE /events/:key/rsvp`, profile read/save, `POST/PATCH /events*` | Auth gates 401/403 first; classified DB outage and profile read failure 503; other session, transaction or save failure 500; missing store 503; post-commit enqueue failure keeps the 2xx |
| A privileged | Implemented `/admin/*`, `POST /api/agent-events` | Session resolution, admin reads, missing resource DB and classified DB outage 503; other uncaught admin-write failure 500 HTML; guest 302, non-moderator 403; agent-events ingress disabled 404, no source 503, service failure 500 JSON |
| Q async | `two-sync-event`, `two-internal-action` ledger + transport | `pending < 20` healthy; `pending >= 20` degraded; ledger unreadable is `unknown` |

Retired diagnostics (`/health`, `/healthz`, `/db-ping`) stay 404 and never
return 200 or redirect to `/up`.

## Golden-signal thresholds

Each row names its owner and its silence expiry. Owner means the role that
triage, acknowledges and calls the next rung; it never means a single person.
Silence expiry means the mute ends and the signal re-fires if still true.

Conventions used below: `p95` is the 95th percentile of `duration_ms` in the
`http.request` log for the class over the stated window. `5xx rate` is
5xx responses divided by all dispatched responses for the class over the
window. `pending`, `oldest_pending_age_seconds` and `failed` are the `/up`
queue envelope fields (`warn_at: 20`, `critical_at: 100` reported from
`src/up-queue.ts`; the code has no separate critical status).

### Availability and 5xx rate

| Signal | Ticket | Page | Owner | Silence expiry |
| --- | --- | --- | --- | --- |
| R `/up` non-200, `db: "error"`, `pending_migrations` nonzero or `null`, or `config: "missing"` | n/a, always a page | Immediate page on any single poll | DevOps & Reliability Engineer | Re-fires on the next poll; no watch-level mute beyond the code mute |
| R/S/G wrong `X-TWO-Origin`, missing Next marker, or red after-gate row | n/a, always a page | Immediate page | DevOps & Reliability Engineer | Same as above |
| S static DB-free non-2xx/3xx (expected 200/302/204) | n/a, always a page | Immediate page; DB reason never explains an S failure | DevOps & Reliability Engineer | Same as above |
| G guest-read 5xx rate | Ticket when 5xx > 0.5% over 15 min | Page when 5xx > 2% over 15 min, or any member-visible breakage | DevOps & Reliability Engineer | Ticket silence expires at the next cadence slot; page re-fires per code mute |
| M/A 5xx rate (excluding 401/403/404/429) | Ticket when 5xx > 0.5% over 15 min | Page when 5xx > 2% over 15 min, or auth outage locks members out | DevOps & Reliability Engineer | Same as above |
| Pager storm (`error.alert` / `queue.failing` receipts) | n/a | Page when more than 10 redacted receipts in 5 min, or any burst after a deploy | DevOps & Reliability Engineer | Code mute only (5 min per isolate, see below); duplicates across isolates do not suppress the page |

### Latency p95

Lab budgets in `ci/lighthouserc.cjs` (LCP 2000 ms error, observed TTFB
600 ms error, FCP 1800 ms warning, TBT 300 ms warning) gate releases; the
rows below are production watch tripwires on `http.request duration_ms`,
not release gates.

| Signal | Ticket | Page | Owner | Silence expiry |
| --- | --- | --- | --- | --- |
| R `/up` p95 | Ticket when p95 > 1500 ms over 15 min | Page when p95 > 2500 ms over 15 min, or repeated 3 s deadline timeouts (`unknown` reads) | DevOps & Reliability Engineer | Ticket silence expires at the next cadence slot |
| S static p95 | Ticket when p95 > 1200 ms over 15 min | Page when p95 > 2000 ms sustained over two consecutive 15 min windows | DevOps & Reliability Engineer | Same as above |
| G guest-read p95 | Ticket when p95 > 1500 ms over 15 min | Page when p95 > 2500 ms sustained over two windows, or TTFB budget blown with member complaints | DevOps & Reliability Engineer; lab-budget misses go to QA & Release Engineer as tickets | Same as above |
| M/A write p95 | Ticket when p95 > 2000 ms over 15 min | Page when sustained with 5xx rise or member-visible timeouts | DevOps & Reliability Engineer | Same as above |

### Queue depth and DB errors

| Signal | Ticket | Page | Owner | Silence expiry |
| --- | --- | --- | --- | --- |
| `queue.pending` 20-99 (`degraded`, HTTP still 200 when DB ready) | Ticket on first sighting; keep polling per cadence | n/a | DevOps & Reliability Engineer | Ticket silence expires at the next cadence slot |
| `queue.pending >= 100` (still `degraded`/200; critical backlog) | n/a | Immediate page; contain per runbook queue section | DevOps & Reliability Engineer | Re-fires per code path; no extra mute |
| `oldest_pending_age_seconds` | Ticket when older than 300 s | Page when older than 1800 s, or growing with `pending >= 100` | DevOps & Reliability Engineer | Ticket silence expires hourly |
| `queue_failed_jobs` (`/up queue.failed`) | Ticket on any increase; triage newest-first per the redrive runbook | Page only when the spike correlates with a 5xx/pager storm | DevOps & Reliability Engineer | Ticket silence expires after triage or 24 h |
| `queue.status unknown` (all six measurements `null`) | Ticket on first sighting (lack of evidence, not recovery) | Page when it persists across two consecutive polls | DevOps & Reliability Engineer | Ticket silence expires at the next poll |
| `failed`, `delayed`, `reserved`, `total` alone | Never a page by themselves; watch `pending` and oldest age instead | n/a | DevOps & Reliability Engineer | n/a |
| Classified 503 outage envelope on M/A/G (branded HTML or sanitized JSON) | Ticket; confirm the outage class from redacted logs | Page when member-visible or paired with R failure | DevOps & Reliability Engineer | Ticket silence expires hourly |
| Suspected leaked member data in any signal | n/a, always a page | Immediate page through the Director to CISO; keep evidence private | Director of Engineering to CISO | No silence; no muting of a privacy signal |

Lighthouse and GET-only guest journeys run once within the first 24h and
hold the repo thresholds; a budget miss is a ticket to QA & Release
Engineer, never a silent threshold relaxation.

## Panels and queries (existing dashboards only)

No new infrastructure, no Logpush, no external shipper, no new pager.

1. **Cloudflare dashboard, Workers & Pages, `two-web-next-production`, Observability.**
   Workers Logs is enabled on the production app and on its Tail Worker
   (`two-web-next-alerts-production` per `wrangler.jsonc` `env.production`).
   Use the log message contains filter (records are serialized JSON strings):
   - `http.request` with `route`, `status`, `duration_ms`, `colo` for
     availability, p95 and 5xx rate per class above.
   - `"event":"error.alert"` with `fingerprint` (`ExceptionClass@/route/pattern`)
     for 5xx attribution; correlate by `request_id` with the `http.request` record.
   - `"event":"queue.failing"` with job class and attempts for queue failure spikes.
   - On the production Tail Worker, `"delivery":"ops.alert.delivered"` and
     `"delivery":"ops.alert.delivery_failed"` for pager proof versus loss.
2. **Live tail on production (authorized Cloudflare access only).**
   ```sh
   npx wrangler tail two-web-next-production --format json \
     | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing)\""))'
   npx wrangler tail two-web-next-alerts-production --search '"delivery":"ops.alert.'
   ```
   Raw source traces stay the diagnostic fallback; never publish them.
   Staging comparison only: dashboard `two-web-next`, and
   `npx wrangler tail two-web-next` plus
   `npx wrangler tail two-web-next-alerts` with the same filters.
3. **`GET /up` on the apex.** Readiness, not liveness: HTTP status, `db`,
   `pending_migrations`, optional `config`, and the full queue envelope with
   `warn_at`/`critical_at`. Preserve the JSON plus timestamp per checkpoint.
   ```sh
   curl -sS --max-time 10 https://togetherweown.com/up
   ```
4. **After-gate.** Unauthenticated, GET-only; run only inside this watch.
   ```sh
   node ci/cutover-check.mjs --phase after --target togetherweown.com --json
   ```
5. **Public-route smoke on the apex.** Twenty-three public routes (the
   `bin/smoke.mjs` shape: `/up` JSON readiness plus `/`, `/about`, `/faq`,
   `/rules`, `/privacy`, `/events`, `/events/past`, `/join`, `/events.rss`,
   `/events.ics`, `/sitemap_index.xml`, `/robots.txt`,
   `/.well-known/security.txt`, `/discord` (302),
   `/profile` (302), `/admin` (302/403), `/api/public/events` (200 JSON
   collection envelope), `/api/public/events/<key>` (200 JSON single-event
   envelope), `/api/public/community` (200 JSON community snapshot),
   `/api/public/join` (200 JSON join handoff), `/openapi.json` (200 JSON
   discovery document) and `/__smoke_unknown_route__`
   (404), with CSP/nosniff/content-type/indexing/redirect assertions).
   ```sh
   node bin/smoke.mjs https://togetherweown.com --allow-indexable
   ```
   Without `--allow-indexable` the apex probe fails its indexing assertions
   (the apex omits `X-Robots-Tag noindex` on indexable leaves; see the
   loopback apex fixture in `test/smoke.test.mjs`). Staging keeps the
   default posture without the flag:
   `node bin/smoke.mjs https://next.togetherweown.com`.
6. **Lighthouse artifact.** The `lighthouse-<sha>` GitHub artifact (14 days)
   with assertion results; thresholds live in `ci/lighthouserc.cjs`.
7. **GitHub Actions.** Required `check`, `gitleaks`, `pr-lint` on the exact
   head; `deploy-production` `/up` smoke; `e2e-staging` journeys for the
   staging comparison. Production rollback is the one-click
   `rollback-production` workflow to the recorded version ID.
8. **Version-settle telemetry (rollback proof only).** The `served_versions`
   helper in the runbook queries Worker telemetry by `$metadata.service`
   over windows of 40 s or less. As printed it filters staging
   (`two-web-next`); for production substitute that `"value"` with
   `two-web-next-production`. Use it to prove which version
   served during a rollback, not as a routine latency panel.

## Mute windows

- Source app mute: `error.alert` per `class@route` for five minutes.
  Client errors (404, 403, 429, other 4xx and validation errors) stay silent.
  `queue.failing` source lines are not muted: one per terminal job failure.
- Tail Worker mute: five minutes per event/fingerprint across batches and
  concurrent invocations, keyed on source console-log timestamps. Queue
  failures of the same job class coalesce; attempt count does not split it.
- Both mutes are per isolate, not durable or global: cold starts, deploys and
  multiple isolates can duplicate pages. State is bounded to 500 fingerprints
  and 500 in-flight deliveries; eviction may re-page an older fingerprint.
  A failed Discord delivery does not start the mute.
- Watch-level rule: warn/ticket observations never page; they re-check at the
  next cadence slot. Critical/page observations page immediately and re-fire
  per the code mute above. A manual dashboard/Discord silence must name its
  owner and reason and expire within 2 hours.
- Request IDs do not change fingerprints or mute windows and are not forwarded
  to Discord.

## Escalation ladder

Full ladder and safety rules:

- First-hour ladder (this spec's short form below): watcher to DevOps
  to CEO go/no-go.
- [runbook.md](runbook.md#safety-and-escalation) (containment ownership,
  Director and CISO paths, evidence rules).
- [runbook.md](runbook.md#queue-containment-drain-and-failed-job-replay)
  (pause/resume, no purge/delete).
- [runbook.md](runbook.md#production-one-click-workflow) (rollback to the
  recorded version ID; the 48h clock restarts after the re-flip).

Short form: watcher sees warn/critical per the tables above. Warn keeps
polling and logs. Any critical goes watcher to DevOps & Reliability
Engineer at once. Technical dead-ends go to the Director of Engineering;
suspected leaked member data goes through the Director to CISO. The CEO
makes the rollback call and consolidates owner-reserved approvals. Ordinary
gaps never go to the owner.

## Cadence and exit

Pager continuously for the whole 48h. `/up` every 15 minutes for the first
4h, then hourly. Full after-gate at flip+1h, +24h and +48h. Lighthouse and
the GET-only guest journeys once within the first 24h. Exit after 48h with
no Sev-1: no pager storm, `/up` 200 with `db:ok` and zero pending
migrations throughout, after-gates green, Lighthouse and guest journeys
within budget. The DevOps & Reliability Engineer records the exit on the
cutover card. The archived [cutover-freeze.md](cutover-freeze.md) proposal
is withdrawn: watch exit alone does not lift a freeze. If a freeze was
separately declared for this window, its authorized owner lifts it only
under that declaration's terms.
