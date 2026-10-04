# Request correlation in Workers Logs

The HTTP middleware emits one single-line JSON `http.request` record for each
request dispatched to Hono. It runs outside the security-header middleware and
mounted routers, so redirects, denials, 404s, handled 500s and downstream response
replacements have the same log/header contract.

```json
{"event":"http.request","request_id":"0123456789abcdef-LHR","method":"GET","route":"/e/:key","status":200,"duration_ms":12.34,"colo":"LHR"}
```

## Find a request

1. Ask for the response's **`x-request-id`** and approximate time, not a cookie,
   Authorization header, OAuth callback URL or Discord identity. The header is
   a validated Cloudflare Ray ID (`cf-ray`), or a generated ULID when no valid
   Ray ID is available. Client `x-request-id` input is ignored.
2. Open **Cloudflare dashboard → Workers & Pages → two-web-next → Observability**.
   Choose a time window around the report and the correct deployed Worker.
3. Search the log message for the exact ID (for example,
   `0123456789abcdef-LHR`). These console records are serialized JSON strings;
   use the message/text **contains** filter rather than assuming a custom
   `request_id` field is indexed. If the dashboard exposes the parsed key,
   `request_id` **equals** the ID is also sufficient.
4. The `http.request` record gives the method, registered route pattern,
   final status, wall-clock `duration_ms` and edge colo (`null` locally).
   Unknown URLs use `unmatched`; URL parameters and query strings are absent.
5. Search the same ID across `error.alert` and `queue.failing` records to connect
   an HTTP failure or a later queued failure with the request that produced it.
   Error alerts still mute duplicate exception-class/route fingerprints for
   five minutes per isolate. A muted alert does not suppress the request log.

Queue payloads carry an optional `requestId`; request-produced jobs preserve it
through retries and terminal failure alerts. Old messages and scheduled jobs
may have no originating HTTP request ID. Do not interpret a missing ID as a
successful job. The W8 event-sync carrier and W13 queue-ledger carrier both
propagate it; it is not a deduplication key and does not change job execution.

## CSP violation sink

`POST /csp-reports` is the session-free violation sink. Query its two log
keys in Workers Logs with a message/text **contains** filter:

- `csp.report.violation` — a sampled valid report. The record carries exactly
  five fixed fields: `blocked_uri`, `violated_directive`, `document_uri`,
  `source_file` and `line_number`. URI credentials are redacted and
  non-scalar values collapse to null, so never expect nested report bodies.
- `csp.report.dropped_oversize` — a report over the 8 KB cap. The record
  carries only `{ bytes }`; the body is discarded, never logged or stored.

Sampling: `CSP_REPORT_SAMPLE_RATE` (default `1.0`) controls what fraction of
valid reports is logged. Values clamp to 0–1; a missing or unparseable value
falls back to `1.0` (logging stays on). The knob changes logging only — the
sink still answers 204.

Every sink path returns 204 with `no-store` and has no session, cookie or DB
dependency, so a missing `request_id` on these records is normal. Endpoint
contract: `docs/same-origin.md` (exemption table).

## Member access-log degrade

When a member-data read cannot be recorded, `src/access-log.ts` refuses to
serve it silently. `MEMBER_ACCESS_LOG_ENFORCE` selects the failure mode:

- **Unset or empty (default): fail closed.** The read is replaced with a 503
  via `databaseUnavailable`, with `cache-control` carrying `private` and
  `no-store`. A loud `console.error` is still emitted.
- **`false`, `0` or `no` (case-insensitive, trimmed): degrade.** The read is
  still served, and the same loud `console.error` is emitted:
  `Member data access could not be recorded; refusing to serve the read.`

The error record carries only `{ route, exception }`, where `exception` is
the error class name — never the message or stack, which may contain SQL
bindings. It never includes viewer or subject IDs. Correlate with the
`http.request` record by searching the same `x-request-id` (the `http.request`
record is still emitted with the final status). Source: `src/access-log.ts`
(`enforceOn`, `memberAccessLog`).

## Privacy and boundaries

Request logs allowlist only `event`, `request_id`, `method`, `route`, `status`,
`duration_ms` and `colo`. They never include headers, cookies, tokens, bodies,
query strings, IPs, resolved URL paths or Discord IDs. Error alerts include the
exception class, not its message or stack (which may contain SQL bindings or
personal data). Do not add those values when investigating an incident.

This is the application-log contract, not a claim that all platform telemetry
is sanitized. Cloudflare invocation records may independently include the
request URL, and existing specialist audit/warning records have their own
contracts. Worker static assets served directly by Cloudflare, and edge errors
that never dispatch to Hono, do not pass through this middleware.

`wrangler.jsonc` already enables observability. Sampling and account retention
can prevent a historic match: check the deployed configuration and time window
before concluding the request did not occur. `duration_ms` includes downstream
middleware and handler work, not queue execution or streamed-body completion.
No Logpush or external shipping is configured by this change.

