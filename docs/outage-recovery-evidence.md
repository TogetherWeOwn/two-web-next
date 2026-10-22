# Calendar outage recovery evidence

## Design contract

Audience: members, guests and moderators reaching the calendar, archive or a
503 page. The screen must admit temporary unavailability and offer safe manual
navigation, including without JavaScript.

- Primary action: the existing sanitized Discord invite, with its safe fallback.
- Secondary action: `/`, labeled **Back to the homepage**. Keep the existing
  `error-invite` and `error-retry` selectors.
- Content: “The site is temporarily unavailable. You can use the Discord invite
  or return to the homepage.” Do not infer maintenance, a recovery deadline or
  Discord uptime from a generic 503.
- References: the existing Hono `MaintenancePage` and `databaseUnavailable`
  response builder; Kit `ErrorShell.svelte` and `kitErrorCopy`; the
  [visual regression contract](visual-regression.md).
- Layout and typography: retain each shell's existing hero, heading hierarchy,
  tokens, fonts, responsive stacking and native links. The Hono and Kit shells
  retain their different existing palettes; this is not a redesign.
- States: Hono calendar/archive no-database full documents and Kit generic 503,
  desktop and mobile. Preserve a single named heading, noindex, private/no-store,
  request correlation, safe actions and existing support references.
- Non-goals: successful-page layout, other error statuses, header CTA work,
  feeds/API/MCP envelopes, automatic retry, new styles or frameworks, and outage
  runbook reconciliation.

Full-document calendar/archive failures use the existing negotiated shared
outage response without additional session or data reads. Matching island
requests keep their existing non-200 plain-text refusal. Their controllers
continue to retain last-good content, history and metadata instead of swapping
an error document into an island.

## Opened before/after captures

These are full-page captures with **1280×800** desktop and **390×844** mobile
viewports, using local fixtures and real application components. They are not
production incident reports or staging/deployment evidence. All twelve images
were opened for visual review.

| State | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Hono `/events` no database | [Before](screenshots/outage-recovery/before-calendar-503-1280.png) | [After](screenshots/outage-recovery/after-calendar-503-1280.png) | [Before](screenshots/outage-recovery/before-calendar-503-390.png) | [After](screenshots/outage-recovery/after-calendar-503-390.png) |
| Hono `/events/past` no database | [Before](screenshots/outage-recovery/before-archive-503-1280.png) | [After](screenshots/outage-recovery/after-archive-503-1280.png) | [Before](screenshots/outage-recovery/before-archive-503-390.png) | [After](screenshots/outage-recovery/after-archive-503-390.png) |
| Kit generic 503 | [Before](screenshots/outage-recovery/before-kit-generic-503-1280.png) | [After](screenshots/outage-recovery/after-kit-generic-503-1280.png) | [Before](screenshots/outage-recovery/before-kit-generic-503-390.png) | [After](screenshots/outage-recovery/after-kit-generic-503-390.png) |

The browser fixture bundles the real Hono app without a database and compiles
the real Svelte error shell, including Kit CSS. It serves the resulting HTTP
503 documents and repository static assets through a synthetic-origin browser
interception. Off-origin requests are aborted; no database, credentials or live
service is used. Capture and axe reports are retained with the change's evidence.

Before: the calendar/archive show bare text without headings or recovery links;
axe reports missing title and document language. Kit already has a branded shell
but promises minute-long maintenance and calls a homepage link “Try again”.

After: all six state/viewport combinations return 503, have one named heading,
no horizontal overflow and zero axe violations under WCAG A/AA 2.0, 2.1 and 2.2.
Keyboard navigation reaches the invite and homepage actions in that order.
The existing Hono outage header CTA and support reference remain visible.

## Gate boundaries

The existing Hono accessibility and Lighthouse fixtures cover successful Hono
pages, not these no-database branches or the Kit route. The explicit outage
captures and acceptance tests provide that additional evidence; a green Hono
gate alone is not Kit verification.

The committed visual baseline comparison belongs to pinned-runner CI, as
[documented](visual-regression.md). These evidence images are not comparison
baselines. No visual baseline, mask, audit, skip or threshold is changed here.

The independently authored `test/calendar-outage-recovery-acceptance.test.ts`
and `test/outage-copy-recovery-acceptance.test.ts` were observed at 22 intended
failures and 18 passing controls before implementation, then all 40 passed.
Existing neighboring suites and exact-head CI results are recorded in the PR.
