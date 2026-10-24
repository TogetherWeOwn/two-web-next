# Kit journey, visual and performance parity gates

Card 9/43 of the SvelteKit migration. These gates prove every migrated Kit
route renders the Hono contract before it owns traffic. They flip with
`src/route-ownership.ts` `ROUTE_MANIFEST.enabled`, never with a hard-coded
renderer name: disabling an entry rolls the route back to Hono and the gates
expect Hono for the right reason.

## Route inventory

| Route | Kit handler | Reads | Owner today |
| --- | --- | --- | --- |
| `GET /` | `web/src/routes/+page.svelte` (`csr=false`, shared `src/home-copy` + readers, no island) | public | Hono (`enabled: false`) |
| `GET /events/past` | `web/src/routes/events/past/+page.svelte` (`csr=false`, shared `/islands/past-events.js`) | public | Kit (`enabled: true`) |
| `GET /events` | `web/src/routes/events/+server.ts` (no Svelte page, so no client entries/node; Hono calendar screen bytes via `src/kit-events-html.tsx`, shared `/islands/events-calendar.js`; `POST /events` and `/events.json` stay Hono) | public | Kit (`enabled: true`) |
| `GET /about` | `web/src/routes/about/+page.svelte` (`csr=false`, shared `ContentLeaf.svelte`, `src/about-content.ts`) | public | Kit (`enabled: true`) |
| `GET /privacy` | `web/src/routes/privacy/+page.svelte` (`csr=false`, shared `POLICY_MARKDOWN`/`POLICY_VERSION` source, no island) | public | Hono (`enabled: false`) |
| `GET /rules` | `web/src/routes/rules/+page.svelte` (`csr=false`, shared `ContentLeaf.svelte`, `src/rules-content.ts`) | public | Hono (`enabled: false`) |
| `GET /faq` | `web/src/routes/faq/+page.svelte` (`csr=false`, shared `ContentLeaf.svelte`, `src/faq-content.ts`) | public | Kit (`enabled: true`) |
| `GET /join` | `web/src/routes/join/+page.svelte` (`csr=false`, shared `/islands/join-widget.js`; `/join/discord` + `/join/callback` stay Hono) | public | Hono (`enabled: false`) |
| `GET /admin` | `web/src/routes/admin/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome and `/islands/auth-status.js` tab-sync controller, `decideKitAdminGuard` layout guard, signed probe cookie appended by the hook only to successful moderator admin documents, bounded `dashboardJoinFunnel`/`topZeroResultSearches` widgets with a classified-outage 503 mapping) | dashboard/view (`admin.dashboard`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/featured` | `web/src/routes/admin/featured/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, bounded shared `listFeatured` read with the Hono filter/sort/page shape and a classified-outage 503 mapping, publish/window status via the shared `featuredStatus()`, no page-specific island beyond the shared `/islands/auth-status.js` shell tab-sync controller; the new link targets the Kit `/admin/featured/new` page, the edit links target the Kit `/admin/featured/:id` page, and the guarded `/admin/featured-contents` legacy redirects stay Hono) | featured_contents/list (`admin.featured.index`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/featured/new` | `web/src/routes/admin/featured/new/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, private no-store, no database read, plain POST form to the Hono-owned `POST /admin/featured` with the exact Hono field names and hint copy, the shared `/islands/auth-status.js` shell tab-sync controller plus the deferred dirty-draft/double-submit guard island (`data-event-editor` + `/islands/admin-event-editor.js`, progressive with `csr=false`); the create handler — `parseFeaturedForm` + `createFeatured`, 422 re-render / 303 redirect — and the guarded `/admin/featured-contents/create` legacy redirect stay Hono) | featured_contents/view (`admin.featured.create`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/featured/:id` | `web/src/routes/admin/featured/[id]/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, private no-store, shared `getFeatured` read with the Hono canonical-ID admission and a classified-outage 503 mapping, form values in the exact Hono `featuredValues()` shape, preview status via the shared `featuredStatus()`, plain POST forms to the Hono-owned `POST /admin/featured/:id` and `POST /admin/featured/:id/delete` with the exact Hono field names and hint copy, the shared `/islands/auth-status.js` shell tab-sync controller plus the deferred dirty-draft/double-submit guard island (`data-event-editor` + `/islands/admin-event-editor.js`, progressive with `csr=false`) on the edit form, the delete action as a POST form (never a link); the edit/delete handlers — `parseFeaturedForm` + `updateFeatured`/`deleteFeatured`, 422 re-render / 303 redirect — and the guarded `/admin/featured-contents/:id/edit` legacy redirect stay Hono) | featured_contents/view (`admin.featured.edit`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/activity-log` | `web/src/routes/admin/activity-log/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title and `/islands/auth-status.js` tab-sync controller, `decideKitAdminGuard` layout guard, shared `listActivityLog` projection with bounded subject/causer filters and newest-first paging plus a one-row lookahead, shared `formatActivityCauser` legacy labeling, ISO `<time datetime>` instants, no `properties` selection or render; hook appends the signed probe cookie only to successful moderator admin documents) | activity_log/list (`admin.activity-log.index`, bridged moderator viewer; snowflake causers audited, legacy/null causers contribute no subject) | Hono (`enabled: false`) |
| `GET /admin/events` | `web/src/routes/admin/events/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, shared bounded `listEvents` helper with a classified-outage 503 mapping, no page-specific island beyond the shared `/islands/auth-status.js` shell tab-sync controller; only this GET migrates — `POST /admin/events`, `/new` and `/:key` stay Hono-owned, so the row forms keep submitting to the unchanged Hono handlers) | events/list (`admin.events.index`, bridged moderator viewer; subject-free `events` + `going-counts` reads, like the Hono handler) | Hono (`enabled: false`) |
| `GET /admin/events/new` | `web/src/routes/admin/events/new/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, empty `buildEventCreateView` with the Hono 422 values/errors shape, private no-store, shared `/islands/auth-status.js` shell tab-sync controller plus `/islands/admin-event-text-limits.js` + `/islands/admin-event-editor.js` progressive islands; only this GET migrates — `POST /admin/events` stays Hono-owned, so draft-first creation, weekly recurrence (max 52), wall-time/timezone validation, body cap, throttle, error aggregation, retained values and the 303 keep one authority, and the guarded `/admin/events/create` legacy redirect stays Hono) | events/view (`admin.events.create`, bridged moderator viewer; no store read on fresh GET, like the Hono handler) | Hono (`enabled: false`) |
| `GET /admin/events/create` | none (exact disabled manifest pin, no Kit handler; the guarded legacy redirect stays Hono-owned so the `:key` pattern cannot capture `/create` once enabled) | — (no declaration; Hono-owned) | Hono (`enabled: false`) |
| `GET /admin/events/:key` | `web/src/routes/admin/events/[key]/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, shared `getEvent` read with the Hono wall-value/status/series shape plus the Hono 422 values/errors shape, shared bounded `listRoster` page with the Hono search/sort/paging copy and a classified-outage 503 mapping, private no-store, plain POST forms to the Hono-owned edit/publish/cancel/RSVP-pause/RSVP-reopen endpoints, shared `/islands/auth-status.js` shell tab-sync controller plus `/islands/admin-event-text-limits.js` + `/islands/admin-event-editor.js` progressive islands, no removal affordance; only this GET migrates — the update, transition and guarded `/:key/edit` legacy routes stay Hono-owned, so UTC carriers, future recurrence propagation and postcommit writeback keep one authority) | events/view (`admin.events.edit`, bridged moderator viewer; roster members audited, failed audit refuses the whole render) | Hono (`enabled: false`) |
| `GET /admin/join-attempts` | `web/src/routes/admin/join-attempts/+page.svelte` (`csr=false` via the group layout, shared `listJoinAttempts`/`parseJoinAttemptsQuery`/`joinAttemptsUrl` reads with the retention window and exact Discord/request-id search, classified-outage 503 mapping, private no-store, no page-specific island beyond the shared `/islands/auth-status.js` shell tab-sync controller; the detail links target the Kit detail page below) | join_attempts/list (`admin.join-attempts.index`, bridged moderator viewer) | Kit (`enabled: true`) |
| `GET /admin/join-attempts/:id` | `web/src/routes/admin/join-attempts/[id]/+page.svelte` (`csr=false` via the group layout, shared `getJoinAttempt` retention-window lookup with the Hono canonical-ID admission, classified-outage 503 mapping, private no-store, no page-specific island beyond the shared `/islands/auth-status.js` shell tab-sync controller; same outcome/source/time/trace fields, em-dash fallbacks and back navigation as the Hono detail, no raw provider/token payload) | join_attempts/view (`admin.join-attempts.show`, bridged moderator viewer) | Kit (`enabled: true`) |
| `GET /auth/recover` | `web/src/routes/auth/recover/+page.svelte` (`csr=false`, shared `#lib/Recovery.svelte` over the `RecoveryModel` shape; journey writes + `/join/callback` outcomes stay Hono, rendered through the injected outcome renderer) | public | Hono (`enabled: false`) |
| `GET /profile` | `web/src/routes/profile/+page.svelte` (`csr=false`, one shared `web/src/lib/ProfileView.svelte`, member record + optional stats) | member (`profile`/`view`/`profile`) | Hono (`enabled: false`) |
| `GET /members/:user` | `web/src/routes/members/[user]/+page.svelte` (same shared view; retired `/members` directory has no route) | member (`profile`/`view`/`profiles.show`) | Hono (`enabled: false`) |
| `GET /hotzones` | `web/src/routes/hotzones/+page.svelte` (`csr=false`, thin binding over `loadHotzonesIndexData` in `src/kit-hotzones.ts`, shared `renderHotzoneGrid`; season grammar 400s before any read, outage 503, anonymous board-view log, same `public, max-age=300` as the Hono handler) | public | Kit (`enabled: true`) |
| `GET /hotzones/joins` | `web/src/routes/hotzones/[signal]/+page.svelte` (`csr=false`, thin binding over `loadHotzoneSignalData` in `src/kit-hotzones.ts`, shared `renderHotzoneGrid`; locked joins/voice/games vocabulary with unknown segments 404, live joins aggregate, same 400/503/log/cache shape as the Hono handler) | public | Kit (`enabled: true`) |
| `GET /hotzones/voice` | `web/src/routes/hotzones/[signal]/+page.svelte` (same binding; serves the estimated prior grid, never a live aggregate) | public | Kit (`enabled: true`) |
| `GET /hotzones/games` | `web/src/routes/hotzones/[signal]/+page.svelte` (same binding; serves the estimated prior grid, never a live aggregate) | public | Kit (`enabled: true`) |
| `GET /e/:key` | `web/src/routes/e/[key]/+page.svelte` (`csr=false`, one shared `web/src/lib/EventDetail.svelte` over the `KitEventDetailModel` shape, existing `/islands/rsvp-button.js` + `/copy-link.js` + `/going-count.js`; JSON/ICS stay Hono-owned) | member (`member`/`list`/`events.page`, bridged viewer; disclosed attendee + own-RSVP subjects audited, anonymous releases with none) | Hono (`enabled: false`; enablement blocker: the RSVP companion — the detail read renews the sliding session post-release, matching Hono's re-stamp) |
| `GET /leaderboards/members` | `web/src/routes/leaderboards/members/+page.svelte` (`csr=false`, thin binding over `src/kit-members.ts`: same gate order, season/scope/activity grammar, ranking read and `private, no-store` as `src/leaderboards/routes.tsx`; the anonymous board-view log is queued by the load and written after the member-read boundary releases a 200, never inside its capture) | leaderboard (`leaderboard`/`list`/`leaderboards.members`, bridged viewer) | Kit (`enabled: true`; enabled after the executed parity journey below earned the fresh privacy verdict) |
| everything else | none yet (Kit `[...path]` catch-all → `honoFetch`) | — | Hono |

The member board and the held profile twins reuse the existing auth-status
controller for stale-tab recovery and bounded sign-out. The dispatch hook adds
it only to authenticated member full HTML GETs on these three owned manifest
entries, after the exact buffered response clears the member-read audit boundary.
Only then may it attach the signed read-only status probe; HEAD, fragments, data,
refused reads and public pages gain neither. The probe never authenticates a
member or renews the server session. Admin probe behavior remains separate,
including its existing fragment-cookie scope. Profile holds above remain unchanged.
`test/kit-member-auth-documents.test.ts` covers the real dispatch/bridge/audit/SSR
path; `ci/kit-member-auth-browser.test.mjs` executes two-page Chromium fixtures
against the minified controller (expiry versus 503, dirty drafts, successful,
refused and ten-second uncertain sign-out). The `a11y` job TAP-verifies all 15
browser cases; the Hono-only visual/Lighthouse gates do not exercise Kit routes.

Add one row per migrated route with its reads class (`public` routes render
outside the member-read boundary; anything else is member data). The gates
derive the expected `x-two-renderer` marker from the shipped manifest; a
hard-coded `"kit"` expectation is a finding.

## QA lane ordering

In the `check` job, Kit gates run after shell/runtime basics and before any
claim of journey parity:

1. Kit workspace install + `svelte-check` (shell basics)
2. `node ci/kit-preview-e2e.mjs` (archive route only: section contract,
   Hono pg-proxy bundle vs Kit SSR bundle, plus the browser shell fixture)
3. `node ci/kit-parity-gates.mjs` (unit by default, preview when both
   preview URLs are set; unit mode exercises the hot-zone and
   member-board contract branches on canonical fixtures — per-entry
   iteration over every `PARITY_ROUTES` entry, including the four
   hot-zone paths, `?page=2` and the admission variants, happens only
   in preview mode)
4. `npm run build --prefix web`, then `node ci/check-kit-perf.mjs` (worker +
   generated-asset budgets against the measured baselines)
5. `node ci/kit-worker-e2e.mjs` (built Worker archive route; `/about` and
   `/faq` Kit marker, public cache header, CSP leaf hash and zero-stylesheet
   contract; API dispatch, cross-origin form refusal and public favicon)

Steps 1–5 spend no logins. Step 3 runs in unit mode in CI: no workflow sets
the preview URLs or `KIT_PARITY_QA_TOKEN`. Preview-mode member-board checks
are an operator-run gate and spend one QA login per base only when the token
is set. The only authenticated Kit-parity journey in CI is `e2e:kit-parity` in
`browser-smoke` (member board, one shared QA login); the critical `npm run e2e`
journeys in the same job log in separately. The parity suite's raw
no-JavaScript API checks fetch all four hot-zone paths on both targets
(`e2e/kit-parity/parity.spec.ts:351-431`). Its rendered browser journey currently
loads `/hotzones`, follows `/hotzones/joins`, and directly loads `/hotzones/voice`
and `/hotzones/games` at desktop (1280×800) and mobile (390×844) widths
(`parity.spec.ts:858-936`). That proves each page responds and contains a
heading/grid region, but voice and games still need the content-specific
assertions in the acceptance contract below. CI also covers shared helper
branches through the canonical `/hotzones` fixture in the step-3 unit contract
and the hot-zone Vitest suites. Preview fetches are operator-run evidence, not
CI evidence.

### Voice and games rendered acceptance contract

The next implementation slice is limited to strengthening the existing public,
read-only browser journey in `e2e/kit-parity/parity.spec.ts`; it does not add a
new fixture, credential, staging/production data dependency, login, screenshot
baseline, or route. Run it on both the local Hono worker and built Kit Worker,
for each viewport above. Assertions are observable rendered-page behavior:

- **Voice page:** direct load `/hotzones/voice` returns 200 HTML; the visible
  heading is `voice hot zone`; the page explains that voice activity is a
  season-independent seeded estimate pending bot event-store calibration and
  shows a numeric total estimate. The one rendered grid is a labelled, focusable
  scroll region containing a table with weekday rows and hour columns; its
  caption is `Season-independent seeded estimate of voice activity` for the fixture URL.
- **Games page:** same contract for `/hotzones/games`, with `games` substituted
  for `voice` in the heading, estimate copy and caption.
- **Navigation:** from `/hotzones`, each Voice heatmap and Games heatmap link
  is visible and navigates to its matching page. Each signal page's visible
  cross-signal links include All hot zones, joins, voice and games. Preserve
  the existing Joins heatmap path as a control; it remains a live aggregate,
  not an estimate.
- **Desktop and mobile layout:** each page has exactly one grid region and no
  document-level horizontal overflow. At 390×844, its 42rem-wide table remains
  horizontally scrollable inside the labelled region (not the page); at
  1280×800 the region remains rendered without clipping the page.
- **Public/privacy contract:** each target is guest rendered, has no sign-out
  control or member identifiers, retains `noindex, follow`, a canonical link,
  and `public, max-age=300`; the Kit response carries the manifest-derived
  Kit marker (pinned as `kit`) and Hono carries no renderer marker. Voice and
  games remain estimates even when the joins fixture has live data.
- **Failure/empty boundaries:** malformed `?season=bogus` returns 400 before
  a grid, an unknown signal returns 404, and a database outage maps to 503;
  these are status/error contracts, not alternative rendered success screens.
  Existing raw API/unit checks cover malformed season and unknown signal;
  injected loader tests cover the outage mapping. No deterministic empty-data
  browser state is currently seeded, so zero-join rendered behavior is outside
  this browser contract (the shared helper's null-DB branch is unit-test scope).

The existing loopback workers and parity fixture already serve these anonymous
GET pages; the browser context blocks external requests. The current journey
needs no QA login (the single shared login belongs to the member-board tests).
Keep data assertions fixture-stable: pin semantic labels, grid dimensions and
nonnegative numeric totals rather than the seeded WhatPulse cells or a live
join-count value. Do not claim the new content contract is executed until the
assertions are merged and the parity browser job is green on that head.

In `browser-smoke`, after the seed and before any browser journey mutates
shared state, the dedicated `events-index.visual.spec.ts` captures the Kit
`/events` page. Kit dependencies/build and this visual run precede the Hono
visual suite and critical browser journeys. The full `parity.spec.ts` run stays
after the critical journeys; it spends one shared QA login and writes then
withdraws one RSVP on the seeded event. This ordering keeps both visual suites
on the clean seed state. The parity run is followed by
`node ci/check-kit-parity.mjs` (loud ledger).

One baseline integrator owns `e2e/visual/__screenshots__/` and
`e2e/visual/__screenshots-kit__/`: parallel migration cards never commit
baselines directly; they attach `*-actual.png` evidence and the integrator
reviews and commits. This keeps the 18 Hono baselines attributable.

## Journey gates (`ci/kit-parity-gates.mjs`)

Two modes, one assertion set per parity route:

- **Unit mode** (default, CI): hermetic — no database, no browser, no
  network, no secrets. It validates the shipped manifest, proves every
  assertion helper passes on a good fixture AND fails on planted mutants
  (no-main, no-skip-link, no-canonical, signed-in chrome, bare CSRF text,
  secret leak, wrong renderer marker: a gate that cannot fail on a planted
  break proves nothing), checks the reserved probes, distinguishes the
  member-chrome fragment from guest chrome, and ledgers the login journeys
  (member RSVP, moderator admin, profile edit) from the manifest: Hono-owned
  routes ledger as skipped WITH reasons — loud and countable until their
  routes migrate. The route-coverage catch-all considers any path listed in
  `PARITY_ROUTES` covered; that declaration is not proof of an executed
  browser journey. The heavyweight SSR
  byte-comparison stays in `ci/kit-preview-e2e.mjs`, which runs right before.
- **Preview mode** (`KIT_PREVIEW_URL` + `HONO_PREVIEW_URL`): fetches each
  `PARITY_ROUTES` entry from both deployed Workers and applies the same
  helpers to both (Kit: manifest-derived marker, Hono: always null),
  plus a framework-tolerant section comparison on the archive paths only
  (`ci/kit-section-contract.mjs`, same treatment as `kit-preview-e2e.mjs`:
  hydration markers, boolean attributes and `>` escaping are
  serializer-owned, never contract). Join, recovery, hot-zone and
  member-board entries carry `compareSection: null`: widget state, retry
  hrefs, live aggregates and per-viewer rows differ by design, so preview
  proves their structural contracts instead of equal bytes.

Per route the helpers assert: exact status, `content-type: text/html`, the
renderer marker matching the manifest (Hono side: always null), exactly one
`<main>`, skip link `href="#main"`, `aria-label="Primary"` nav, one
canonical link (archive/landing contracts; the recovery contract instead
asserts no canonical divergence — transient outcome pages ship none on
either renderer), the archive section testid (no-JS content: the Kit page sets
`csr=false`, so the contract is in the raw fetch body), archive noindex, the
shared island binder, no bare Kit CSRF text, guest-only account chrome, and
no secret-shaped content. The events contract adds the calendar island
identity, view toggles, search GET form, archive/subscribe links, markdown
alternate and the flash privacy invariant; the join contract adds the
one-click/invite actions, exactly one widget zone and the flash privacy invariant; the
recovery contract adds the shared shell markers (`recovery-heading`,
`recovery-retry`, `recovery-invite`), safe retry/invite hrefs and an
unconditional private, no-store pin. The static-leaf contracts (`about`,
`faq`) add the shared Leaf markers (h1 heading id, strap, `about-facts` /
`faq-list` testids with the first question group, the same-origin `/join`
action) and the public 3600s cache both handlers set. Reserved paths
(`/up`) and `POST /api/*` must never carry the Kit marker.

The member-board journeys are the authenticated arm. In preview mode they
run only when `KIT_PARITY_QA_TOKEN` carries the staging QA token: the gate
spends one QA login per base (`POST /auth/qa/qa-member`), replays the
session cookie on the board fetches, and asserts the member contract
(member chrome, `private, no-store`, `noindex, nofollow`, scope nav, filter
form, rank/member/going table or empty status, no per-attempt fields, no
profile links) on the overall, relative, season and activity views, plus
the admission answers (guest 302 to `/auth/discord`, grammar 400s, never a
board). Without the token — or when a base answers the login without a
session — those journeys ledger as skipped WITH the reason, never as a
quiet pass. The signed-in non-member 403 cannot be minted by the QA seam
(both QA identities are members), so it stays pinned hermetically
(`test/member-leaderboard-seasonal-relative-acceptance.test.ts`,
`test/kit-members.test.ts`). The same journey executes in CI against the
local Hono worker and the built Kit Worker in
`e2e/kit-parity/parity.spec.ts`, which spends one shared QA login for both
targets: the session row is shared, and the spec re-signs the bearer token
with the Kit fixture's own synthetic secret (`ci/kit-worker-dev.mjs`) for
the Kit target, since the isolated fixture deliberately does not share the
Hono worker's signing secret. The Kit target answers from the Kit load
itself: the fixture worker carries `KIT_PARITY_FIXTURE_MEMBER_BOARD=true`,
which `fixtureManifestFor` (`src/route-ownership.ts`) honours only for an
http loopback `APP_URL`, enabling just this entry in the fixture's manifest.
The shipped manifest now owns the board on Kit everywhere deployed, so the
fixture flag is redundant for this entry; returning the shipped entry to
`enabled: false` restores Hono ownership as the rollback.
The spec asserts the `kit` renderer marker on the Kit target for the served
board, so a fixture that stops owning the route fails the journey instead
of silently comparing Hono against Hono.

Exit codes mirror the staging gate: 0 pass, 1 journeys failed, 2
misconfigured (one-sided URLs, non-allowlisted hosts) or all-skipped/empty
ledger. An unexecuted suite can never report a quiet green: never add a
quiet skip precondition without a reason string.

## Preview URL pairing and allowlist

Set both `KIT_PREVIEW_URL` and `HONO_PREVIEW_URL`, or neither (unit mode).
Exactly one set exits 2 before any fetch. Each URL must be an `https:`
origin with no credentials, port, path, query or fragment, and its host must
be staging-allowlisted: `next.togetherweown.com` (staging) or
`*.workers.dev` (preview). Anything else — `http:`, apex/production hosts,
ports, credentials — exits 2. The two URLs must differ (a paired check
against itself proves nothing). One address variable owns the local fixture
too: `KIT_WORKER_ORIGIN`, else derived from `KIT_WORKER_PORT` (the port
`ci/kit-worker-dev.mjs` listens on).

## Visual gates

- The 18 Hono baselines in `e2e/visual/__screenshots__/` remain attributable:
  `playwright.visual.config.ts` keeps `updateSnapshots: "missing"` (CI never
  rewrites an existing baseline) and the wiring test pins the spec's baseline
  directory. See `docs/visual-regression.md` for the accept flow.
- Kit redesign baselines live in `e2e/visual/__screenshots-kit__/` only.
  `ci/kit-visual-accept.mjs` writes ONLY under that directory — the
  destination is fixed, not derived from artifact paths, so it can never
  touch the Hono baselines — and reads ONLY the Kit suite's own folders
  (`test-results-kit-visual/`, `test-results-kit-parity/`,
  `__screenshots-kit__/`), ignoring Hono actuals in the shared failure
  artifact. Use `node ci/kit-visual-accept.mjs <artifact-root> [--dry-run]
  [--format json]` for Kit-only acceptance. Actual replacement authority comes
  only from the existing exact `test-results-kit-visual` or
  `test-results-kit-parity` segments inside the artifact; baseline copies
  retain the existing `e2e/visual/__screenshots-kit__` path. Hono and
  unrelated/lookalike screenshots have no Kit replacement authority. The
  extraction folder's name is not a suite marker. Hono and Kit share one
  bounded filesystem/plan policy and the same version-1 reporting/error
  conventions, with stable `hono`/`kit` suite identity and stable
  effective-item IDs. The Kit visual config has its own Playwright output
  directory so the later parity run cannot clear visual actuals before artifact
  upload. When an actual and its stale committed baseline share a destination,
  the reviewed actual wins; distinct actuals still refuse. Inspect every
  expected, actual and diff image in the failed run's artifact before running
  `node ci/kit-visual-accept.mjs <unzipped-artifact-dir>`. Suite ownership uses
  exact directory segments relative to that root: extraction folder names and
  substring-lookalike folders do not admit or exclude images. Copies under
  `__screenshots-kit__/` can add absent baselines or match existing bytes
  (no rewrite), but cannot replace a differing checkout baseline without a
  reviewed actual. Such a stale-copy conflict names the target and refuses
  the whole plan. Use a current artifact or review the matching actual, never
  delete the newer checkout baseline to force acceptance. Dry-run is read-only
  and validates the same authority as apply. Reject source symlinks (including
  root/ancestor links, descendants and cycles) and linked destination
  files/ancestors before directory creation or writes. Confine the resolved
  plan to the intended artifact and Kit destination roots. Preflight the entire
  plan and cache source bytes, preserving actual-over-stale-copy precedence,
  collision/stale-copy refusal, additions and identical no-ops. Refusal must
  not change destination or outside bytes. Do not delete newer baselines to
  bypass a stale-copy conflict. All source bytes and existing targets are
  preflighted before writes, including sources later superseded by actuals;
  unreadable files refuse without partial application. These checks do not
  promise safety against a concurrent hostile filesystem writer or rollback
  after an apply-time disk failure. Commit only the intentional changes in the
  same PR and explain each one; never regenerate the tree.
  `ci/visual-accept.mjs` ignores actuals from foreign suites and both
  `test-results-kit-visual/` and `test-results-kit-parity/`, as well as
  baselines under `__screenshots-kit__/`. An intentional redesign is a reviewed
  artifact committed in the same PR — reviewers treat a baseline change like
  code — never a silent regeneration. Kit baselines pin the events index,
  member board, and archive. `e2e/kit-parity/events-index.visual.spec.ts`
  captures the populated `/events` state at desktop and mobile widths against
  the built Kit Worker as a guest. It runs before mutable journeys and asserts
  exactly the three seeded upcoming event rows plus the zero-RSVP count, so
  fixture leftovers cannot silently become the reference image.
  `e2e/kit-parity/parity.spec.ts` captures member-board default, relative,
  season and activity views at desktop and mobile widths, reusing the journey's
  single shared QA login. The archive visual case captures populated and
  out-of-range `/events/past` at desktop and mobile widths against the built
  Kit Worker as a guest on the deterministic seeded past row; its DOM/state
  parity runs in the same spec.
- `maxDiffPixels: 300` per screenshot (absolute, not a ratio), `<time>`
  masked, animations disabled, caret hidden. Raising the threshold or masking
  more needs its own PR with justification.

## Performance gates (`ci/check-kit-perf.mjs`, `ci/kit-perf-budget.json`)

Measured baseline 2026-10-12, ceilings at measured ×1.25 (raw to 512B, gzip
to 256B — the repository rule from `ci/bundle-budget.json`):

- Worker entry `_worker.js` (read from the built
  `web/.svelte-kit/cloudflare/` output): exact raw/gzip ceilings.
- Server JS total (`web/.svelte-kit/output/server`, sourcemaps excluded):
  totals plus a file-count cap — dominated today by the Hono catch-all
  bundle, which is exactly what should shrink as routes go native.
- Client `_app/immutable` JS/CSS: totals plus file-count caps (hashed
  filenames would churn per-file ceilings).
- A new chunk fails closed instead of escaping enforcement. Raising a
  ceiling needs an explicit decision explaining the growth; never relax a
  budget to make CI green.
- `startup.maxMs` (60s, the same cold-start bound as
  `ci/kit-worker-e2e.mjs`'s listen) is enforced as the Kit webServer
  readiness timeout in `playwright.kit-parity.config.ts`: a worker that never
  becomes ready fails the run before any journey executes. The parity spec
  additionally records warm first-200 latency as a report annotation under a
  10s liveness bound.

## Parameterized journeys (`playwright.kit-parity.config.ts`)

`e2e/kit-parity/parity.spec.ts` runs the journeys — past-archive
paging and refusals (including successful Older/Newer/Back turns over 24
seeded rows that `afterAll` sweeps), the events list (seeded row, calendar
island contract, POST/JSON staying Hono-owned, normalized calendar-section
equality), join-landing funnel, auth-recovery outcome, hot-zone grids and
signal navigation, public feeds/SEO, reserved/API surface, cross-origin
refusals, and the authenticated member-board journey (guest bounce, member
views, grammar refusals; one shared QA login) — against both the Hono worker
and the built Kit Worker in one run. The fixture-based unit contract and
hot-zone Vitest suites also run in CI; preview fetch is an operator-run check.
Bodies are origin-normalized before comparison (Hono pins the virtual
staging origin, Kit pins its own `APP_URL`; host strings differ by design).
The `webcal://` feed origins normalize to a distinct token from the
`https://` origins, so the subscribe-link scheme stays in the contract,
sections compare through the shared framework-tolerant treatment, renderer
expectations are per target (Kit: manifest-derived, Hono: always null), and
the archive page is driven at desktop and mobile widths with a horizontal
overflow assertion and a page-error watch. Seeded rows pin non-empty
collections so an empty fixture cannot pass silently.

Login journeys (member RSVP, moderator admin, profile edit) stay Hono-only
until their routes migrate; the gate ledger derives each entry from
`ROUTE_MANIFEST` and records Hono-owned routes as
`skipped: <route> not Kit-native` with reason strings — loud, countable,
never quiet green, and never a `test.skip` call (the floor forbids new
skips). The uncovered-route catch-all considers a route covered when its
base path appears in `PARITY_ROUTES` (`isCoveredByExecutedRun`); a `:param`
pattern is covered only by a concrete numeric-id instance of the pattern
itself (never by a static sibling). This declaration alone does not prove a
browser journey ran. `/about`, `/faq`
and the four hot-zone paths clear the catch-all because their base paths are
listed, not because that catch-all checks an executed journey; the step-3
fixtures and operator-run preview are separate contract evidence. Executed
parity journeys cover GET/HEAD `/events/past`, `/events`, `/join`,
`/auth/recover`, `/leaderboards/members` (the member board also runs
authenticated) and the moderator `/admin/join-attempts` pair (guest bounce,
member refusal, moderator list, and a canonical missing detail id in
preview; the served detail is pinned by the unit fixtures and the hermetic
Kit suites because no seeded attempt id is stable on staging). Hot-zone coverage is distinct: the suite performs raw
no-JavaScript API checks for all four paths and the two-width browser journey
renders `/hotzones`, `/hotzones/joins`, `/hotzones/voice` and
`/hotzones/games`. The latter two currently have only shared heading/grid/layout
assertions; see [Voice and games rendered acceptance contract](#voice-and-games-rendered-acceptance-contract)
for the content-specific browser assertions that remain the next implementation
slice. The unit contract exercises shared contract branches on canonical
fixtures (one synthetic `/hotzones` shell, one member-board fixture, the
`/about` and `/faq` leaves); per-path coverage of all four hot-zone signals
also comes from API checks (and preview mode when an operator runs it).
Hot-zone Vitest suites run in CI. Preview fetch is an operator-run check, not
CI evidence.

## Security

No tokens, session cookies, Discord secrets or PII in any artifact, log or
ledger. Public journeys (archive, join, recovery, feeds/SEO,
reserved/API) send no QA token and run with no logins; the hot-zone unit
contract also sends no token; the one shared
authenticated journey is the member board — one shared QA login in
`e2e:kit-parity` (bearer replayed to both targets, re-signed for the Kit
fixture secret) and one login per base in preview-gate mode only when
`KIT_PARITY_QA_TOKEN` is set. Every compared body is scrubbed and the gate
ledgers are scanned for token shapes before upload. Token-bearing requests
elsewhere go through `e2e/qa-request.mjs`; the failure-only scrub
(`ci/scrub-qa-token.py` pattern) is the backstop. A token found in an
artifact is exposed: report it to the COO the same hour.
