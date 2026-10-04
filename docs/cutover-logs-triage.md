# Staging Workers Logs triage for cutover watch

Read-only triage for `two-web-next` staging during cutover watch. Another
engineer follows this page alone when a 5xx spike appears. No alert-probe
rerun, no webhook install, no staging writes — dashboard reads, `wrangler
tail`, and one telemetry query only.

**Which stream.** Cloudflare dashboard → Workers & Pages → `two-web-next`
→ Observability → Logs, window around the incident. That stream carries
`http.request`, `error.alert`, `queue.failing` and the `csp.report.*` sink
keys. Do **not** query `two-web-next-production` (cutover target) or
`two-web-next-alerts` (Tail Worker — only redacted `ops.alert.*`
receipts). CLI equivalent: `npx wrangler tail two-web-next --format json`.
Console records are serialized JSON strings: use message/text **contains**,
not indexed-field equality, unless the dashboard exposes the parsed key.

**Retention.** Workers Logs keeps at most 7 days (Free 3 days, Paid 7
days). Older than that is gone — re-run `node bin/smoke.mjs
https://next.togetherweown.com` instead of hunting. Telemetry queries
return only the newest 100 events with ~60 s ingestion lag; keep each
window to 40 s or less while probing, and narrow before concluding
anything is absent. `error.alert` mutes per exception-class/route for five
minutes per isolate — a muted alert still leaves its `http.request` line.

**Privacy.** When copying a sample to a card keep only `event`, `route`,
`status`, a `request_id` prefix and the serving version. Never URLs,
headers, cookies, tokens, exception messages or stacks.

## Recipe 1 — 5xx spike

Where: same Logs view, or live tail piped through jq:

```sh
npx wrangler tail two-web-next --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | (test("\"event\":\"http.request\"") and test("\"status\":5[0-9]{2}")))'
```

Good: zero `status: 5xx` lines in the window (a quiet staging window with
zero 5xx is the expected result). Bad: any sustained 5xx, or even one 503
— 503 here is the `databaseUnavailable` outage envelope, never a flake.

First action: copy the `request_id` prefix from one 5xx `http.request`
line, search the same ID across `error.alert` / `queue.failing` to get the
exception class and route. File a two-web-next bug card with route,
status, request-id prefix, serving version (recipe 4) and timestamp; if
the 5xx persists across two consecutive windows or is member-visible,
escalate to DevOps in that card instead of live-fixing.

## Recipe 2 — error-state render rate

Where: same stream; count 500/503 renders per route over a fixed 10-minute
window:

```sh
npx wrangler tail two-web-next --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | (test("\"event\":\"http.request\"") and test("\"status\":50[03]")))'
```

500 is the branded internal-error page (`InternalErrorPage`); 503 is the
maintenance page (`MaintenancePage` / `db_unavailable` JSON for API
callers). Correlate each with its `error.alert` fingerprint
(`ExceptionClass@/route/pattern`).

Good: zero 500s and zero 503s. One isolated 503 during a deploy window can
be a restart; note it and re-check next slot. Bad: 503s across many routes
(DB/Hyperdrive/schema unreadable — check `GET /up`: `db: "error"` or
nonzero `pending_migrations` confirms it); 500s pinned to one route (code
bug through the real 500 handler).

First action: 503-cluster → file a DevOps/DB card with the `/up` JSON and
the version; never run migrations or purge queues yourself. 500-cluster on
one route → file a two-web-next bug card with the fingerprint class,
route, and three request-id prefixes. Client errors (404/403/429/4xx) stay
silent by design — do not chase them here.

## Recipe 3 — upstream / timeout errors

Where: same stream; alert plus queue-terminal lines for the window:

```sh
npx wrangler tail two-web-next --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing)\""))'
```

What to look for: `DiscordError` (upstream Discord: `provider_outage` on
their 5xx, `transport_failure` on DNS/timeout/reset, `rate_limited` on
429) and DB-deadline classes (`CountsReadTimeout`, featured/join-funnel
statement/lock timeouts). Featured/counts timeouts degrade to empty
sections, not 5xx — the page looks thin rather than red. Discord failures
reach members as generic failure copy; the provider body never leaves
`src/discord.ts`.

Good: no `error.alert` / `queue.failing` lines, or only a single
`rate_limited` that clears next window. Bad: a cluster with one
fingerprint (one upstream down), or timeouts across routes (database slow)
— mute windows hide repeats, so one line can mean five minutes of hits.

First action: single-upstream cluster → note vendor vs ours from the
`DiscordFailureKind`, file a two-web-next bug card with the class, route
and window; do not retry floods against Discord. Cross-route timeouts →
file a perf/DB card with the window, the routes, and the `/up` queue
values. Queue `exception` text can be a bot refusal message — quote the
class only.

## Recipe 4 — deploy-version marker check

Where: telemetry API (token stays in the environment, never on argv).
Both Worker versions answer `/up` identically, so only
`$workers.scriptVersion.id` proves which version served a request:

```sh
node -e 'fetch("https://api.cloudflare.com/client/v4/accounts/$CF_ACC/workers/observability/telemetry/query",
  {method:"POST",body:JSON.stringify({queryId:"serving-version",view:"events",limit:100,
    timeframe:{from:Date.now()-3600000,to:Date.now()},
    parameters:{filters:[{key:"$metadata.service",operation:"eq",type:"string",value:"two-web-next"}]}}),
  headers:{authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN,"content-type":"application/json"}})'
```

Good: one `scriptVersion.id` across the whole window — that ID is the
serving version; record it with the UTC time. Bad: two IDs mixed in one
window (deploy in flight or split traffic), or a stable ID that is not the
expected release/rollback target.

First action: mixed IDs → wait one window and re-query before filing;
deploy settle looks exactly like this. Wrong stable ID → file a deploy
card to DevOps with expected vs serving IDs; no code fix, no rollback
yourself. Record the serving version on every other recipe's card — a 5xx
without a version is not triaged.

Sources: `src/request-log.ts` (`http.request` shape), `src/alerts.ts`
(mute/fingerprint), `src/errors.tsx` (`databaseUnavailable`/500 pages),
`src/discord.ts` (`DiscordFailureKind`), `docs/runbook-logs.md` (stream,
retention, verified staging sample), `docs/runbook-alerts.md` (receipts
vs source logs).
