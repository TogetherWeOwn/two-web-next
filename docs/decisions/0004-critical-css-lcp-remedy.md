# Decision 0004: schedule-only removal of four blocking stylesheets is the chosen investigation for the mobile `/events` LCP release hold

- Status: accepted (decision closed 2026-11-07); investigation in progress; fix unvalidated until staging re-qualifies
- Deciders: the Engineering Lead (remedy selection)
- Related: production is frozen at release `v2026.1107.2` while the hold lasts

## Context

Production has been frozen since `v2026.1107.2` (2026-11-07 19:06Z) because
exact-`main` staging fails the mobile `/events` largest-contentful-paint
budget. The measured mobile LCP samples were 1956.864, 2012.736 and
2005.472 ms; the median of 2005 ms exceeds the 2000 ms ceiling. The
release hold blocks every production deploy until staging qualifies.

## Decision

Investigate a schedule-only removal of the four render-blocking
stylesheets through the existing shared-CSS and hash machinery. The
investigation preserves the rendered styles, the content-security-policy
hashes and the performance budgets. It is not blind full-sheet inlining.
The 2000 ms ceiling stays unchanged: no threshold change was authorized
and no option to relax the budget was considered.

The root cause is not precisely proven, so this record is not a validated
fix. Whether the removal brings staging back inside the LCP budget is
unproven until the Release Manager re-qualifies exact-`main` staging.

## Why

The budget exists to keep the events discovery journey fast on mobile.
Removing render-blocking work on schedule is the most direct way to
reduce blocking without loosening the ceiling. Because the cause is
unproven, the decision is to investigate the constrained remedy first,
not to assume it fixes the regression.

## Provenance

Remedy selected in the internal planning record closed 2026-11-07; the
canonical roadmap's weekly-review header of 2026-11-09 records "the chosen
LCP remedy". Evidence: mobile LCP samples 1956.864 / 2012.736 /
2005.472 ms (median 2005 ms > 2000 ms), staging run 42414068853 (public:
https://github.com/TogetherWeOwn/two-web-next/actions/runs/42414068853).
Implementation proceeds in the release-hold track under the shared-CSS
owner; this record captures the choice, not the delivery.
