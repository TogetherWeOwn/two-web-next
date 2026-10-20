# Community event-gate evidence checklist

This checklist defines the weekly evidence row for the **TWO Community** goal's event gate: one weekly event held for four consecutive weeks, with attendance reported per event alongside occurrence. It is a documentation checklist only: it defines what counts as evidence, authorizes no new collection, data access, policy change, or monetization action.

## Authority and literal reading

The goal sets the target; this checklist records its literal reading, confirmed 2026-10-20:

- The target is one weekly event **held** for four consecutive weeks. Occurrence and attendance are separate metrics.
- Bot traffic never counts toward any goal measure.

This checklist does not reproduce the goal's internal link in public documentation. Where the goal is silent — week-boundary convention, attendance threshold, minimum presence duration — this checklist invents nothing; it records the gap instead.

## Weekly evidence row

Complete one row per week. Record exact inclusive/exclusive boundaries and timezone for each week, and use a consistent seven-day period when comparing weeks. The goal does not specify a timezone or week-boundary convention; do not imply one has been approved.

| Field | What to record |
| --- | --- |
| Week | Exact calendar date range, start/end timestamps, and timezone. |
| Event | Title and scheduled start/end time of the event counted for this week. |
| Occurrence evidence | Link to the organizer occurrence record proving the event was actually held at its scheduled time — for example a contemporaneous organizer, recorder, or host closeout note confirming the session began and ended, with observed start/end and timezone. Name the source and access date. |
| Occurrence verdict | `Held` or `Not held` under the occurrence rule below. |
| Attendance | Distinct humans with any evidenced presence during the event window, counted under the attendance rule below; or `Not reported` with the reason. |
| Attendance source | Link to the already-authorized presence source used, with its bot-exclusion rule; or `None — Not reported`. |
| Week verdict | `Pass` only when the occurrence verdict is `Held` with linked evidence. Otherwise `Fail`. |

## Occurrence rule

