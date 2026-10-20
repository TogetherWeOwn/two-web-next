# Reading multi-day events on the month grid

The month grid plots a canonical event on every host-zone calendar day its
scheduled interval touches — including days before the event's start day is
visible and days after the displayed month turns. An overnight gathering
starting February 14 at 23:30 and ending February 15 at 01:00 appears on both
February 14 and February 15.

## Entries

- The start day keeps the existing entry: the host-zone start time plus the
  title, for example `23:30 Multi-day gathering`.
- Every later day shows a continuation entry: `Continues Multi-day gathering`.
  It never repeats the start time and never implies a second event.
- Continuation accessible names identify the displayed day
  (`Continues Multi-day gathering, Monday, 15 February 2027`), not the
  original start.

Every occurrence — start or continuation — jumps to the one existing event
list card. There is still exactly one card per event; the grid never duplicates
cards or element IDs.

## Day rules

- Days are the event's own host-zone days (UTC when the stored zone is
  invalid), not the viewer's zone. Endpoints honor daylight-saving transitions;
  a 23- or 25-hour day still plots exactly once.
- The scheduled end is exclusive: an event ending exactly at midnight does not
  occupy the next day.
- Discord-transient rows and unknown-end rows keep start-day-only plotting.
  Past-drawer rows keep start-day-only plotting.
- Upcoming cancelled and past-status rows are not admitted to the grid.
  Cancelled rows stay listed in the list view with their badge; drafts stay
  moderator-only. Ended rows in the open past drawer keep their start-day
  entries.

## Bounds

The grid read stays one bounded query: visible upcoming/ongoing rows whose
finite interval overlaps the displayed weeks, soonest first, capped at 200
rows. Ongoing events that started before the leading week are admitted; ended
or disjoint history is not. Recurrence expansion, search, list pagination and
the past archive are unchanged.
