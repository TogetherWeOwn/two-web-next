# Weekly joins aggregate release boundary

Decision record and release contract for weekly joins aggregates. This document
records a review verdict only. It grants no data access, changes no public
policy, and does not enable implementation.

## Verdict: defer

Weekly public release of joins aggregates is **deferred**. No weekly joins
window, cell, or total is approved for public publication under this contract.

A future proposal must satisfy the release contract below and return for a new
review. A defer verdict is completed review work, not an implementation wait.

## Source and scope

- Source SHA: `19b2ce956dbae6fde817be18d0ac64035ae05ee0`.
- Scope: `src/hotzones/aggregates.ts` (`loadJoinsGrid`, opt-out filter,
  positive-cell return, exact total), `src/hotzones/routes.tsx` (public
  `max-age=300` publication of cells and totals), `src/hotzones/season.ts`
  (accepted tokens: `all`, year, month, quarter; no week token),
  `docs/community-metrics-access.md` (existing access is not blanket approval
  of a new metric, query, audience, or use).
- Reporting-period input: ISO weeks, Monday 00:00 UTC inclusive to the next
  Monday exclusive, label `YYYY-Www`, are the accepted week definition for
  review preparation. Acceptance of the definition does not approve weekly
  joins disclosure.

## Release contract (what any future proposal must meet)

| Element | Boundary |
| --- | --- |
| Purpose | Describe community timing patterns only. No per-person, per-cohort, or per-event identification. |
| Audience | Public anonymous readers, same as the current aggregate routes. A narrower audience (for example moderator-only) is a different proposal with its own review. |
| Minimum fields | Week label, week interval (exact UTC half-open bounds), release status per value (`released` or `withheld — reason`), and only released counts. Never per-user rows, timestamps, identifiers, profiles, or outcome breakdowns beyond the approved recorded outcomes. |
| Exact weekly interval | ISO `YYYY-Www`: Monday 00:00 UTC inclusive through the following Monday 00:00 UTC exclusive. One week per release; no rolling or overlapping custom windows. |
| Retention | Join-attempt rows are pruned after 90 days (`JOIN_ATTEMPT_RETENTION_DAYS`). A week ending before the cutoff reads empty by design; a week straddling the cutoff undercounts. The release must carry the same retention notice as the current grid and must not backfill from any other source. |
| Opt-out | Opt-out filtering applies before every release transform: attempts whose `discord_id` maps to a profile with `leaderboard_opt_out = true` never count. Null IDs and absent profile rows count today (current semantics); any change to that rule needs its own review because it changes who is counted. |
| Label | Recorded successful join-attempt outcomes (`added`, `already_member`) in the week. Never new joins, unique humans, complete history, or a monetization-readiness count. |

## Why deferred, not approved with a threshold

A numeric suppression threshold (for example 5) was considered and rejected
for this release because:

1. There is no calibrated community-scale basis for any specific number in
   this repository; picking one would invent protection without evidence it
   protects this population.
2. A threshold alone does not survive composition (see below). Approving a
   threshold without solving exact totals, overlapping windows, and repeated
   observation would grant a false sense of protection.
3. Weekly cohorts in a small community are routinely 0–4. A threshold that
   withholds most weeks still leaks through the published exact total and
   through month and quarter windows that remain exact.

Deferral preserves the current approved monthly-or-wider aggregate while the
protection design is worked out elsewhere. It alleges no proven breach in the
current release.

## Synthetic worked examples (fabricated; not measurements)

All values below are invented to exercise the contract. They must not be
copied into a real report.

| ISO week (synthetic) | Synthetic recorded outcomes in week | Weekly cell decision under this contract | Published value |
| --- | --- | --- | --- |
| `2026-W01` | 0, full-week coverage confirmed | Withheld — weekly release deferred | Withheld, not zero |
| `2026-W02` | 1 | Withheld — weekly release deferred | Withheld, not zero |
| `2026-W03` | 3 (below any discussed threshold) | Withheld — weekly release deferred | Withheld, not zero |
| `2026-W04` | 5 (at a hypothetical threshold) | Withheld — weekly release deferred | Withheld, not zero |

Rules demonstrated:

- Withheld values are labeled withheld with a reason, never `0`. Zero is
  published only for a released value whose source covers the full week and
  confirms no qualifying activity — and no weekly value is released under
  this deferral.
- The `2026-W01` row shows the zero-vs-withheld distinction: an empty
  synthetic week is still withheld while weekly publication stands deferred.
- The `2026-W04` row shows that reaching a hypothetical threshold does not
  release the cell while the verdict is defer.

## Composition review

The chosen protection (deferral) is evaluated against the ways a narrower
rule would be undone:

- **Exact totals with suppressed cells:** the current grid returns positive
  cells plus an exact total. Any future cell-suppression rule must also
  suppress, coarsen, or remove the exact weekly total; otherwise the total
  minus released cells reveals each withheld cell.
- **Overlapping windows:** month, quarter, year, and all-time windows remain
  exact under current semantics. A weekly value withheld in isolation is
  recoverable by subtracting adjacent weeks from the enclosing month or by
  differencing consecutive cumulative windows. A future proposal must define
  suppression consistently across every overlapping window or stop publishing
  the windows that defeat it.
- **Repeated observations:** weekly publication invites week-over-week
  differencing. Withdrawals, opt-out flips, and retention pruning change
  historical counts, so repeated reads of the same week can isolate a single
  person's outcome. A future proposal must define update, correction, and
  retention-pruning behavior for already-published weeks.
- **Cache and update behavior:** the current routes publish with public
  `max-age=300`. Caching does not prevent composition; it only delays
  observation. A future proposal must state cache, revalidation, and
  correction semantics for withheld and released values together.

## Implementation sizing (H15)

Weekly joins implementation does **not** fit one implementation PR under this
verdict. A future plan must newly scope at least: a week token in the season
grammar with 400-before-aggregation behavior, a suppression and totals policy
that survives the composition review above, opt-out-before-transform tests
including null IDs and absent profiles, withdrawal and retention-pruning
behavior for published weeks, and cache semantics. That plan returns through
the security gate before any code merges.

## Opt-out, nulls, withdrawal, retention

- Opt-out filtering stays before release transforms, mirroring the member
  ranking filter. Erasure needs no extra filter because erasure deletes the
  member's join-attempt rows.
- Null `discord_id` values and absent profile rows count under current
  semantics. A future proposal must state whether that continues and why.
- Withdrawal (opt-out set after publication) and retention pruning (rows
  deleted after 90 days) both change what a re-read of a past week returns.
  The contract requires the future proposal to define whether published weeks
  are frozen, corrected, or withdrawn, without identifying whose outcome
  changed.

## Cross-links

- [Community metrics access](community-metrics-access.md) — existing aggregate
  boundary; existing access is not approval of weekly disclosure.
- [Weekly community scorecard](community-weekly-scorecard.md) — reporting
  format; unavailable weekly joins remain unavailable, not zero.

## Evidence reviewed

- `src/hotzones/aggregates.ts` — opt-out filter before grouping; positive
  cells plus exact total without suppression.
- `src/hotzones/routes.tsx` — public cells and totals with `max-age=300`.
- `src/hotzones/season.ts` — no week token; invalid values answer 400.
- `docs/community-metrics-access.md` — no blanket approval of new
  metric, query, audience, or use.
- `src/jobs/constants.ts` — 90-day join-attempt retention.
