# Automated WCAG AA gate

Run `npm ci --include=dev`, `npx playwright install --with-deps chromium`, then
`npm run a11y`. On an agent workspace the database defaults to
`postgres://agent_test@agent-testdb:5432/two_web_next` (empty password).
GitHub Actions uses its own Postgres 17 service container. The runner rejects
all other databases before connecting; do not pass staging/production URLs.

The `a11y` job is a dependency of the existing required `check` job. The required
job runs even after a failed/skipped audit and explicitly rejects any result
other than `success`; GitHub's mergeable skipped-check behavior cannot bypass it.
Local Wrangler startup polls the existing DB-free `/robots.txt` route. The
fixture worker has no normal DB binding or migration ledger, so `/up` correctly
returns 503 there; staging deploy smoke still requires `/up` DB/schema readiness.
Any axe violation, unexpected HTTP status, redirect, non-HTML response, missing dynamic
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
  scanned at 360×780 and 1280×900. The matrix has 50 cases / 100 scans,
  including seeded and missing moderator join-attempt details, populated counts
  and profile stats/milestones, and explicit unavailable-counts/stats cases.
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
- Bot-owned `web_v1` views are **never** read or created. `ci/a11y-build.mjs`
  narrowly substitutes only the homepage count reader in the temporary bundle;
  route discovery and Wrangler consume that same bundle. The audit-only
  `ADMIN_DB.execute` adapter intercepts the two qualified profile stats queries,
  returning keyed synthetic rows through the **real** stats normalizer. Unknown
  `web_v1` queries fail closed; other owned-schema DB operations remain real.
  Production readers/routes/pages and deployment configuration are unchanged.
- Each browser context selects populated/unavailable read models through a
  test-only request header. Before axe, content assertions require 84 members,
  12 online, numeric rank totals and zero-as-`unclaimed`, or their unavailable
  fallback. Profile assertions require the actual stats section, tenure,
  membership, dates and milestone list—not the fallback rank/joined elements.
  Another-member coverage includes one-day/former-member/empty-milestone copy.
  Query-spy regressions run the production stats reader and prove zero shared
  DB reads. Missing or hidden populated sections fail even with HTTP 200.
- The runner stops Wrangler, closes its clients and drops only its own schema
  on completion; run-owned scratch is removed. SIGINT/SIGTERM seal resource
  acquisition and join in-flight setup before cleanup. Signal and `finally`
  callers share one shutdown promise; a signal-exited Wrangler is not awaited
  a second time. Every disposer is attempted even if another fails, and
  cancellation exits nonzero only after cleanup and report generation.
  Playwright's own SIGINT/SIGTERM handlers are disabled so they cannot exit the
  process ahead of the runner. The a11y job runs real Chromium signal regressions
  with a delayed disposer, verifying cleanup and evidence survive cancellation.
  No shared-table truncate or production/staging database access is involved.
- Audit DB URLs normalize an omitted port to 5432; all audit client options also
  pin port/password so runner `PGPORT`/`PGPASSWORD` cannot change the approved
  destination. Constructor-only regressions exercise conflicting inherited
  values without connecting.

## Gate contract

Axe tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa`.
**Every impact level fails. No allowlist and no disabled rules.** A deliberately
alt-less image must produce `image-alt`, and the same gate must reject it; a
missing detection or permissive gate fails the job. Policy tests in
`npm run check` also prove static/dynamic route drift and DB refusal behavior.

`artifacts/a11y/report.json` contains each case's status, viewport, verified
content assertions, violations, passes and incomplete checks. `summary.md` is
an evidence table including content-assertion counts; numbered PNGs
show the scanned state; `wrangler.log` records local responses with synthetic
session-secret and database configuration values redacted. Incomplete checks
are retained for inspection, not mislabeled as violations or manual passes.

This gate proves **automated axe coverage**, not full WCAG certification.
Screen-reader usability, all keyboard flows, visual overlaps and checks axe
marks incomplete still need human/manual assessment; that is outside this slice.

## Acceptance / reproduction

- **Given** seeded local fixtures, **when** `npm run a11y` runs, **then** all 100
  document scans pass with zero WCAG A/AA violations and a rejected sentinel.
- **Given** populated homepage fixtures, **when** either viewport renders,
  **then** the report records assertions for member/online counts and all five
  rank totals (including `unclaimed`).
- **Given** populated owner/moderator profile fixtures, **when** either viewport
  renders, **then** the screenshot includes synthetic tenure and milestones.
- **Given** unavailable read-model fixtures, **when** either viewport renders,
  **then** counts/stats are absent while their normal page fallback passes axe.
- **Given** another member's fixture, **when** either viewport renders, **then**
  stats show `1 day`, `Former member` and `No milestones yet.`.
- **Given** missing populated fixture sections, **when** content is checked,
  **then** the audit fails before axe can certify the wrong state.
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
