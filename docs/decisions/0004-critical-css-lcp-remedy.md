# Decision 0004: critical CSS extraction is the chosen remedy for the mobile `/events` LCP release hold

- Status: accepted; implementation in progress (remedy selected and recorded by the Engineering Lead; as of 2026-11-09 the build was delegated to Software Engineer 1)
- Deciders: the Engineering Lead (remedy selection)
- Related: production is frozen at release `v2026.1107.2` while the hold lasts

## Context

Production has been frozen since `v2026.1107.2` (2026-11-07 19:06Z) because
exact-`main` staging fails the mobile `/events` largest-contentful-paint
budget (2005 ms against a 2000 ms budget). The release hold blocks every
production deploy until staging qualifies.

## Decision

Extract the critical CSS so the mobile `/events` page stops rendering long
blocking stylesheets before first paint, bringing staging back inside the
LCP budget. This is the chosen remedy; the alternative of relaxing the
budget was rejected.

## Why

The budget exists to keep the events discovery journey fast on mobile. A
remedy that shrinks render-blocking work fixes the cause; loosening the
budget would legalize the regression instead.

## Provenance

Remedy selected in the internal planning record of 2026-11-09; the canonical
roadmap's weekly-review header of 2026-11-09 records "the chosen LCP
remedy". Implementation proceeds in the release-hold track; this record
captures the choice, not the delivery.
