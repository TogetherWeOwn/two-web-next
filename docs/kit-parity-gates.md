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
| `GET /events` | `web/src/routes/events/+server.ts` (no Svelte page, so no client entries/node; Hono calendar screen bytes via `src/kit-events-html.tsx`, shared `/islands/events-calendar.js`; `POST /events` and `/events.json` stay Hono) | public | Hono (`enabled: false`) |
| `GET /about` | `web/src/routes/about/+page.svelte` (`csr=false`, shared `ContentLeaf.svelte`, `src/about-content.ts`) | public | Hono (`enabled: false`) |
| `GET /privacy` | `web/src/routes/privacy/+page.svelte` (`csr=false`, shared `POLICY_MARKDOWN`/`POLICY_VERSION` source, no island) | public | Hono (`enabled: false`) |
| `GET /rules` | `web/src/routes/rules/+page.svelte` (`csr=false`, shared `ContentLeaf.svelte`, `src/rules-content.ts`) | public | Hono (`enabled: false`) |
| `GET /join` | `web/src/routes/join/+page.svelte` (`csr=false`, shared `/islands/join-widget.js`; `/join/discord` + `/join/callback` stay Hono) | public | Hono (`enabled: false`) |
| `GET /admin` | `web/src/routes/admin/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome, `decideKitAdminGuard` layout guard, bounded `dashboardJoinFunnel`/`topZeroResultSearches` widgets with a classified-outage 503 mapping, no island; enablement blockers: the moderator tab-sync probe — signed auth-status cookie plus `/islands/auth-status.js` script, `src/auth-status.ts` — is not ported, and the layout guard stays read-only with no cookie writes until the enablement slice lands it) | dashboard/view (`admin.dashboard`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/featured` | `web/src/routes/admin/featured/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, bounded shared `listFeatured` read with the Hono filter/sort/page shape and a classified-outage 503 mapping, publish/window status via the shared `featuredStatus()`, no island; new/edit links stay on the Hono `/admin/featured/*` paths and the guarded `/admin/featured-contents` legacy redirects stay Hono until the form slice migrates) | featured_contents/list (`admin.featured.index`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /admin/activity-log` | `web/src/routes/admin/activity-log/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, shared `listActivityLog` projection with bounded subject/causer filters and newest-first paging plus a one-row lookahead, shared `formatActivityCauser` legacy labeling, ISO `<time datetime>` instants, no `properties` selection or render, no island; enablement blockers: same tab-sync probe as `GET /admin`) | activity_log/list (`admin.activity-log.index`, bridged moderator viewer; snowflake causers audited, legacy/null causers contribute no subject) | Hono (`enabled: false`) |
| `GET /admin/events` | `web/src/routes/admin/events/+page.svelte` (`csr=false`, shared `AdminShell.svelte` chrome per-child title, `decideKitAdminGuard` layout guard, shared bounded `listEvents` helper with a classified-outage 503 mapping, no island; only this GET migrates — `POST /admin/events`, `/new` and `/:key` stay Hono-owned, so the row forms keep submitting to the unchanged Hono handlers) | events/list (`admin.events.index`, bridged moderator viewer; subject-free `events` + `going-counts` reads, like the Hono handler) | Hono (`enabled: false`) |
| `GET /admin/join-attempts` | `web/src/routes/admin/join-attempts/+page.svelte` (`csr=false` via the group layout, shared `listJoinAttempts`/`parseJoinAttemptsQuery`/`joinAttemptsUrl` reads with the retention window and exact Discord/request-id search, classified-outage 503 mapping, private no-store, no island; detail links stay Hono-owned until the detail slice lands) | join_attempts/list (`admin.join-attempts.index`, bridged moderator viewer) | Hono (`enabled: false`) |
| `GET /auth/recover` | `web/src/routes/auth/recover/+page.svelte` (`csr=false`, shared `#lib/Recovery.svelte` over the `RecoveryModel` shape; journey writes + `/join/callback` outcomes stay Hono, rendered through the injected outcome renderer) | public | Hono (`enabled: false`) |
| `GET /profile` | `web/src/routes/profile/+page.svelte` (`csr=false`, one shared `web/src/lib/ProfileView.svelte`, member record + optional stats) | member (`profile`/`view`/`profile`) | Hono (`enabled: false`) |
| `GET /members/:user` | `web/src/routes/members/[user]/+page.svelte` (same shared view; retired `/members` directory has no route) | member (`profile`/`view`/`profiles.show`) | Hono (`enabled: false`) |
| everything else | none yet (Kit `[...path]` catch-all → `honoFetch`) | — | Hono |

Add one row per migrated route with its reads class (`public` routes render
outside the member-read boundary; anything else is member data). The gates
derive the expected `x-two-renderer` marker from the shipped manifest; a
hard-coded `"kit"` expectation is a finding.

## QA lane ordering

In the `check` job, Kit gates run after shell/runtime basics and before any
claim of journey parity:

1. Kit workspace install + `svelte-check` (shell basics)
2. `node ci/kit-preview-e2e.mjs` (existing archive section contract, Hono
   pg-proxy bundle vs Kit SSR bundle, plus the browser shell fixture)
3. `node ci/kit-parity-gates.mjs` (this card: unit by default, preview when
   both preview URLs are set)
4. `npm run build --prefix web`, then `node ci/check-kit-perf.mjs` (worker +
   generated-asset budgets against the measured baselines)
5. `node ci/kit-worker-e2e.mjs` (built Worker runtime fixture)

In `browser-smoke`, after the critical journeys:
`e2e:kit-parity` (parameterized no-login journeys vs Hono and the built Kit
Worker), then `node ci/check-kit-parity.mjs` (loud ledger).

One baseline integrator owns `e2e/visual/__screenshots__/` and
`e2e/visual/__screenshots-kit__/`: parallel migration cards never commit
baselines directly; they attach `*-actual.png` evidence and the integrator
reviews and commits. This keeps the 16 Hono baselines attributable.

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
  routes migrate — while an enabled route with no executed journey covering
  it records a failure, so the first Kit-native member route can never ship
  on a green ledger with no run. The heavyweight SSR
  byte-comparison stays in `ci/kit-preview-e2e.mjs`, which runs right before.
- **Preview mode** (`KIT_PREVIEW_URL` + `HONO_PREVIEW_URL`): fetches each
  parity route from both deployed Workers and applies the same helpers to
  both (Kit: manifest-derived marker, Hono: always null),
  plus a framework-tolerant section comparison
  (`ci/kit-section-contract.mjs`, same treatment as `kit-preview-e2e.mjs`:
  hydration markers, boolean attributes and `>` escaping are
  serializer-owned, never contract).

Per route the helpers assert: exact status, `content-type: text/html`, the
renderer marker matching the manifest (Hono side: always null), exactly one
`<main>`, skip link `href="#main"`, `aria-label="Primary"` nav, one
canonical link (archive/landing contracts; the recovery contract instead
asserts no canonical divergence — transient outcome pages ship none on
either renderer), the archive section testid (no-JS content: the Kit page sets
`csr=false`, so the contract is in the raw fetch body), archive noindex, the
shared island binder, no bare Kit CSRF text, guest-only account chrome, and
no secret-shaped content. The join contract adds the one-click/invite
actions, exactly one widget zone and the flash privacy invariant; the
recovery contract adds the shared shell markers (`recovery-heading`,
`recovery-retry`, `recovery-invite`), safe retry/invite hrefs and an
unconditional private, no-store pin. Reserved paths (`/up`) and `POST /api/*`
must never carry the Kit marker.

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

- The 16 Hono baselines in `e2e/visual/__screenshots__/` remain attributable:
  `playwright.visual.config.ts` keeps `updateSnapshots: "missing"` (CI never
  rewrites an existing baseline) and the wiring test pins the spec's baseline
  directory. See `docs/visual-regression.md` for the accept flow.
- Kit redesign baselines live in `e2e/visual/__screenshots-kit__/` only.
  `ci/kit-visual-accept.mjs` writes ONLY under that directory — the
  destination is fixed, not derived from artifact paths, so it can never
  touch the Hono baselines — and reads ONLY the Kit suite's own folders
  (`test-results-kit-parity/`, `__screenshots-kit__/`), ignoring Hono
  actuals in the shared failure artifact. `ci/visual-accept.mjs` likewise
  ignores Kit suite outputs. An intentional redesign is a reviewed artifact
  committed in the same PR — reviewers treat a baseline change like code —
  never a silent regeneration. (No Kit screenshots are captured yet: the
  accept flow is ready for the first enabled route; the DOM/state parity for
  it runs in the parity spec today.)
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

`e2e/kit-parity/parity.spec.ts` runs the no-login journeys — past archive
paging/refusals, public feeds/SEO, reserved/API surface, cross-origin
refusals — against both the Hono worker and the built Kit Worker in one run.
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
skips). An enabled route with no executed journey covering it records a
failure instead of a skip: in-scope routes fail their journey (scope net),
any other enabled route fails the uncovered-route catch-all (today only
GET/HEAD `/events/past` via `PARITY_ROUTES` is covered).

## Security

No tokens, session cookies, Discord secrets or PII in any artifact, log or
ledger. The parity specs send no QA token (no logins) and scrub every body;
the gate ledgers are scanned for token shapes before upload. Token-bearing
requests elsewhere go through `e2e/qa-request.mjs`; the failure-only scrub
(`ci/scrub-qa-token.py` pattern) is the backstop. A token found in an
artifact is exposed: report it to the COO the same hour.
