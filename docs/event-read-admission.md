# Public event read admission

The public event pages and feeds share one `events-read:<clientKey>` budget:
**60 admitted requests per client in the last 60 seconds**. This covers GET and
HEAD on `/events` (including search and island fragments), `/events/past`,
`/events.rss`, `/events.ics`, `/events/:file.ics`, `/e/:key`, `/events.md`,
`/e/:key.md`, `/sitemap_index.xml` and the hot-zone heatmaps (`/hotzones`,
`/hotzones/joins`, `/hotzones/voice`, `/hotzones/games`). Different query values,
page numbers, event keys and feed formats do not create new budgets.
The guard runs before event-store access, session reads, analytics and Discord
reads. It also charges redirects and missing-key requests on these routes.
On the hot-zone paths the guard runs after the season grammar and the signal
check, so a bad `?season=` (400) and an unknown signal (404) spend nothing;
everywhere else on these four paths it runs before the aggregate reads and
the board-view log insert. Invalid seasons return the branded 400 recovery page
on both Hono and Kit, not a server-outage message; Kit data requests keep their
machine-shaped error payload.

The routes remain public; the budget applies equally to signed-in clients because
reading a session before admission would itself incur database work. It does not
change the session requirement or guest 401 responses on `/events.json` or
`/events/:key`, the existing write/auth budgets, or `/up` readiness.
The sitemap is admitted before database setup and its event scan; its static-only
200 fallback on a database outage is unchanged. The database-free `/robots.txt`
and `/openapi.json` routes remain unguarded.

## Responses and search bounds

An exhausted budget returns 429 with `Retry-After`, `Cache-Control: no-store,
private` and `Vary: Accept`. RSS, ICS and event Markdown paths (`/events.md` and
`/e/:key.md`) return `text/plain` with the fixed body `Too many requests`, even
when Accept requests HTML or JSON. Other callers retain the branded HTML or
JSON response. The guard sets the cache header on its constructed Response,
following Hono's [response-header mutation API](https://hono.dev/docs/api/context#res).
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

## CI loopback budget

Off-edge requests carry no `CF-Connecting-IP`, so every suite in the `e2e.yml`
`browser-smoke` job shares the one `events-read:anon` bucket on the disposable
Postgres. The visual, journey, parity and perf suites run sequentially and
issue well over 60 guarded reads inside a 60-second window, so whichever
navigation lands past the budget gets a 429 with a matching URL and times out
on content instead of failing fast on status. Both loopback workers therefore
set `E2E_PUBLIC_READ_BUDGET` to `600` — `e2e/wrangler.jsonc` for Hono and the
generated Kit fixture in `ci/kit-worker-dev.mjs`, which enforces the same
bucket on the same disposable Postgres: ten times the per-client production
budget, enough to absorb the combined suite bursts while a runaway loop still
429s within the minute. A raise on only one worker would concentrate the flake
on the other's legs, so the two values move together. The override is scoped
to those loopback workers only — `publicReadBudget`
(`src/events/routes-shared.ts`) keeps 60 for absent, invalid or nonpositive
values, and no deployed config sets the var.
`test/e2e-public-read-budget.test.ts` pins the override behaviour and the
deployed-config absence; `ci/kit-parity-ci-wiring.test.mjs` pins the Kit
fixture value against the Hono one.

## Verification

`test/public-event-read-admission.test.ts` exercises the real route guards and
admission statements with local SQL/Drizzle doubles. It pins the shared budget,
pre-read denials, JSON/HTML/HEAD/island responses, client separation, window expiry,
feed cache/304 behavior, untouched JSON authentication and query boundaries,
including supplementary Unicode and a multi-kilobyte query.
`test/feed-throttle-429.test.ts` pins plain-text 429 bodies and headers on the
real RSS, ICS and event Markdown routes across Accept variants, with
unexhausted-budget controls. Existing throttle connection and concurrency suites
cover Hyperdrive resolution and atomic
Postgres admission. Local fixtures do not prove a deployed edge rule or staging
revision; record staging verification separately after the reviewed head deploys.
