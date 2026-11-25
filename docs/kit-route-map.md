# Hono registration to Kit target plan

Baseline: `origin/main` at `8fd5a826f999214f435fdd8abc87484b25666f4d`.
The existing mounted-router inventory fixture has 116 distinct method/path entries;
`test/route-inventory.test.ts` checks it against the mounted app in CI. The
snapshot test also compares its method, path and auth labels with mounted
registrations and rejects malformed registration fields, duplicates and stale rows;
it does not validate proposed targets or migration behavior.
The earlier shared-control source audit was pinned
to `0b867c1842c6b516846d3fc28242d9c29ae0c7b9`; refresh its evidence for this
baseline. The subsequent public API unknown-path JSON fallback is a global error
handler, not a mounted registration, and must also be covered at cutover. The
route map is a source-preparation snapshot, not evidence of live traffic,
parity, an authorization decision, or permission to flip ownership. The map's
auth labels are the inventory's reviewed policy labels, not an enforcement test.

`test/fixtures/route-kit-map.json` records proposed targets and migration
classifications. API rows use the closed API slice and family allocation; page
cutovers and cross-family controls instead identify their responsible source and
owner without inventing a dispatch family. Middleware registrations are separate from endpoints. The RSVP
`ALL` registration and explicit admin 405 handlers are method fallbacks, not
middleware. The snapshot test checks registration drift and auth labels, but
does not validate classifications. The completion declaration guard checks mapped
target files for attempted completion; classification validation remains follow-up work.
Completed page sources also need their server-load
files; `/events` is an HTML-rendering endpoint rather than a Kit page. No slice
is certified complete by this snapshot, even if its target files exist.
Target paths for unfinished slices are proposals, not promises that a route
already exists. [ADR 0002](adr/0002-api-migration-amendment.md) prefers
endpoint-rendered Svelte for rejected native forms, subject to built-Worker
proof; the map's alternative targets have not yet been reconciled with that
direction and still prevent completion of the relevant slice. Legacy method,
URL, auth, validation, applicable entered values, errors and no-JavaScript
response contracts remain required.
Publish and duplicate can also re-render the event editor on validation failure;
RSVP instead returns a branded HTML refusal. Event API create/edit accept form
media types as well as JSON despite returning JSON. These distinct contracts
must not be collapsed into a single presumed form mechanism.
The global middleware chain applies to each consuming slice before cutover;
API-10 is its final retirement checkpoint, not permission to defer controls.
The mounted-chain audit identifies global response decorators, host and origin
checks, the admin and queue guards, and the member gate and read boundary. Its
consumer list is conservative for conditional HTML responses and does not cover
per-route shared budgets, body limits or fragment session/cache controls. Before
using that list to certify a checkpoint, join the source audit's route, method
and response-branch evidence matrix to this map and exact-head passing tests; a
single cited test or hook file cannot establish every applicable behavior. The
completion declarations in the fixture remain empty: the guard rejects every claimed
API slice and page/shared source until case-level evidence is integrated, even when
target files exist. API-10 is a retirement checkpoint rather than an ordinary
mapped slice; its completion declaration is also rejected until evidence is integrated.
Named matcher targets remain unsupported by the structural artifact check.

When expanding the shared-control audit, assign `POST /csp-reports` to API-3's
operations family, not API-9: the operations retirement register names the CSP
sink. Its separate bounded reader returns 204 on oversize or read failure; do
not substitute the generic body-limit 413 cases. The audit's API-9 label for
this route is not a change to the slice allocation. This source reconciliation
is not proof of branch reachability or passing parity tests.

Flags identify contracts requiring migration review, not proof of parity. `pageAndEndpoint` flags a planned Kit page and endpoint sharing a
route, where Kit's Accept routing or `Vary: Accept` needs review; it does not
mean that a Hono handler itself negotiates on Accept. Regex rest targets also
need their named matcher files before their slices can be complete. File existence
is only a completeness signal: it does not prove that a hook implements every
mapped gate or that a shared endpoint implements each method. Migration parity
and matcher precedence require separate behavioral tests.

The `/e/:file{.+\\.md}` target remains unresolved. Terminal matched-rest routes
rank below required `[key]` routes. The dormant per-event ICS endpoint uses
`/events/[key].ics` for the single-segment form and retains Hono's handling of
multisegment requests. The snapshot test checks inventory drift and the hosted
Worker fixture checks the mounted ICS route and its neighbors.

