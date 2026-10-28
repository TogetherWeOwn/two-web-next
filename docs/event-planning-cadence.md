# Event planning cadence

This is an operator calendar routine for planning community events. A planned slot is not a public announcement or commitment, and completing this routine does not establish that an event was held.

## Owner and review rhythm

- Name one **event planner** for each monthly cycle in the calendar record. That person owns the review, the week-by-week status, and the next review date.
- On the first working day of the month, review the next four consecutive calendar weeks. Account for every week with either a planned event or an explicit `No event` entry and reason.
- At the start of each week, reconcile the previous week's actual outcome, update cancellations or reschedules, and roll the window forward by one week so four upcoming weeks remain reviewed.
- Use the [weekly reporting convention](community-participation-metrics.md#weekly-reporting-convention) adopted 2026-10-20 for these calendar weeks: ISO `YYYY-Www`, Monday 00:00 UTC inclusive to next Monday 00:00 UTC exclusive, with exact UTC `[start, end)` timestamps. This is a reporting convention only, not a change to goal targets or policy. Keep event scheduling/display in each event's stated timezone; do not infer a goal result from an assigned bucket.

## Minimum calendar fields

For each week, record:

- The ISO reporting-week label and exact UTC half-open interval.
- Event title and game/activity, when applicable.
- Start and end date/time, with the event's timezone stated explicitly.
- Location, venue, or joining channel.
- The named event owner/host.
- Current status: `planned`, `held`, `No event`, `cancelled`, or `rescheduled`.
- Review/update date; for `No event`, `cancelled`, or `rescheduled`, include a brief reason.

These are planning fields. The existing [moderator event workflow](moderator-admin-guide.md#create-edit-and-publish-an-event) documents the event form and its publication behavior; a calendar entry does not create or publish an event by itself.

## No event, cancellation, and reschedule

- Never leave a week blank. If no event is planned or held, set `No event` and record why. It is not a held event.
- A cancelled event is not held in its original week. Record the original date/week and the cancellation reason.
- For a reschedule, retain the original date/week and record the replacement date/week and reason. Assign both buckets by their event start instants in UTC. The original schedule is not evidence of a held event; if the replacement actually takes place, record it as held only in the reporting week containing its actual start instant. Do not count the same event in both weeks.
- If a separate event is held in a week whose other event was cancelled or moved, record that event separately; only the event that actually took place can be marked `held`.
- `planned` means scheduled, not held. Mark `held` only after the event actually takes place.

## Keep planning separate from the goal gate

The **TWO Community** goal sets a target of 20 weekly-active humans, 100 human messages per week, and one weekly event held for four consecutive weeks. A four-week calendar plan is not evidence that those targets were met; a planned, cancelled, or rescheduled event does not count as held in its original week. Use the separate goal-gate review for any success assessment; this cadence is not the event-gate evidence checklist.

The goal says monetization opens only when its targets hold for four consecutive weeks. This calendar routine does not assess that condition or authorize monetization, payout setup, sponsorship contracts, or spend. Those actions remain separate from event scheduling.

## Done condition for one monthly cycle

The cycle is complete when the named event planner has recorded the review date and next review date, reviewed the next four consecutive calendar weeks, and recorded each week as `planned`, `held`, `No event`, `cancelled`, or `rescheduled` with the fields and reasons required above. A cancellation records its original date/week and reason; a reschedule also records its replacement date/week. Cycle completion means the calendar review is complete; it does not mean four events were held or that a goal or monetization gate passed.

## Synthetic month (cancellation + reschedule)

| Week | Calendar record | Held-week result |
| --- | --- | --- |
| 1 | Event A actually takes place. | Week 1 is held. |
| 2 | Event B is cancelled and rescheduled to week 3. | Week 2 is not held for Event B. |
| 3 | Event B's replacement actually takes place. | Week 3 is held once; Event B is not counted in week 2 as well. |
| 4 | Event C actually takes place. | Week 4 is held. |

There are three held weeks in this four-week example, but the cancelled week breaks the run: the longest consecutive run is weeks 3–4 (two weeks). This month does **not** pass the four-consecutive-events target. The plan remains complete if all four weeks and the cancellation/reschedule are recorded as above.