## Staging web-smoke triage (2-minute path)

When `node bin/smoke.mjs https://next.togetherweown.com` goes red, read the
staging Worker's logs before touching code. Everything in this section is
read-only: dashboard reads, `wrangler tail` and one telemetry query.

**Which stream.** Staging request logs live on Worker **`two-web-next`**
(route `next.togetherweown.com`, the `wrangler.jsonc` top level). Do not
query `two-web-next-production` (the cutover target) or
`two-web-next-alerts` (the Tail Worker — it holds only redacted
`ops.alert.delivered` / `ops.alert.delivery_failed` receipts, never request
logs). Dashboard path: Cloudflare dashboard → Workers & Pages →
`two-web-next` → Observability → Logs, with a window around the smoke run.
The same stream carries `http.request`, `error.alert`, `queue.failing` and
the CSP sink keys below.

**Retention.** Workers Logs keeps at most 7 days (Free plan 3 days, Paid
plan 7 days). A smoke run older than that is gone — re-run smoke instead of
hunting. Sampling and account retention can also prevent a historic match,
so check the window before concluding the request did not occur. (Pricing
moves to Cloudflare Observability pricing on 2026-12-01; re-check then.)

**Copy-paste filters.** Console records are serialized JSON strings, so use
message/text **contains**, not indexed-field equality:

1. 5xx request records (live tail):

   ```sh
   npx wrangler tail two-web-next --format json \
     | jq -c 'select(.logs[]?.message[]? | tostring | (test("\"event\":\"http.request\"") and test("\"status\":5[0-9]{2}")))'
   ```

2. Alert plus queue-terminal lines for the same window:

   ```sh
   npx wrangler tail two-web-next --format json \
     | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing)\""))'
   ```

   Correlate by `request_id` with the `http.request` record above.
   `error.alert` is muted per exception-class/route for five minutes per
   isolate; a muted alert still leaves its `http.request` line.

3. Scripted read-only query (telemetry API; the token stays in the
   environment, never on argv). Keep each window to 40 seconds or less
   while probing — the API returns only the newest 100 events and a capped
   window can lose the oldest requests:

   ```sh
   node -e 'fetch("https://api.cloudflare.com/client/v4/accounts/$CF_ACC/workers/observability/telemetry/query",
     {method:"POST",body:JSON.stringify({queryId:"smoke-triage",view:"events",limit:100,
       timeframe:{from:Date.now()-3600000,to:Date.now()},
       parameters:{filters:[{key:"$metadata.service",operation:"eq",type:"string",value:"two-web-next"}]}}),
     headers:{authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN,"content-type":"application/json"}})'
   ```

**CSP sink keys.** `POST /csp-reports` violations land in this same stream;
query message/text **contains** `csp.report.violation` (exactly five
fields: `blocked_uri`, `violated_directive`, `document_uri`,
`source_file`, `line_number`) or `csp.report.dropped_oversize` (`{ bytes }`
only). Sampling follows `CSP_REPORT_SAMPLE_RATE` (default `1.0`), and a
missing `request_id` on these records is normal. A smoke failure only needs
the CSP keys when the failing assertion is a `Content-Security-Policy`
header check — otherwise stay with `http.request`.

**Verified sample (2026-10-04T07:19Z, read-only).** Telemetry query on
`two-web-next`, 60-minute window, limit 100: 100 events returned (cap hit —
narrow the window for precision), 39 `http.request`, 23 2xx/3xx, **0 with
`"status":5xx`**, 0 `error.alert`, 0 `csp.report.*`; serving version
`21ee6581-…-4196` throughout. Envelope URLs and hex IDs redacted; only
route/status/version retained. This proves the service filter and the
5xx/error/alert message-contains patterns execute against the staging
stream; a quiet staging window with zero 5xx is the expected result.

**Privacy.** Invocation records independently include the full request URL.
When copying a sample to a card, keep only `event`, `route`, `status`, a
`request_id` prefix and the version — never URLs, headers, cookies or
tokens.

## Local regression check

```sh
# Focused request/correlation tests use fixtures only.
env -u DATABASE_URL -u BOT_DATABASE_URL npx vitest run test/request-log.test.ts test/request-correlation.test.ts test/alerts.test.ts
# The full suite includes real SQL proofs; pin it to the authorized test DB.
env -u BOT_DATABASE_URL DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next npm run check
```

Never point tests or probes at staging or production databases.

Sources:
- [Hono middleware execution/error handling](https://hono.dev/docs/guides/middleware#execution-order)
- [Hono registered route helpers](https://hono.dev/docs/helpers/route#matchedroutes)
- [Workers Logs dashboard, structured logs and sampling](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Logs pricing and retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)
  (Free 3 days, Paid 7 days, 7-day maximum; Observability pricing from 2026-12-01)
