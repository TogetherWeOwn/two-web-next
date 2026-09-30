# Automated WCAG AA gate

Run `npm ci --include=dev`, `npx playwright install --with-deps chromium`, then
`npm run a11y`. On an agent workspace the database defaults to
`postgres://agent_test@agent-testdb:5432/two_web_next` (empty password).
GitHub Actions uses its own Postgres 17 service container. The runner rejects
all other databases before connecting; do not pass staging/production URLs.

The `a11y` job is a dependency of the existing required `check` job. The required
job runs even after a failed/skipped audit and explicitly rejects any result
other than `success`; GitHub's mergeable skipped-check behavior cannot bypass it.
Wrangler readiness uses the retained `/up` liveness endpoint. Any axe
violation, unexpected HTTP status, redirect, non-HTML response, missing dynamic
fixture, or failed negative control prevents `check` from passing. Reports and
screenshots are uploaded as `a11y-evidence` even on failure (14-day retention).

## Coverage and fixtures

- `ci/a11y.mjs` bundles the **actual Hono app** and derives the document list from
  its registered GET routes, deduplicating middleware registrations. New static
  GETs are audited automatically; new parameterized routes require a case and
  fail coverage validation until supplied. A new non-document endpoint needs an
  explicit reason in `ci/a11y-cases.mjs`. Removed overrides also fail validation.
- Public pages, homepage notices, event list/calendar/search/no-results/past
  states, published/draft/cancelled event details, owner profile + validation
  alert, another member's profile, moderator admin pages and missing records are
  scanned at 360×780 and 1280×900. The initial matrix has 46 cases / 92 scans.
- Branded 404/429/500/503 handlers are exposed by **test-only** routes in
  `ci/a11y-worker.ts`. Production configuration still points at `src/worker.ts`.
- Canonical migrations and synthetic users/events/RSVPs/featured/join-attempt
  rows are seeded into a fresh random schema using the existing W15 fixture
  helper. Normal signed `__Host-two_session` cookies and server-side session
  rows authenticate QA member/moderator identities over local HTTPS. This is an
  offline QA login: the staging-only QA endpoint and production auth guards are
  unchanged. Each case owns a new cookie/context, avoiding rotation races.
- Local Wrangler uses a generated config with **no Hyperdrive, remote bindings,
  live credentials or `.dev.vars`**. Worker HTTP fetches are denied; browser
  off-origin requests (including Discord images/invites) are blocked. Only the
  authorized test DB is contacted. The worker receives existing `ADMIN_DB`,
  `SESSION_STORE`, and `DISCORD_EVENTS` test seams; member-access logging stays
  enabled. Raw sessions and Drizzle use separate clients to preserve timestamp
  serialization.
- The runner stops Wrangler, closes its clients and drops only its own schema
  on completion; run-owned scratch is removed. No shared-table truncate or
  production/staging database access is involved.

## Gate contract

Axe tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa`.
**Every impact level fails. No allowlist and no disabled rules.** A deliberately
alt-less image must produce `image-alt`, and the same gate must reject it; a
missing detection or permissive gate fails the job. Policy tests in
`npm run check` also prove static/dynamic route drift and DB refusal behavior.

`artifacts/a11y/report.json` contains each case's status, viewport, violations,
passes and incomplete checks. `summary.md` is the evidence table; numbered PNGs
show the scanned state; `wrangler.log` records local responses. Incomplete checks
are retained for inspection, not mislabeled as violations or manual passes.

This gate proves **automated axe coverage**, not full WCAG certification.
Screen-reader usability, all keyboard flows, visual overlaps and checks axe
marks incomplete still need human/manual assessment; that is outside this slice.

## Acceptance / reproduction

- **Given** seeded local fixtures, **when** `npm run a11y` runs, **then** all 92
  document scans pass with zero WCAG A/AA violations and a rejected sentinel.
- **Given** a new static HTML GET, **when** the audit runs, **then** that route is
  scanned without editing a page list.
- **Given** a new parameterized GET without a fixture, **when** coverage is
  resolved, **then** the run fails with `GET route coverage drift`.
- **Given** a staging/production or ambiguous DB URL, **when** fixture setup is
  attempted, **then** it is refused before any connection/migration.
- **Given** event view navigation, **when** either view renders, **then** its
  active link uses `aria-current="page"`, never button-only `aria-pressed`.
- **Given** an invalid profile timezone, **when** Save is clicked, **then** the
  focused alert contains a semantic list and passes axe. SSR errors preserve
  the same structure.

Empty/minimum states: no-results search/admin filters and unfilled admin create
forms. Boundary copy: synthetic Unicode featured content. Error states: branded
errors, cancelled/missing records and profile validation. Concurrency: cases are
serial with separate sessions; no concurrency change ships. Performance: 15-minute
CI timeout bounds the audit, not a production performance budget. Compatibility:
existing production routes/guards and plain-form fallback stay intact. Telemetry:
local response log + JSON/table/screenshots. Screen-reader assessment: N/A here.

Refs: TOG-10844
