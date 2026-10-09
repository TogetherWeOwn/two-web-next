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

## Discord snapshot outcome

The calendar's Discord snapshot source (`src/events/discord-transients.ts`)
emits one bounded `Discord snapshot outcome` diagnostic per request through the
shared snapshot path. The staging events incident, where Discord 429s made the
events page show an error state instead of events, was diagnosed by tallying
these lines. Background: [Discord calendar snapshots](discord-snapshots.md).

| Field | Present | Meaning |
| --- | --- | --- |
| `outcome` | always | One of the outcomes below. The code can emit exactly these outcomes: `cold`, `held`, `fresh`, `stale`, `error`. |
| `completionFailed` | `console.info` line only | `true` when publishing the refresh result to the store threw, but the request still served live rows or a usable stale snapshot. |
| `code` | only for allowlisted SQLSTATEs | The store driver's SQLSTATE when `completionFailed` is true or the line is `error`. |

### What each outcome means

| Outcome | Meaning |
| --- | --- |
| `cold` | No usable snapshot: nothing served, and the page shows the error state on an otherwise-empty page. The successful first refresh logs `fresh`, not `cold`: `cold` is for requests that arrive while that first refresh still holds the lease, a refresh that failed with nothing usable left (for example an empty store during a Discord 429 episode), a snapshot older than 600 seconds, or a completion failure with neither live rows nor a usable snapshot. |
| `held` | A usable snapshot was served while a retry hold is active. That covers requests that skipped Discord because another request set the hold, and the request that just set the hold itself after its own Discord read failed. Expect during Discord 429 or slow episodes. |
| `fresh` | Served a usable snapshot completed less than 60 seconds ago. That includes a snapshot this request just refreshed: the lease winner calls Discord, completes, then logs `fresh`. Other requests served from a fresh snapshot skip Discord. |
| `stale` | Served data while the snapshot is 60 to 600 seconds old and another request holds the refresh lease, or after publishing the refresh result threw (`completionFailed: true`, which can serve even live rows because the outcome is derived from the pre-claim view). A failed refresh itself logs `held` (or `cold` when nothing usable is left), never `stale`. |
| `error` | The snapshot store read (claim) failed, the stored payload was corrupt and failed to decode, or the snapshot key config was invalid (an `APP_URL` with a path, query or credentials, or a missing or oversized `DISCORD_GUILD_ID`). Logged at warn level with no live Discord fallback. Points at the store or the config, not at Discord. A store completion failure is not `error`: it stays on the info line with `completionFailed: true`. |

A healthy mix is mostly `fresh`, with `stale` around the 60-second refresh
boundary and brief `held` stretches while Discord throttles or slows.
`completionFailed: true` is rare and still serves data. An unhealthy mix is a
`cold` spike (the page error state from the staging incident), `held`/`stale`
that age into `cold`, or any sustained `error` lines.

Only these SQLSTATE codes can appear as `code`: `42501`, `42P01`, `55P03`, `57014`.
Any other driver code is dropped before logging.

The line never carries the snapshot key, the display payload, the driver's
error message (it can echo credentials), the Discord bot token, or member
identity. The `code` is a fixed allowlisted class, not a message.

### Tally in Workers telemetry

1. Open **Cloudflare dashboard → Workers & Pages → two-web-next → Observability**.
   Choose a time window around the report and the correct deployed Worker.
2. Use the message/text **contains** filter with `Discord snapshot outcome`.
   These console records are serialized JSON strings; do not assume an indexed
   `outcome` field.
3. Tally the `"outcome":"cold"`, `"outcome":"held"`, `"outcome":"fresh"`,
   `"outcome":"stale"` and `"outcome":"error"` substrings across the window,
   and note any `"completionFailed":true` or `"code":"..."` values. Compare the
   mix against the healthy and unhealthy shapes above.

## Local regression check

```sh
# Focused request/correlation tests use fixtures only.
env -u DATABASE_URL -u AUDIT_IMPORT_TEST_DATABASE_URL \
  -u LEGACY_DATABASE_URL -u BOT_DATABASE_URL \
  npx vitest run test/request-log.test.ts test/request-correlation.test.ts test/alerts.test.ts
# First create a fresh run-owned database following README's database setup; replace the suffix.
export TEST_DB=two_web_next_tog1234567890123456
export DATABASE_URL="postgres://agent_test@agent-testdb:5432/${TEST_DB}"
export AUDIT_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"
unset LEGACY_DATABASE_URL
export PGPASSWORD=
export W1_AGENT_TESTDB=0
npm run db:migrate
npm run db:check
env -u BOT_DATABASE_URL npm run check
```

Never point tests or probes at staging or production databases.

Sources:
- [Hono middleware execution/error handling](https://hono.dev/docs/guides/middleware#execution-order)
- [Hono registered route helpers](https://hono.dev/docs/helpers/route#matchedroutes)
- [Workers Logs dashboard, structured logs and sampling](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
