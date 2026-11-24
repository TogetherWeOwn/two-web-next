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

The `/e/:file{.+\\.md}` and `/events/:file{.+\\.ics}` targets remain
unresolved. Terminal matched-rest routes rank below the required `[key]` routes,
so they would misroute ordinary single-segment suffix requests. A future route
set must prove precedence and preserve single- and multi-segment behavior, auth,
responses and URL semantics before either affected slice can be completed. The
snapshot test does not enforce this prerequisite or validate the selected design.

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
remain reserved, as do adapter assets that reach the resolver. The serving
hook supplies no API family catalog, so the dispatcher releases no pairs.

After Ember changes land, re-take and validate the mounted inventory, route map
and pure-Hono golden evidence against the then-current main revision. This
refresh is mandatory before shared dispatch integration or any production
family flip; this earlier snapshot does not satisfy that release checkpoint.
[`hooks.server.ts`](../web/src/hooks.server.ts) runs capture admission before
the existing request dispatcher. The dispatcher checks host and ownership
before Kit's same-origin check, shared session bridge and route guards. The
dormant family selector runs only when the existing ownership lookup falls
back to Hono. Each family requires its own binding set to the literal string
`true`. A candidate must match the original method and pathname as well as a
mounted, static Kit route ID. The entry supplies its own exact reservation
release and read policy. HEAD follows GET. Conflicting claims from opted-in
families fall back to Hono.

In the first family integration PR, mount the ready `+server.ts` handlers and
pass that family's reviewed catalog and binding to `dispatchHookRequest`.
Validate every configured pair against the mounted inventory and reject
duplicate claims. Check that each `+server.ts` exports the configured method.
A static Kit route ID can also refer to a page. Keep request-specific auth,
body caps and throttles on their existing shared helpers in the handler's
established order. Extend the
built Worker fixture to turn that one family on and back off and check method
refusals, slash variants and `/<route>/__data.json`. Production activation
follows its own release gate.
