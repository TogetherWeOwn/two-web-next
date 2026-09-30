# Runbook: log-line alerts

The Worker has no mail, Slack or Discord webhook alerting. The platform log
stream is the pager (ports two-web's `bin/error-log-watch.sh`). Two event
types are written as ONE single-line JSON object on `console.error`, with
`level: "critical"`:

| `event` | When | Fields |
| --- | --- | --- |
| `error.alert` | An unhandled error reached the 500 handler | `fingerprint` (`ExceptionClass@/route/pattern`), `exception`, `method`, `route`, optional `request_id` |
| `queue.failing` | A queue job failed terminally (or threw on its final attempt) | `connection`, `queue`, `job`, `attempts`, `exception`, optional `request_id` |

Rules (same as legacy):

- `error.alert` fires once per distinct `class@route` fingerprint per 5 minutes.
  The mute is held per Worker isolate, so a busy deploy can emit a few lines per
  window (one per live isolate), never one per request.
- Client errors stay silent: 404, 403, 429, any other 4xx `HTTPException`, and
  validation errors are never alerted.
- HTTP error alerts carry the exception class, not its message or stack (a
  database error message can hold bound values). The raw `unhandled error:`
  line is no longer emitted. Correlate by `request_id` with the `http.request`
  record; see [request-log queries](runbook-logs.md). Request IDs do not change
  the fingerprint or mute window.
- Both alert types include a validated `request_id` when originating from an
  HTTP request. Scheduled jobs and legacy queue messages may omit it. Queue
  failure reasons retain their existing job-specific contract.
- `queue.failing` is not muted: one line per failed job. Retryable throws only
  alert on the last attempt (`tries` of the job), matching Laravel's
  `Queue::failing`.

## Tailing

```sh
# Live, alerts only (needs the Cloudflare login/token for the account)
npx wrangler tail two-web-next --format json \
  | jq -c 'select(.logs[]?.message[]? | tostring | test("\"event\":\"(error.alert|queue.failing)\""))'

# Pretty, filtered by substring
npx wrangler tail two-web-next --search '"level":"critical"'
```

Workers Logs (dashboard: Workers & Pages -> two-web-next -> Logs) is on
(`observability.enabled`); filter `event = error.alert` or `queue.failing` for
history. Pipe `wrangler tail` into any external pager you like; the Worker
itself sends nothing.
