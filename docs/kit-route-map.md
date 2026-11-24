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
require a pathname predicate and leave reserved paths to Hono. HEAD follows
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

### Security disclosure endpoint

`KIT_ROUTE_SECURITY_TXT=true` admits trusted GET and HEAD on the literal
`/.well-known/security.txt`. Hono owns it by default and handles other methods,
host refusals, encoded paths, trailing slashes, and Kit data URLs. The response
uses the shared disclosure text, including a `Canonical` field from HTTPS
`APP_URL`, and keeps its one-hour public cache policy. It requires no database
or session access.

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

### Feed endpoints

`KIT_ROUTE_FEEDS=true` selects GET and HEAD on `/events.ics`, `/events.rss`
and `/events/<key>.ics`. An absent or false binding leaves ownership with Hono.
The per-event route requires the literal mount and suffix with a single key
segment. Encoded key bytes follow Hono's parameter decoding. Trailing slashes,
encoded mount or suffix aliases and multisegment forms go to Hono.

The shared handlers charge the `events-read` bucket before reading events.
Kit supplies the request ID, global response headers and completion log. Only
a per-event draft resolves the signed session. The handler checks moderator
access before honoring validators and delivers session renewal cookies on
GET and HEAD when the shared session reader rotates the session.

The hosted built-Worker fixture checks the compiled Kit manifest against the
mounted Hono inventory, then compares feed bytes, validators, success and
refusal headers, and shared budget charges across absent, off and on bindings.
It exercises trailing slashes, encoded and data URL variants, wrong methods,
an existing Kit page and the reserved Hono `/version` read. Per-event cases
cover published, cancelled, missing and draft rows with anonymous, member and
moderator requests. Event JSON and the public API keep their current owners.

Before activating the flag, qualify the exact candidate with staging feed and
rollback checks through the [production release gate](../CONTRIBUTING.md#production-release-gate).
Use all three feed paths to confirm that clearing the binding returns requests
to Hono. Account for the existing 300-second cache lifetime. The collections
are public-cacheable and single-event downloads are private-cacheable.

## Offline retirement guard

The Kit archive parity job sets `KIT_RETIREMENT_GUARD=report` and requires the
build's report. It lists Hono dependencies in the emitted SSR graph and legacy
method/path pairs without native Kit coverage. The check reuses the mounted
inventory, proposed targets, and synthetic parity samples, including multisegment paths.

With locked dependencies installed, run `KIT_RETIREMENT_GUARD=strict npm run build --prefix web`
to fail before generating new adapter output when either blocker remains.
An ordinary build calls the stock adapter. The source baseline has 99 endpoints
and 11 method fallbacks. Six middleware registrations, matcher behavior, assets,
content negotiation and error handling need separate built-Worker parity evidence.

Retirement follows the [all-off cutover and Hono undo](kit-cutover-release.md),
M0 and production parity for every live page and API family. Record each
registration's disposition and every cutover's post-release watch. Recheck the
full installed candidate, including the adapter and jobs, for Hono dependencies.
Measure bundle size and cold start again, then qualify the exact retirement
candidate and rollback through the [production release gate](../CONTRIBUTING.md#production-release-gate).
