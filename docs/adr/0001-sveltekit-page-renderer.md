# ADR 0001: SvelteKit with Svelte 5 is the single page renderer

- Status: accepted (owner direction, 2026-11-04)
- Recorded: 2026-11-06
- Deciders: the project owner (direction); the Engineering Lead (record and
  technical boundaries)
- Source verified at: `c4953c428efb2be6ee752e1a373a298a8fa0f1ef`

## Context

Production serves the Hono Worker (`src/worker.ts`, `wrangler.jsonc`
`env.production`): server-rendered JSX with plain JavaScript islands. The
SvelteKit tree in [`web/`](../../web/) is a strangler. Its hook asks the
method-aware manifest in [`src/route-ownership.ts`](../../src/route-ownership.ts)
which renderer owns each request, and it hands every other request to the
unchanged in-process Hono app. The Kit Worker runs on the preview Worker and,
through [`deploy.yml`](../../.github/workflows/deploy.yml) and
[`web/wrangler.staging.jsonc`](../../web/wrangler.staging.jsonc), on staging.
Staging admits only the archive and static families (`stagingManifestFor`).
No production request is Kit-rendered today.

The next UI generation needs one page renderer. A comparative trial
(SvelteKit against Astro with Svelte islands) was planned. The owner skipped
it and chose SvelteKit directly.

## Decision

1. SvelteKit with Svelte 5 is the only page renderer for this site. There will
   be no permanent Hono/Kit page twins and no Astro/Kit hybrid.
2. Hono keeps every non-page contract until the page-renderer milestone (called
   **M0** below): OAuth and session endpoints, form and JSON write handlers,
   JSON, feeds, the public API and OpenAPI, MCP, agent ingress, health,
   version, the CSP sink, SEO files, legacy redirects and static assets. The
   method-aware ownership, same-origin, session, CSRF, body-limit and throttle
   rules stay as they are. A retained write handler that answers a rejected
   native form with an HTML page (for example the 422 page of
   `POST /admin/events`) still renders that page through Hono until its write
   family migrates. The Kit page for the same form mirrors that response: the
   422 status, the entered values, the field errors and the no-JavaScript
   path. A page family reaches M0 when its GET pages are Kit-served; the
   rejected-POST page moves with its write family after M0.
3. **M0** means that every page family below is served by Kit in production
   and that the production cut of the Kit Worker has finished its 48-hour
   production acceptance.
4. The owner approved moving the retained Hono APIs into SvelteKit after M0.
   That is direction, not authorization. Each post-M0 family needs its own
   design, tests, review and release gates. This ADR authorizes no backend
   rewrite, contract deletion, new infrastructure, credential or spend.
5. Content routes stay server-rendered, with `csr = false` wherever a page
   needs no enhancement. Interactive widgets use explicit, budgeted
   enhancement. Native forms and every no-JavaScript journey stay supported.

## Basis

The basis is the owner's direction and the source and staging architecture
above. The decision does not rest on a completed comparison.

- **Not run:** the comparative trial (content, live-widget and strict-CSP
  scenarios), its disposable Hyperdrive timings, the productivity comparison
  and candidate-specific visual and performance evidence. None of these
  passed. None of them failed. Nothing here shows that Astro would have lost.
- The separate Hyperdrive semantics probe in
  [`spike/`](../../spike/hyperdrive-semantics/findings.md) passed 3/3 in its
  2026-10-01 live staging run. That checks locking and GIN semantics. It is not
  a renderer comparison, and it is not the trial's timing measurement.

## Consequences

- New page work goes into `web/` only. A Hono page handler is frozen once its
  family starts its Kit cutover. It gets fixes and nothing else, so no twin
  needs to be kept in sync.
- Hono stays a runtime dependency of the Kit Worker until the post-M0
  migration finishes. The catch-all `web/src/routes/[...path]/+server.ts`
  remains the fallback, and setting a manifest entry back to `enabled: false`
  remains the per-route rollback until that family's rollback end. That
  rollback works only while the Hono handler exists, so the handler is kept
  until then (see the ordering rules). After deletion, the rollback is a
  whole-release rollback to a build that still contains the handler.
- The Hono-only gates (`npm run a11y`, `npm run lighthouse`, the visual specs)
  do not qualify a Kit route that they did not exercise. Each slice brings its
  own Kit evidence, as described below.

