# Public event read admission

The public event pages and feeds share one `events-read:<clientKey>` budget:
**60 admitted requests per client in the last 60 seconds**. This covers GET and
HEAD on `/events` (including search and island fragments), `/events/past`,
`/events.rss`, `/events.ics`, `/events/:file.ics` and `/e/:key`. Different query
values, page numbers, event keys and feed formats do not create new budgets.
The guard runs before event-store access, session reads, analytics and Discord
reads. It also charges redirects and missing-key requests on these routes.

The routes remain public; the budget applies equally to signed-in clients because
reading a session before admission would itself incur database work. It does not
change the session requirement or guest 401 responses on `/events.json` or
`/events/:key`, the existing write/auth budgets, or `/up` readiness.

## Responses and search bounds

An exhausted budget returns the existing branded HTML or JSON 429 response with
`Retry-After` and `Cache-Control: no-store, private`. The guard sets the header on
its constructed Response, following Hono's [response-header mutation API](https://hono.dev/docs/api/context#res).
Successful cache headers and
feed ETags/conditional 304 responses are unchanged. Conditional requests that
reach the Worker consume budget because generating their validator still reads
event rows. Shared-cache hits that never execute the Worker do not count.

The decoded `q` parameter on `/events` is limited to **255 Unicode code points**,
including whitespace, before any throttle, event or session store access. An
oversized query returns a static 422 response with `Cache-Control: no-store,
private`; it is not reflected, logged or silently truncated. This matches the
existing search-analytics field maximum. One-character searches remain supported;
blank queries still mean no search. Existing trimming, NUL stripping and literal
LIKE wildcard escaping remain unchanged for accepted queries.

## Cost and failure behavior

This reuses `src/throttle.ts` and its existing Postgres admission transaction,
client-address selection and direct-URL/Hyperdrive connection resolution. No new
binding, table, secret, edge rule or migration is required. Atomic admission uses
the existing per-bucket advisory lock. The shared limiter still queries Postgres
on every request, including denials; this bounds downstream event/search/session
work, **not total database requests or a distributed denial-of-service attack**.
An edge limiter would be a separate operational improvement, not delivered here.

The existing missing-store/error behavior is preserved: admission fails open,
then the event route retains its ordinary availability response. A throttle-store
failure never substitutes another connection or exposes driver diagnostics. This
is not a claim of enforcement during a database outage. Clients behind one IPv4
NAT share a budget, and the current shared `clientKey` policy determines IPv6
sharing. Sixty reads per minute leaves room for normal browsing and subscription
refreshes; heavy shared clients may receive 429 and should respect `Retry-After`.

## Verification

`test/public-event-read-admission.test.ts` exercises the real route guards and
admission statements with local SQL/Drizzle doubles. It pins the shared budget,
pre-read denials, JSON/HTML/HEAD/island responses, client separation, window expiry,
feed cache/304 behavior, untouched JSON authentication and query boundaries,
including supplementary Unicode and a multi-kilobyte query. Existing throttle
connection and concurrency suites cover Hyperdrive resolution and atomic
Postgres admission. Local fixtures do not prove a deployed edge rule or staging
revision; record staging verification separately after the reviewed head deploys.
