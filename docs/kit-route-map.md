# Hono registration to Kit target plan

Baseline: `origin/main` at `8fd5a826f999214f435fdd8abc87484b25666f4d`.
The existing mounted-router inventory fixture has 116 distinct method/path entries;
`test/route-inventory.test.ts` checks it against the mounted app in CI. That check
has not yet run on this baseline. The earlier shared-control source audit was pinned
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
middleware. This snapshot does not yet have a mapping guard. A follow-up must
compare it with the mounted router, reject stale or missing rows, and check target
files for attempted completion. Completed page sources also need their server-load
files; `/events` is an HTML-rendering endpoint rather than a Kit page. No slice
is certified complete by this snapshot, even if its target files exist.
Target paths for unfinished slices are proposals, not promises that a route
already exists. Unresolved form targets list alternatives for the pending API-0b
ADR decision; they are not selected mechanisms, and prevent completion of the
relevant API slice. They retain the legacy method, URL, auth, validation,
entered values, errors and no-JavaScript response contract until that decision.
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
follow-up completion guard must reject every completed slice and page/shared
source until case-level evidence is integrated, even when target files exist.
API-10 is a retirement checkpoint rather than an ordinary mapped slice and also
requires evidence before completion. This snapshot does not enforce those rules.

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

After Ember changes land, re-take and validate the mounted inventory, route map
and pure-Hono golden evidence against the then-current main revision. This
refresh is mandatory before shared dispatch integration or any production
family flip; this earlier snapshot does not satisfy that release checkpoint.