## Residual risks as per-slice acceptance checks

No slice can rely on the skipped trial. Each one proves the checks below at
its exact candidate head before release. When an existing repository gate is
stricter, that gate wins. No score floor, byte or time budget, assertion,
reviewer, no-JS check or security check is weakened.

| Risk | Acceptance evidence on the slice |
| --- | --- |
| A manifest entry is mistaken for actual Kit rendering | The candidate SHA, route, method and state are pinned. The `x-two-renderer: kit` marker and the built Worker output prove ownership. Reserved Hono paths and method-aware dispatch are unchanged. |
| Client or Worker weight grows | The route stays within the existing per-route asset and Worker budgets in [`ci/budgets/`](../../ci/budgets/) and [performance budgets](../performance-budgets.md), lazy interaction downloads included. A content-only route ships 0 B of framework JS. A public widget stays within 15,360 B gzip unless an existing budget is stricter. |
| Performance regresses | Lab LCP is 2.0 s or less per slice, and CLS and TBT stay within the configured gates. The browser, device and throttling are pinned, and the raw reports are attached. No unrun Lighthouse result or field INP figure is claimed. |
| Hydration, actions or navigation weaken security | Strict-CSP tests run on the built output. CSRF, origin, session, cache, throttle and cross-origin POST protections are unchanged. There is no `unsafe-inline` or `unsafe-eval` relaxation. Dependency pins follow [security-pin contracts](../security-pin-contracts.md). |
| A form or a navigation needs JavaScript | Native forms, POST/303 ownership and the signed-out, session-expired, error and rate-limit states all run with JavaScript disabled. |
| Accessibility or visuals regress | The existing a11y and quality gates pass. Desktop (1280×800), mobile (390×844) and required-state screenshots are captured and opened. Design QA goes through the normal review stage. |
| Workload measurements are missing | The skipped trial and the missing Hyperdrive timings stay labelled not run. Operational evidence comes from authorized slice and release verification. Tests and ad-hoc probes never touch staging or production databases. The release workflows' existing authorized smokes (for example `/up`) are part of release verification and are not covered by that restriction. |
| Post-M0 app complexity | Each app feature proves its own strict CSP, client state, interaction latency and real route budget. |

## Retirement register

Source: the Hono router (`src/index.tsx` and the modules it registers) and
`ROUTE_MANIFEST`, read at the commit above. HEAD follows GET everywhere.
"Kit today" shows the shared manifest. Staging narrows that to the archive and
static families, and production is all Hono.

**Dates.** No calendar date has an owner acknowledgement yet, so every date
cell says `unacknowledged`. An amendment to this file adds each date together
with its acknowledgement link. Nobody may enter a date for another owner.
**Experiment cleanup.** This repository holds no Astro trial or synthetic
editor artifact at the source commit, so no row has repository cleanup.
Any artifact outside this repository belongs to the Security Engineer, and its
cleanup date is `unacknowledged`.

### Page families (move to Kit before M0)

| Route family | Methods | Kit today | Owner | Experiment cleanup | Cutover | Rollback end | Deletion date | Acknowledgement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shell: layout, branded 404/500/error pages | GET (all page paths) | Kit layout and `+error` exist; Hono error handlers serve production | Software Engineer 1 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Home `/` (bot-log feed and live layer included) | GET | entry off | Software Engineer 1 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Join and recovery pages `/join`, `/auth/recover` | GET | entries off | Software Engineer 1 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Profile `/profile`, `/members/:user` | GET | entries off | Software Engineer 1 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Events list and archive `/events`, `/events/past` | GET | **on** (staging: `/events/past` only) | Software Engineer 2 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Event detail `/e/:key` (Lifeline included) | GET | entry off (loopback parity fixture only) | Software Engineer 2 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Member board `/leaderboards/members` (members and ladder slices) | GET | **on** | Software Engineer 2 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Admin reads `/admin`, `/admin/events`, `/admin/events/new`, `/admin/events/:key`, `/admin/featured`, `/admin/featured/new`, `/admin/featured/:id`, `/admin/activity-log` | GET | entries off | Software Engineer 2 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Admin join attempts `/admin/join-attempts`, `/admin/join-attempts/:id` | GET | **on** | Software Engineer 2 | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Content leaves `/about`, `/faq` | GET | **on** (staging: static stage) | unassigned | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Content leaves `/privacy`, `/rules` | GET | entries off | unassigned | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Hot zones `/hotzones`, `/hotzones/:signal` | GET | **on** for `/hotzones`, `/hotzones/joins`, `/hotzones/voice`, `/hotzones/games` (exact entries); any other signal value stays on Hono and gets its 404 | unassigned | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |

