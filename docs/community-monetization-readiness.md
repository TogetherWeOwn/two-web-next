# TWO Community monetization readiness boundary

This document records the readiness condition in the company goal **The TWO Community** and its **TWO Web Next roadmap refresh**. It is an evidence boundary, not a change to product policy or an authorization.

## Readiness condition

The goal names these targets:

- At least 20 weekly-active humans. A human is weekly active with at least one message or at least 10 voice-minutes; bot traffic does not count.
- At least 100 human messages per week.
- One weekly event held for four consecutive weeks.

The goal says the targets must hold for four consecutive weeks before monetization opens. Use the [weekly reporting convention](community-participation-metrics.md#weekly-reporting-convention) adopted 2026-10-20: ISO weeks, Monday 00:00 UTC inclusive to next Monday 00:00 UTC exclusive, labelled `YYYY-Www` with exact UTC timestamps. This reporting convention changes no goal target or policy. Evaluate each week separately using the goal's human-only definitions. For event or attendance evidence sources, use the separate event evidence checklist when available. A week with a missed target, a missing or unknown measurement, no event, or an event that was not held breaks the consecutive run; do not count it as a passing week. Start the four-week run again after a break. This is a conservative evidence rule for determining whether the stated condition is demonstrated, not a new exception or target.

Consecutive weeks have adjoining UTC boundaries; `2026-W51`, `2026-W52`, `2026-W53`, `2027-W01` is a four-week window across New Year. In a separate synthetic example, if `2026-W12` has missing evidence after passing W10 and W11, W13 is week 1 of a new run, requiring W13–W16 all to pass. Do not skip W12 and count four non-adjacent passing weeks. Assign an event by its UTC start instant, even when its host-zone display date is in the preceding week.

| Example evidence across the four-week window | Readiness result |
| --- | --- |
| All three targets are evidenced in each of four consecutive weeks, with one event held in each week | Condition demonstrated; this alone does not authorize activation or spend |
| Any week has fewer than 20 weekly-active humans or fewer than 100 human messages | Not demonstrated; the run is broken |
| Any week's human metric or event evidence is missing or unknown | Not demonstrated; do not treat missing evidence as zero or as a pass |
| A weekly event is cancelled, skipped, or not evidenced | Not demonstrated; the run is broken |

This document does not decide what evidence proves event attendance or replace the separately planned event evidence checklist. RSVP alone is not promoted to attendance evidence here. That checklist and the metric definitions should state evidence sources and limitations.

## Four-week assessment worksheet

Use this worksheet with the [weekly community scorecard](community-weekly-scorecard.md#reporting-period). Complete one scorecard for each week and record its link or reference in the matching row. Also cite the exact source/report reference and coverage for each human measure, plus the event evidence reference. Follow the [community metric source and access boundary](community-metrics-access.md); this worksheet establishes no evidence source or permission to collect or access data.

Record the exact start and end timestamps, boundary convention, and timezone in each row. Use the same seven-day reporting period convention across all four consecutive weeks. The goal does not establish a timezone or boundary convention; recording one does not imply that it has been approved. For any unavailable, incomplete, or unclear source, write `Not reported — [reason]`, not `0`; use zero only when a source covers the full period and verifies zero activity, as described in the scorecard's [missing-data guidance](community-weekly-scorecard.md#missing-data-and-zero-values).

| Week | Exact reporting period (start, end, boundary convention, timezone) | Weekly-active humans (at least 20) and evidence reference | Human messages (at least 100) and evidence reference | Event held and evidenced? and evidence reference | Weekly scorecard link/reference | Week result |
| --- | --- | --- | --- | --- | --- | --- |
| Week 1 | `[start; end; boundary convention; timezone]` | `[count or Not reported — reason; exact source/report reference]` | `[count or Not reported — reason; exact source/report reference]` | `[Held and evidenced / Not held / Not evidenced; exact evidence reference or reason]` | `[link or reference to this week's scorecard]` | `[Demonstrated / Not demonstrated]` |
| Week 2 | `[start; end; boundary convention; timezone]` | `[count or Not reported — reason; exact source/report reference]` | `[count or Not reported — reason; exact source/report reference]` | `[Held and evidenced / Not held / Not evidenced; exact evidence reference or reason]` | `[link or reference to this week's scorecard]` | `[Demonstrated / Not demonstrated]` |
| Week 3 | `[start; end; boundary convention; timezone]` | `[count or Not reported — reason; exact source/report reference]` | `[count or Not reported — reason; exact source/report reference]` | `[Held and evidenced / Not held / Not evidenced; exact evidence reference or reason]` | `[link or reference to this week's scorecard]` | `[Demonstrated / Not demonstrated]` |
| Week 4 | `[start; end; boundary convention; timezone]` | `[count or Not reported — reason; exact source/report reference]` | `[count or Not reported — reason; exact source/report reference]` | `[Held and evidenced / Not held / Not evidenced; exact evidence reference or reason]` | `[link or reference to this week's scorecard]` | `[Demonstrated / Not demonstrated]` |

A week is `Demonstrated` only when its period and sources are complete and clear, weekly-active humans meet the goal's human-only definition and threshold, human messages meet their threshold, and one event is evidenced as held in that week. Otherwise mark it `Not demonstrated`. A planned, cancelled, or rescheduled event does not count as held in its original week; a schedule or RSVP/going count alone does not show that it took place. Use an exact reference to existing event evidence without changing or inventing evidence criteria.

The four-week condition is `Demonstrated` only when all four rows are demonstrated for four consecutive weeks. Any missed threshold, missing or unknown measurement, missing source/coverage, week without an event, or event without evidence marks that week `Not demonstrated` and breaks the run. Do not carry earlier passing weeks across a break: close that attempt as `Not demonstrated` and start a fresh four-row worksheet with the next fully evidenced passing week as Week 1. Four new consecutive passing weeks are required.

Examples (illustrative only, not community measurements):

- **Missing metric evidence:** if the weekly-active-human source is unavailable or its coverage is unknown, enter `Not reported — [reason]`; do not infer zero. The week and four-week condition are `Not demonstrated`.
- **Below threshold:** 19 weekly-active humans or 99 human messages is below the applicable threshold, so that week is `Not demonstrated` even if its other measures pass.
- **Event not evidenced:** a scheduled or claimed event with no exact reference to existing evidence that it took place (or only RSVP/going data) is `Not evidenced`; the week is `Not demonstrated`.
- **Break and restart:** if Week 2 is missing or fails, Weeks 1–2 do not combine with later passing weeks. Mark the attempt `Not demonstrated` and begin a new four-week sequence at the next fully evidenced passing week.

## Owner-only actions and authorization boundary

The TWO Community goal reserves these steps to the owner:

- Enable server monetization and payout identity.
- Enter sponsor contracts.

The company goal's Owner-Line also reserves legal or contractual commitments, merchant steps, and money beyond the standing ceilings to the owner. Completing engineering, documenting readiness, meeting the four-week condition, or producing an evidence checklist does **not** authorize spend, enable monetization, establish payout identity, enter a sponsor contract, or otherwise activate monetization. Those owner-only decisions and actions remain separate.

## Scope and safe use

Use this page to assess whether the goal's stated evidence condition is demonstrated. It does not report that the targets have been met. Do not use production or staging database access, member-level exports, deployment, spend, or activation to establish readiness. Community work and evidence remain subject to the goal's approved owner-only steps and the repository's safe-test rules.
