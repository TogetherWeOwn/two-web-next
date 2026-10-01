# Runbook: log-line alerts

For deploy/rollback, `/up` interpretation, queue containment/replay limits,
Neon/Hyperdrive outages, restore drills and escalation, start with the
[operations runbook](runbook.md). In particular, `queue.failing` is terminal
failure evidence, not proof of a successful drain or a replayable dead-letter queue.

The Worker has no mail, Slack or Discord webhook alerting. The platform log
stream is the pager (ports two-web's `bin/error-log-watch.sh`). Two event
types are written as ONE single-line JSON object on `console.error`, with
`level: "critical"`:

| `event` | When | Fields |
| --- | --- | --- |
| `error.alert` | An unhandled error reached the 500 handler | `fingerprint` (`ExceptionClass@/route/pattern`), `exception`, `method`, `route` |
| `queue.failing` | A queue job failed terminally (or threw on its final attempt) | `connection`, `queue`, `job`, `attempts`, `exception` |

Rules (same as legacy):

- `error.alert` fires once per distinct `class@route` fingerprint per 5 minutes.
  The mute is held per Worker isolate, so a busy deploy can emit a few lines per
  window (one per live isolate), never one per request.
- Client errors stay silent: 404, 403, 429, any other 4xx `HTTPException`, and
  validation errors are never alerted.
- Alert lines carry the exception class, not its message (a database error
  message can hold bound values). The full error is logged in a separate
  `unhandled error:` line just before it; follow the fingerprint to that line.
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