- An event counts for its week only if it was actually held at its scheduled time, evidenced by the organizer occurrence record confirming the session began and ended, with observed start/end and timezone. Use the [run-of-show closeout evidence](weekly-event-run-of-show.md#closeout-evidence), such as a contemporaneous organizer, recorder, or host closeout note.
- Platform event status alone is not occurrence proof. In particular, Discord external scheduled events can automatically become active/completed at their scheduled times even when no session took place. Keep platform state separate from occurrence evidence.
- Cancelled, skipped, moved-out-of-week, and unevidenced events do not count.
- A week with no evidenced held event fails the run.
- A rescheduled event is not held in its original week; if it actually takes place later, it counts only in the week it occurs, and never in both weeks. See [event planning cadence](event-planning-cadence.md#no-event-cancellation-and-reschedule).
- `planned` means scheduled, not held. Never mark `Held` before the event actually takes place.

## Attendance rule

- Count distinct humans with any evidenced presence during the event window, from an already-authorized source.
- RSVPs and going counts are intent, not attendance; never count them as presence.
- Bots never count.
- Do not invent a minimum duration or an attendance threshold: the goal sets neither.
- Report attendance per event alongside occurrence.
- Where no authorized presence source exists, write `Not reported`, never zero or an estimate. `0 (verified)` is valid only when a complete, current source covers the event window and explicitly reports zero qualifying humans.
- Adding a presence source is a separate privacy-reviewed decision: stop and request CISO review before accessing member-level data, identifying members in a report, or introducing a new source or recipient. See [source and access boundary](community-metrics-access.md#escalation).

## Consecutive-week rule

The gate needs four consecutive `Pass` weeks. Any `Fail` week — missed event, missing or unknown occurrence evidence, cancellation, skip — breaks the run; start the four-week run again after the break. Do not treat missing evidence as zero or as a pass. Attendance recorded as `Not reported` does not fail an otherwise held week, but the gap must be recorded, not filled.

## Examples (synthetic; not community measurements)

These examples demonstrate verdict handling only. Events, dates, values, and source names below are fabricated and must not be copied into a real report. Each example uses half-open weeks in UTC for illustration; this does not establish an approved reporting convention.

### Passing run

Four consecutive held weeks. Attendance is reported where a source exists and marked `Not reported` where none does; the `Not reported` weeks still pass on occurrence.

| Week | Event | Occurrence evidence (synthetic) | Occurrence | Attendance (synthetic) | Week verdict |
| --- | --- | --- | --- | --- | --- |
| 2026-02-02 → 2026-02-09 | Game night A | Synthetic organizer log entry: held 2026-02-06 19:00–21:00 UTC | Held | 9 distinct humans; synthetic presence record; bots excluded | Pass |
| 2026-02-09 → 2026-02-16 | Game night B | Synthetic organizer log entry: held 2026-02-13 19:00–21:00 UTC | Held | Not reported — no authorized presence source | Pass |
| 2026-02-16 → 2026-02-23 | Game night C | Synthetic organizer log entry: held 2026-02-20 19:00–21:00 UTC | Held | 11 distinct humans; synthetic presence record; bots excluded | Pass |
| 2026-02-23 → 2026-03-02 | Game night D | Synthetic organizer log entry: held 2026-02-27 19:00–21:00 UTC | Held | Not reported — no authorized presence source | Pass |

Result: four consecutive `Pass` weeks. The occurrence condition is demonstrated; this alone does not authorize activation or spend.

### Missing week

Week 2 has no evidenced held event: no event took place and no occurrence record exists. The missing week breaks the run even though weeks 1, 3, and 4 each held an event.

| Week | Event | Occurrence evidence (synthetic) | Occurrence | Attendance (synthetic) | Week verdict |
| --- | --- | --- | --- | --- | --- |
| 2026-03-02 → 2026-03-09 | Game night A | Synthetic organizer log entry: held 2026-03-06 19:00–21:00 UTC | Held | 8 distinct humans; synthetic presence record; bots excluded | Pass |
| 2026-03-09 → 2026-03-16 | None held | None — no event took place this week | Not held | Not reported — no event window to measure | Fail |
| 2026-03-16 → 2026-03-23 | Game night C | Synthetic organizer log entry: held 2026-03-20 19:00–21:00 UTC | Held | Not reported — no authorized presence source | Pass |
| 2026-03-23 → 2026-03-30 | Game night D | Synthetic organizer log entry: held 2026-03-27 19:00–21:00 UTC | Held | 10 distinct humans; synthetic presence record; bots excluded | Pass |

Result: not demonstrated. The longest consecutive run is weeks 3–4 (two weeks). Start a new four-week run after the break; do not count the missing week as zero attendance or as a pass.

### Cancelled event

Week 3's event was cancelled and never took place. The cancellation breaks the run even though the other three weeks held events. The 14 synthetic RSVPs for the cancelled event are intent, not attendance, and do not fill any row.

| Week | Event | Occurrence evidence (synthetic) | Occurrence | Attendance (synthetic) | Week verdict |
| --- | --- | --- | --- | --- | --- |
| 2026-04-06 → 2026-04-13 | Game night A | Synthetic organizer log entry: held 2026-04-10 19:00–21:00 UTC | Held | 7 distinct humans; synthetic presence record; bots excluded | Pass |
| 2026-04-13 → 2026-04-20 | Game night B | Synthetic organizer log entry: held 2026-04-17 19:00–21:00 UTC | Held | Not reported — no authorized presence source | Pass |
| 2026-04-20 → 2026-04-27 | Game night C (cancelled 2026-04-22) | None — synthetic organizer log records the cancellation; the event was not held | Not held | Not reported — cancelled events have no attendance | Fail |
| 2026-04-27 → 2026-05-04 | Game night D | Synthetic organizer log entry: held 2026-05-01 19:00–21:00 UTC | Held | 9 distinct humans; synthetic presence record; bots excluded | Pass |

Result: not demonstrated. The longest consecutive run is weeks 1–2 (two weeks). A cancellation is never a held event in its original week; if a replacement takes place later, it counts only in the week it occurs.

### Status-only negative control

Suppose four synthetic Discord external scheduled events automatically reach active/completed at their scheduled times, but no session takes place and no closeout confirms actual start/end. All four weeks are `Not held` / `Fail`, even if the listings or RSVP totals look complete. Platform status cannot demonstrate the occurrence condition.

## Authorization boundary

Completing this checklist, documenting readiness, meeting the four-week condition, or producing evidence does **not** authorize spend, enable monetization, establish payout identity, enter a sponsor contract, or otherwise activate monetization. Enabling server monetization and payout identity and entering sponsor contracts remain owner-only decisions and actions. See [monetization readiness boundary](community-monetization-readiness.md#owner-only-actions-and-authorization-boundary).

## Scope and safe use

Use this checklist to assess whether the goal's event gate is demonstrated. It does not report that the target has been met. Do not use production or staging database access, member-level exports, deployment, spend, or activation to fill a row. Attendance values come only from already-authorized sources; RSVP records and going counts are intent, never attendance. See [participation metrics](community-participation-metrics.md), [weekly scorecard](community-weekly-scorecard.md), and [source and access boundary](community-metrics-access.md).
