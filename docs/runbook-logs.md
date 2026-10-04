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
