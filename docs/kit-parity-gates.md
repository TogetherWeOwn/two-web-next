# Kit journey, visual and performance parity gates

Card 9/43 of the SvelteKit migration. These gates prove every migrated Kit
route renders the Hono contract before it owns traffic. They flip with
`src/route-ownership.ts` `ROUTE_MANIFEST.enabled`, never with a hard-coded
renderer name: disabling an entry rolls the route back to Hono and the gates
expect Hono for the right reason.

## Route inventory

| Route | Kit handler | Reads | Owner today |
| --- | --- | --- | --- |
| `GET /events/past` | `web/src/routes/events/past/+page.svelte` (`csr=false`, shared `/islands/past-events.js`) | public | Hono (`enabled: false`) |
| everything else | none yet (Kit `[...path]` catch-all → `honoFetch`) | — | Hono |

Add one row per migrated route with its reads class (`public` routes render
outside the member-read boundary; anything else is member data). The parity
harness derives the expected `x-two-renderer` marker from the shipped
manifest; a hard-coded `"kit"` expectation is a finding.

## QA lane ordering

In the `check` job, Kit gates run after shell/runtime basics and before any
claim of journey parity:

1. Kit workspace install + `svelte-check` (shell basics)
2. `node ci/kit-preview-e2e.mjs` (existing archive section contract)
3. `node ci/kit-parity-gates.mjs` (this card: status/headers, semantic DOM,
   no-JS, account chrome, viewports)
4. `node ci/kit-worker-e2e.mjs` (built Worker runtime fixture)
5. `node ci/check-kit-perf.mjs` (worker bundle + Kit asset budgets, startup)
6. kit-parity Playwright project (parameterized no-login journeys)

One baseline integrator owns `e2e/visual/__screenshots__/` and
`e2e/visual/__screenshots-kit__/`: parallel migration cards never commit
baselines directly; they attach `*-actual.png` evidence and the integrator
reviews and commits. This keeps the 16 Hono baselines attributable.

## Journey gates (`ci/kit-parity-gates.mjs`)

Two modes, one assertion set per parity route:

- **Unit mode** (default, CI): the real Hono route served from a pg-proxy
  fixture bundle plus the real Kit page SSR-rendered with the web workspace's
  own `svelte/compiler` (same technique as `ci/kit-preview-e2e.mjs`). No
  database, no browser secrets, no network.
- **Preview mode** (`KIT_PREVIEW_URL` + `HONO_PREVIEW_URL`): the same
  assertions against two deployed Workers.

Per route the harness asserts:

- **Status/headers:** exact status (200 archive, 410 cancelled, 404 unknown
  with the branded body), `content-type: text/html`, `cache-control`,
  the hardened CSP envelope (`default-src 'self'`, no bare Kit CSRF text on
  cross-origin form POSTs), and the renderer marker matching the manifest.
- **Semantic DOM/a11y:** exactly one `<main>`, skip link `href="#main"`,
  `aria-label="Primary"` nav, `aria-current="page"` on the owning section,
  one canonical link, `data-theme` root, headings in order. Component
  snapshots stay as fast unit checks, never as runtime proof.
- **No-JS:** the section contract is present in the raw fetch body (the Kit
  page sets `csr=false`, so there is no hydration bundle to hide behind);
  `__data.json` follows page ownership.
- **Account chrome:** guest static chrome (`Welcome, guest`, no `Sign out`)
  vs explicit member chrome (`data-testid="explicit-account-chrome"`);
  seeded guest/member/moderator shapes where the route reads them.
- **Viewports:** desktop 1280×800 and mobile 390×844 through the browser
  fixture (no horizontal overflow, nav visible); the list route also runs a
  `reducedMotion: reduce` project.
- **Forced failure:** the `--selftest` mutates one section token and proves
  the gate FAILs (exit 1). A gate that cannot fail on a planted break proves
  nothing.
- **Secret scrubbing:** the emitted ledger is scanned for `X-TWO-QA-Auth`,
  `__Host-two_session=`, `Bearer `, `DISCORD_BOT_TOKEN`; any hit fails the
  run (exit 1) before artifacts upload. No tokens or PII ever land in
  artifacts (public repo: artifacts are world-readable).
- **Ledger:** every journey is ledgered passed/failed/skipped with a reason
  string; exit 2 on all-skipped or empty (Playwright exits 0 on all-skipped,
  so without this an unexecuted suite looks green). Never add a quiet
  `test.skip` precondition without a reason.

## Preview URL pairing and allowlist

Set both `KIT_PREVIEW_URL` and `HONO_PREVIEW_URL`, or neither (unit mode).
Exactly one set exits 2 before any fetch. Each URL must be an `https:`
origin with no credentials, path, query or fragment, and its host must be
staging-allowlisted: `next.togetherweown.com` (staging) or `*.workers.dev`
(preview). Anything else — `http:`, apex/production hosts, ports,
credentials — exits 2. The two URLs must differ (a paired check against
itself proves nothing).

## Visual gates

- The 16 Hono baselines in `e2e/visual/__screenshots__/` remain attributable:
  `playwright.visual.config.ts` keeps `updateSnapshots: "missing"` (CI never
  rewrites an existing baseline) and the wiring test pins the spec's baseline
  directory. See `docs/visual-regression.md` for the accept flow.
- Kit redesign baselines live in `e2e/visual/__screenshots-kit__/` only.
  `ci/kit-visual-accept.mjs` copies reviewed `*-actual.png` files there and
  **refuses** to write into the Hono directory (exit 1, nothing written).
  An intentional redesign is a reviewed artifact committed in the same PR —
  reviewers treat a baseline change like code — never a silent regeneration.
- `maxDiffPixels: 300` per screenshot (absolute, not a ratio), `<time>`
  masked, animations disabled, caret hidden. Raising the threshold or masking
  more needs its own PR with justification.

## Performance gates (`ci/check-kit-perf.mjs`, `ci/kit-perf-budget.json`)

- Worker bundle bytes (`_worker.js` from the adapter dry-run outdir):
  raw + gzip ceilings, measured ×1.25 rounded up like `ci/bundle-budget.json`.
- Kit client assets (`_app/immutable/**/*.js`, `**/*.css`): every emitted
  asset needs a budget entry; an unbudgeted asset fails closed.
- Startup probe: time-to-first-200 of the built Worker on loopback against
  the disposable database; budget in ms (p50 of the fixture, generous
  ceiling — this pins regressions, not hardware).
- Raising a ceiling needs an explicit decision explaining the growth; never
  relax a budget to make CI green.

## Parameterized journeys (`playwright.kit-parity.config.ts`)

`e2e/kit-parity/parity.spec.ts` runs the no-login journeys — past archive
paging/refusals, public feeds/SEO, live search, copy-link fallback — against
both the Hono worker (`https://localhost:8787`) and the built Kit Worker
(`http://127.0.0.1:<kit-port>`) in one run and compares status, headers and
section contracts per route with the manifest-expected renderer. Seeded
`01J00000000000000000000001` rows pin non-empty collections so an empty
fixture cannot pass silently.

Login journeys (member RSVP, waitlist, pause, admin, profile, featured) stay
Hono-only until their routes migrate; the ledger records them as
`skipped: <route> not Kit-native (<manifest enabled:false>)` with reason
strings — loud, countable, never quiet green.

## Security

No tokens, session cookies, Discord secrets or PII in any artifact, log or
ledger. Token-bearing requests go through `e2e/qa-request.mjs`; the
failure-only scrub (`ci/scrub-qa-token.py` pattern) is the backstop. A token
found in an artifact is exposed: report it to the COO the same hour.