Three page families have no owner in the scope inventory and are marked
`unassigned`. Each needs an owner before it can get dates.

### Non-page contracts (Hono through M0; post-M0 migration is direction only)

The Engineering Lead is accountable for every row below. Cutover means the
move into SvelteKit after M0. Each family keeps Hono until its own gated
migration ships.

| Route family | Methods | Owner | Experiment cleanup | Cutover | Rollback end | Deletion date | Acknowledgement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OAuth and session: `/auth/discord`, `/auth/discord/redirect`, `/auth/discord/callback`, `/join/discord`, `/join/callback`, `/auth/status`, `/logout`, `/logout/everywhere`, staging-only `/auth/qa/:identity` | GET (`/auth/*`, `/join/*`); POST (`/logout*`, `/auth/qa/:identity`) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Event writes: `/events`, `/events/:key`, `/events/:key/{publish,cancel,rsvp-pause,rsvp-reopen,duplicate}` | POST; PATCH (`/events/:key`) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| RSVP: `/events/:key/rsvp`, `/e/:key/rsvp` | PUT, DELETE, other methods answer 405 (`/events/:key/rsvp`); POST (`/e/:key/rsvp`) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Profile writes: `/members/:user`; retired directory `/members`, `/members/` (404) | PATCH, POST; GET (404) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Admin writes: `/admin/events`, `/admin/events/:key`, `/admin/events/:key/{publish,cancel,rsvp-pause,rsvp-reopen,duplicate}`, `/admin/featured`, `/admin/featured/:id`, `/admin/featured/:id/{unpublish,delete}` | POST | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Admin operator endpoints: `/admin/ops-overrides`, `/admin/queue/source-evidence/:id`, `/admin/queue/failed/:id/preview`, `/admin/queue/failed/:id/redispatch` | GET; POST, PUT, PATCH, DELETE, OPTIONS refused (first two); POST (redispatch) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Legacy redirects: `/login`, `/discord`, `/community`, `/admin/events/create`, `/admin/events/:key/edit`, `/admin/featured-contents`, `/admin/featured-contents/create`, `/admin/featured-contents/:id/edit` (`/admin/events/create` has an exact `enabled: false` manifest entry, so an enabled `/admin/events/:key` cannot capture it) | GET | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Event JSON and feeds: `/events.json`, `/events/:key`, `/events.rss`, `/events.ics`, `/events/:file.ics` | GET | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Public read API: `/api/public/events`, `/api/public/events/:key`, `/api/public/community`, `/api/public/join`, `/openapi.json` | GET | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Machine-readable text: `/llms.txt`, `/about.md`, `/faq.md`, `/rules.md`, `/privacy.md`, `/join.md`, `/events.md`, `/e/:file.md` | GET | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| MCP and agent ingress: `/mcp`, `/api/agent-events` | POST, OPTIONS (`/mcp`); POST (`/api/agent-events`) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Operations and SEO: `/up`, `/version`, `/csp-reports`, `/__probe/alert`, `/robots.txt`, `/sitemap_index.xml`, `/.well-known/security.txt` | GET; POST (`/csp-reports`, `/__probe/alert`) | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |
| Static assets: `public/` via the `ASSETS` binding (`/islands/*`, stylesheets, fonts, icons) and Kit `/_app/*` | GET | Engineering Lead | none in repo | unacknowledged | unacknowledged | unacknowledged | unacknowledged |

`/up`, `/version`, `/csp-reports`, `/api/*` and `/_app/*` are reserved in
`route-ownership.ts`. Kit can never claim them while they stay reserved.

### Ordering rules for the dates

- A page family's Hono handler is deleted only after its rollback end. The
  rollback end comes after the family's Kit cutover in production and its
  acceptance window.
- A non-page family's cutover starts only after M0, in the existing post-M0
  order. The step that removes Hono starts only after every family has run in
  production for seven days with no rollback. A release that still contains
  Hono stays available as a rollback target for 14 days after that removal.
- These are ordering rules, not dates. Any planning range is only a scenario
  until the owner acknowledges a date.