## Current-main source checkpoint

At `db46efed024e20b6bf823658767b8e3f8b4e04ac`, the tracked source delta
since the map's introduction at `57f1abbc25d0b39a77d83b46eb8b803b0249bb66`
contains only `src/route-ownership.ts` and the inactive Kit Worker facade and
response modules under `src/`. The inventory fixture, inventory helper and Hono
entry point are unchanged in that interval. The map currently has 116 rows:
99 endpoints, 11 method fallbacks and six middleware registrations; 86 are
allocated to API slices, 25 to page cutovers and five to cross-family controls.
This is a source-delta checkpoint, not a fresh mounted-app execution or a
classification validation. The existing inventory and snapshot tests must run
on the exact candidate head; their passing results are not asserted here.

The separate [case-evidence integration](https://github.com/TogetherWeOwn/two-web-next/pull/2310)
is in flight. It must not be mistaken for executed route parity, and this map
must remain incomplete until applicable case evidence is integrated and passes.
Concurrent page work includes the [home hero](https://github.com/TogetherWeOwn/two-web-next/pull/2294),
[home event band](https://github.com/TogetherWeOwn/two-web-next/pull/2295),
[calendar grid](https://github.com/TogetherWeOwn/two-web-next/pull/2289) and
[event seat card](https://github.com/TogetherWeOwn/two-web-next/pull/2291).
These are in-flight work, not proof that the corresponding page ownership or
response contract has changed. Reconcile their landed heads before any related
cutover or completion claim.

## Ownership overlaps

Consult `src/route-ownership.ts` for the current method-aware manifest and
`stagingManifestFor` for staging restrictions; a Kit file alone is not an
ownership entry. Shipped manifest entries marked enabled include GET `/events`,
`/events/past`, `/about`, `/faq`, `/admin/join-attempts`,
`/admin/join-attempts/:id`, `/hotzones`, concrete hotzone signal paths, and
`/leaderboards/members`. The Hono `GET /hotzones/:signal` registration overlaps
only the enabled concrete signal paths, not every possible parameter value.
Other manifest page entries include disabled admin, profile and event-detail
reads; these remain prospective overlaps, not enabled Kit ownership. Legacy
admin redirect entries are explicitly Hono-owned in the current manifest, even
where a future migration target is proposed. Exact static entries take
precedence over parameter patterns, and HEAD follows GET. A generic hotzone
parameter target must not be used as evidence that all signal values are
currently Kit-owned; the manifest enables only its concrete signal entries.

In particular, `GET /events` is enabled in the shipped manifest while the
separately registered `POST /events` has no matching POST ownership entry and
remains Hono-owned. The staging manifest may differ. This distinction matters
when the read and write families are migrated independently.

The standalone resolver accepts a dormant reservation release list for future
families. Each release requires an enabled manifest entry for the same method
and literal pathname. HEAD follows GET. Encoded aliases and Kit data URLs
remain reserved, as do adapter assets that reach the resolver. Dynamic feed
admission does not release any reserved path.

After Ember changes land, re-take and validate the mounted inventory, route map
and pure-Hono golden evidence against the then-current main revision. This
refresh is mandatory before shared dispatch integration or any production
family flip; this earlier snapshot does not satisfy that release checkpoint.
[`hooks.server.ts`](../web/src/hooks.server.ts) runs capture admission before
the existing request dispatcher. The dispatcher checks host and ownership
before Kit's same-origin check, shared session bridge and route guards. The
family selector runs only when the existing ownership lookup falls back to
Hono. Each family requires its own binding set to the literal string
`true`. A candidate must match the original method, pathname and mounted Kit
route ID. Static entries may release exact reserved pairs. Dynamic entries
require a pathname predicate and an explicit literal-path release to take
ownership of a reserved path. HEAD follows
GET. Conflicting claims and overlaps with disabled page ownership entries
fall back to Hono.

### Browser authentication endpoints

`KIT_ROUTE_AUTH=true` selects Kit for GET and HEAD on `/auth/discord`,
`/auth/discord/callback`, `/auth/discord/redirect`, `/auth/status`,
`/join/discord` and `/join/callback`, and POST on `/logout` and
`/logout/everywhere`. It also selects POST on `/auth/qa/:identity` when
`APP_URL` is exactly the staging URL. Other flag values, encoded aliases,
trailing slashes, Kit data URLs and other methods keep Hono's answer.
The `/join` and `/auth/recover` documents have their own ownership policy.

Both entry points register the same callback, use the same signed state and
session cookies, and consume the same one-time `auth` journey before provider
exchange. An in-flight sign-in can complete across a flag change. Kit checks
host and origin before the shared handlers run. The logout body cap runs
before the shared logout throttle and session revocation. The legacy
redirects, status probe and native HTML form submissions retain their
existing response contracts. Join shares the `join` journey namespace and
the same return cookies, redirect targets and HTML recovery. The native Join
and retry links keep the safe `next` and `source` parameters across owners.
The staging QA POST keeps the same identity and token gate before the action
body cap, throttle and session issuance. Production refuses QA sign-in even
if an auth flag and QA token are present.

The hosted installed-Worker fixture exercises both owners with synthetic
sessions and mocked provider responses, including no-JavaScript sign-out and
Join recovery.
Keep the binding unset in deployed configurations until the exact candidate
qualifies through the [production release gate](../CONTRIBUTING.md#production-release-gate).

### Admin serving

`KIT_ROUTE_ADMIN=true` enables moderator pages, native admin form POSTs, and
the operator overrides endpoint on canonical staging or HTTP loopback. The
operator endpoint uses its bearer independently of the moderator cookie. The
existing Hono guard serves legacy redirects and other unowned admin paths.
The exact `GET /admin/events/create` endpoint also has a disabled manifest
entry. When enabled within the admin dispatcher, it requires a moderator and
returns `301 Location: /admin/events/new` with no query. HEAD uses the same
redirect without rotating the session. The disabled entry still takes
precedence over the parameterized edit form.

`KIT_ROUTE_ADMIN_QUEUE_PREVIEW=true` selects Kit for the exact queue preview GET
on canonical staging or HTTP loopback. With the binding absent or false, Hono
owns the request. HEAD, other methods, encoded paths, trailing slashes and Kit
data requests continue through Hono. The queue preview's separate staging-only
admission, moderator session, dedicated operator check and operational audit
apply under both owners. Keep the ownership binding unset in deployed Workers
until a separate qualification.

### Security disclosure endpoint

`KIT_ROUTE_SECURITY_TXT=true` admits trusted GET and HEAD on the literal
`/.well-known/security.txt`. Hono owns it by default and handles other methods,
host refusals, encoded paths, trailing slashes, and Kit data URLs. The response
uses the shared disclosure text, including a `Canonical` field from HTTPS
`APP_URL`, and keeps its one-hour public cache policy. It requires no database
or session access.

### Profile writes

`KIT_ROUTE_PROFILE_WRITES=true` admits PATCH and the default form POST on
`/members/:user`. The shared host and origin gates precede the body cap, then
the shared signed session, per-viewer throttle and owner checks. The native
POST retains the `_method=PATCH` form contract. GET and HEAD use their existing
owners, including the frozen `/members` and `/members/` 404s. Leave the flag
unset in deployed configuration until activation is qualified.

### Search indexing endpoints

`KIT_ROUTE_SEO=true` selects GET and HEAD on `/robots.txt` and
`/sitemap_index.xml`. An unset or false binding, encoded or trailing-slash
aliases, Kit data URLs and other methods stay with Hono. `/sitemap.xml` keeps
its Hono 404. Both successful responses use the configured `APP_URL` and keep
the one-hour public cache policy. Robots is database-free. The sitemap charges
the shared public events-read budget once and lists the static URLs plus the
bounded, renderable published events.

Before activating the binding, qualify the exact candidate through the
[production release gate](../CONTRIBUTING.md#production-release-gate). Verify
both endpoints return to Hono when the binding is cleared, accounting for
cached responses. Check delivery under the existing Tail Worker rules for the
two registered route labels as part of release verification.

### Static text and vanity redirects

`KIT_ROUTE_STATIC_TEXT=true` selects Kit for exact GET and HEAD requests to
`/llms.txt`, `/about.md`, `/faq.md`, `/rules.md`, `/privacy.md`, `/join.md`,
`/community`, `/discord`, and `/login`. Keep the binding unset in deployed
configurations until approval through the
[production release gate](../CONTRIBUTING.md#production-release-gate).
Clearing it returns the next uncached request to Hono. Encoded aliases,
trailing slashes, Kit data URLs, other methods, and event Markdown stay
with their existing owner.

The shared Markdown responses retain their byte-derived validators, staging
noindex policy, and one-hour public cache. Vanity redirects stay private and
uncacheable, with the existing invite fallback and safe login destination.
The hosted installed Worker fixture exercises both owners without member data.

### Feed endpoints

`KIT_ROUTE_FEEDS=true` selects GET and HEAD on `/events.ics`, `/events.rss`
and `/events/<key>.ics`, plus the session-gated `/events.json` collection.
An absent or false binding leaves ownership with Hono.
The per-event route requires the literal mount and suffix with a single key
segment. Encoded key bytes follow Hono's parameter decoding. Trailing slashes,
encoded mount or suffix aliases and multisegment forms go to Hono.

The shared handlers charge the `events-read` bucket before reading events.
Kit supplies the request ID, global response headers and completion log.
Within ICS and RSS, only a per-event draft resolves the signed session. The
handler checks moderator access before honoring validators and delivers
renewal cookies on GET and HEAD when the shared session reader rotates it.
The JSON collection runs a non-rotating session check before accepting a
validator. Its published event projection varies by Cookie and Accept and
successful responses use `private, no-cache`.

The hosted built-Worker fixture checks the compiled Kit manifest against the
mounted Hono inventory, then compares feed bytes, validators, success and
refusal headers, and shared budget charges across absent, off and on bindings.
It exercises trailing slashes, encoded and data URL variants, wrong methods,
an existing Kit page and the reserved Hono `/version` read. Per-event cases
cover published, cancelled, missing and draft rows with anonymous, member and
moderator requests.

Before activating the flag, qualify the exact candidate with staging feed and
rollback checks through the [production release gate](../CONTRIBUTING.md#production-release-gate).
Use all four feed paths to confirm that clearing the binding returns requests
to Hono. Account for the existing 300-second cache lifetime on ICS and RSS.
The ICS and RSS collections are public-cacheable and single-event downloads
are private-cacheable.

### Operational endpoints

`KIT_ROUTE_OPS=true` selects Kit for exact POST `/csp-reports` and
`/__probe/alert`, and GET and HEAD `/up` and `/version`. Hono owns the
routes by default and handles other methods, path aliases and Kit data URLs.
The CSP sink keeps its exact origin exemption and returns 204 on oversize or
timeout. The alert probe keeps the origin and staging QA gates, then the body
cap and throttle. The existing queue and request alert run only after admission.
The built and installed Worker fixture uses synthetic inputs, counts diagnostics
and intercepts the queue and outbound network.

### Agent event ingress

`KIT_ROUTE_AGENT_EVENTS=true` selects Kit for exact POST `/api/agent-events`.
Other methods, aliases and Kit data URLs fall through to Hono. Both owners
share the ingress kill switch, byte cap, bearer grant admission, rate budgets,
and idempotency store. The installed Worker fixture checks draft creation,
replay across the flag change, refusals and zero outgoing dispatch.

The binding is unset in deployed configurations. Clearing it restores Hono on
the next request. Activation follows the
[production release gate](../CONTRIBUTING.md#production-release-gate).

### Event Markdown endpoints

`KIT_ROUTE_EVENT_MARKDOWN=true` selects GET and HEAD on `/events.md` and
`/e/<key>.md` with a literal mount and suffix and one non-empty key segment.
These reads use the same `events-read` budget as Hono and charge it before
canonical redirects and conditional requests. The collection lists upcoming
published rows. Detail reads are session-free, including the draft 403 for
moderators, the cancelled 410, the missing 404 and the past `noindex` response.

The Markdown endpoint takes precedence over the generic event page when both
are mounted. When the flag is off, Hono serves the suffix path even if the Kit
event page is enabled. Encoded mount and suffix variants, trailing slashes,
Kit data URLs, other methods and multisegment variants continue to Hono. The
bare `/e/.md` path follows the generic event page route.

Qualify the exact candidate through the [production release gate](../CONTRIBUTING.md#production-release-gate)
before activating the binding. Clearing it restores Hono. Cached successful
responses can remain fresh for five minutes.

### Event detail JSON, public event reads and OpenAPI

`KIT_ROUTE_EVENT_JSON=true` admits GET and HEAD on `/events/<key>`. The handler
keeps the non-rotating session check, private cache policy, the viewer's own
waitlist position and moderator-only draft visibility. `/events/past` and
per-event `.ics` keep their existing owners.

`KIT_ROUTE_PUBLIC_API=true` admits GET and HEAD on `/api/public/events`,
`/api/public/events/<key>`, `/api/public/community`, `/api/public/join` and
`/openapi.json`. The API reads share the existing session-free projections,
read budget and one-minute cache. OpenAPI uses `APP_URL`
and retains its one-hour public cache policy. Unknown paths in the public API
namespace still use Hono's JSON fallback.

For both families, encoded aliases, trailing slashes, data URLs and other
methods stay with Hono. The hosted installed-Worker fixture compares the JSON
registrations with the API-4 inventory and checks response and ownership parity
with the bindings unset, `false` and `true`. Keep the bindings unset in deployed
configuration until separately qualified through the
[production release gate](../CONTRIBUTING.md#production-release-gate).

### Inbound machine endpoints (API-9)

Hono serves both machine routes by default. The
[`apiFamilies` selector](../src/route-ownership.ts) admits ownership separately
for each family:

| Follow-on | Exact method and pathname | Kit ownership setting |
| --- | --- | --- |
| [MCP transport](https://github.com/TogetherWeOwn/two-web-next/pull/2783) | `POST /mcp`, `OPTIONS /mcp` | `KIT_ROUTE_MCP` |
| Agent event ingress | `POST /api/agent-events` | Separate ingress ownership binding |

Keep both settings off by default. Only the literal string `true` on the
family's binding can admit its listed pairs. The original pathname must match
the mounted `+server` route ID. Other methods, including GET and HEAD, encoded
aliases, trailing slashes, Kit data requests and conflicting claims fall
through to Hono. Clearing one binding restores Hono for that family. The
ingress ownership switch is independent of the existing `AGENT_EVENTS_ENABLED`
service gate. `reads: "public"` lets the shared route handler own admission
without running the Kit browser-session bridge.

- Reuse the Hono route admission and handlers under both owners. Preserve the
  trusted host check, exact POST origin exemptions and MCP's own Origin
  policy. MCP is stateless and session-free. Its OPTIONS preflight spends no
  read budget and opens no database. Ingress uses its scoped machine bearer,
  grant checks, rate limits and idempotency independently of browser cookies.
  See the [MCP registration](../src/mcp/routes.ts) and [ingress contract](agent-events.md).
- Preserve the shared 32 KiB POST cap for both advertised and actual streamed
  bytes before parsing, budget charges or side effects. Keep 413 on overflow
  and 400 on a failed upload read. MCP spends the shared public-read budget
  once before JSON parsing and batch rejection. MCP upload refusals use
  JSON-RPC. Ingress upload refusals occur before ingress admission and use the
  generic API JSON shapes, `{ error: "bad_request", message }` for 400 and
  `{ reason: "payload_too_large", message, request_id }` for 413. Admitted
  requests keep their route-native responses, including MCP SSE and the agent
  ingress JSON refusal envelope. Preserve media types, cache policy,
  `Retry-After` and correlation IDs for each branch. See the
  [upload response builders](../src/error-responses.tsx) and
  [machine error contracts](machine-errors.md).
- Correlate diagnostics by registered route, method, status, validated or minted
  request ID and sanitized error class. Preserve the ingress shield's bounded
  counters and keep ordinary client refusals out of paging. Exclude bearer
  values, cookies, URLs and query strings, payloads, raw errors and member
  data from logs and evidence. See the [request logger](../src/request-log.ts)
  and [alert formatter](../src/alerts.ts).
- Pass the incoming `request.signal` to downstream operations that support
  cancellation. Give held work a deadline and release readers, timers and
  listeners on completion or abort. Use `waitUntil` for bounded cleanup such as
  closing an ingress-owned SQL client. The injected fixture client has its own
  lifecycle. A stream reader cancel and an incoming HTTP disconnect require
  separate evidence. The tracked Worker configs use **2026-09-29** with no
  `enable_request_signal` opt-in. Cloudflare enables it by default from
  **2026-11-17** unless `disable_request_signal` is set. The direct loopback
  fixture explicitly opts in at the earlier date. Verify the exact candidate's
  effective flags and disconnect behavior before any family flip. See
  [ADR 0002](adr/0002-api-migration-amendment.md#technical-decisions).

The [Hono fetch baseline](https://github.com/TogetherWeOwn/two-web-next/pull/2645)
covers MCP handshake, input and result bounds, and ingress create/update,
refusal and replay. The installed Kit Worker fixtures exercise Hono-owned
machine routes at this baseline. The [streaming fixture](../ci/fixtures/kit-machine-parity.mjs)
checks synthetic ingress JSON, one complete MCP SSE frame through EOF, and
reader cancellation. The [disconnect fixture](../ci/fixtures/kit-machine-disconnect.mjs)
resets a real loopback socket during a held read. The fixture wrapper listens
to `request.signal` directly and observes incoming abort, fake-read settlement
and the wrapper's `waitUntil` cleanup. The MCP follow-on runs these fixtures
with Kit selected and with Hono fallback, checking renderer ownership, session
independence, refusals, the shared read bucket and SSE completion and
cancellation. The TCP reset covers both ownership modes with request signals
enabled on the direct loopback listener.

Each follow-on must extend installed-Worker evidence on its exact head. Check
unset, off and on settings, Hono fallback for unlisted pairs, unchanged
admission and error branches, MCP stream and disconnect cleanup, and ingress
refusal and replay across ownership changes. Use synthetic credentials and
rows, intercept outbound fetch and queue calls, and assert zero real sends.
Keep transport and ingress fixture results independently attributable.

Before integrating either family in the live shared dispatcher or flipping a
production binding, refresh and revalidate the post-Ember inventory, route map
and pure-Hono golden evidence. Before enabling MCP in production, prove
downstream abort by having a held operation observe the signal it receives
through the handler.
Before an ingress flip, inventory the effective database bindings and prove
the dedicated `AGENT_DB` connection path or its nullish fallback as specified
in ADR 0002. Production family admission follows M0, including the Kit Worker's
48-hour acceptance, and requires release-log confirmation of the cited live
page sources, exact-candidate parity and Actions evidence, applicable Security
then QA reviews, and the [production release gate](../CONTRIBUTING.md#production-release-gate).

## Offline retirement guard

The Kit archive parity job sets `KIT_RETIREMENT_GUARD=report` and requires the
build's report. It lists Hono dependencies in the emitted SSR graph and legacy
method/path pairs without native Kit coverage. The check reuses the mounted
inventory, proposed targets, and synthetic parity samples, including multisegment paths.
The `unownedByFamily` field groups the same findings by the route map's family
and exact legacy method, including `ALL` for wildcard method fallbacks. Entries
without a family, including page cutover rows, appear under `unresolved`.

`honoRemoval` links SSR `chunks` to Kit `entrypoints` and exact `units` with
route-map registrations and owners. Page units include their `+page.server.ts`
companions. API-10 covers the catch-all and the hook's Hono bridge import.
`lazyChunks` lists dynamic targets, importers and Hono-bearing static dependencies.
`unownedImporters` names Kit sources without a mapped unit. Paths without a Kit
entrypoint are `unowned`. Check shared exports and route parity before removal.

With locked dependencies installed, run `KIT_RETIREMENT_GUARD=strict npm run build --prefix web`
to fail before generating new adapter output when either blocker remains.
An ordinary build calls the stock adapter. The source baseline has 99 endpoints
and 11 method fallbacks. Six middleware registrations, matcher behavior, assets,
content negotiation and error handling need separate built-Worker parity evidence.

The [installed Worker admin fixture](../ci/fixtures/kit-admin-serving.mjs) compares
direct Hono with the installed Kit Worker on loopback. It checks the static
create form and seeded edit form alongside the exact `/admin/events/create`
redirect in both ownership modes. The loopback-only override exercises the
native 301, query dropping, moderator admission and session renewal. The fixture
also checks the legacy edit redirect, the existing POST controller, and the
trailing-slash, data suffix, percent-encoded, malformed and case-variant paths.
For API-5, the fallback fixture compares the disabled Hono queue preview guard
with Hono's earlier source-evidence handler. The two JSON refusals identify
which branch answered before the moderator gate.

The installed Worker also compares native queue preview with direct Hono using
synthetic sessions and a disposable database.
It checks the exact owner, default-off fallback, admission and refusal
responses, one operational audit receipt per successful preview, and refusal
when the audit insert fails. Native source evidence, remaining middleware
registrations and named matcher targets still need installed Worker evidence.

Retirement follows the [all-off cutover and Hono undo](kit-cutover-release.md),
M0 and production parity for every live page and API family. Record each
registration's disposition and every cutover's post-release watch. Recheck the
full installed candidate, including the adapter and jobs, for Hono dependencies.
Measure bundle size and cold start again, then qualify the exact retirement
candidate and rollback through the [production release gate](../CONTRIBUTING.md#production-release-gate).
