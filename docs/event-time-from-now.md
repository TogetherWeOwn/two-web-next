# See how long until a game night

The host schedule remains authoritative. Select **Show time from now** in the
**Time from now** row of an event page to see how soon the night starts or ends,
without subtracting dates yourself.

The answer depends on your device clock at the moment you press the button:

- Before the start: `Starts in 2 days, 3 hours and 4 minutes. Ends in …`
- From the exact start until the exact end: `Underway now. Ends in …`
- At or after the exact end: `Ended 3 hours and 4 minutes ago.` (or `less than a minute`)

Future boundaries round up to the next whole minute, so a night never says it
starts in zero minutes. Elapsed time rounds down. Distances are elapsed time
between instants, so a daylight-saving change cannot shift them. Beyond a century
the answer says `more than 100 years`. If the schedule or your clock cannot be
read, the answer says the time is unavailable and the host schedule above still
applies.

Each answer is labelled `Checked at <time>`, with the checked instant in a
machine-readable `<time>` element. It is a snapshot, not a live countdown:
nothing updates until you activate the button again, which recomputes from your
clock. The check runs only in this browser. There is no timer, request,
notification, stored preference or server read, and focus stays on the button.
The answer is announced politely. It never changes the event, RSVP eligibility
(the server decides closure), calendar links, canonical URL, structured data or
cache contents.

Cancelled events keep their gone page, and drafts do not offer the action. Without
JavaScript, or when `Date` is unavailable, the row stays hidden and the complete
host schedule and calendar links remain.

## UI contract

Audience: guests and members deciding whether a night is soon enough to join.
Primary action: **Show time from now**, a native `type="button"` in its own row
below **Ends**. Both twins render it: [Hono detail](../src/events/pages-detail.tsx)
and [Kit detail](../web/src/lib/EventDetail.svelte), enhanced by
[the island](../assets/islands/event-time-from-now.js). It reuses the device
timezone button/status styling and the existing semantic tokens (Open Lobby /
Logo 1), so there is no new typography or colour. The row and button are
`hidden` until the island binds; the event stylesheet keeps hidden detail rows
laid out invisibly so the reveal flips visibility without moving content (no
layout shift at any script timing; without JavaScript the rows leave blank
space instead of dead controls). The status paragraph is an empty
`role="status" aria-live="polite"` region (`event-time-from-now-{button,status}`).
The start and end instants travel as `data-starts-at` / `data-ends-at` copies of
the visible `<time datetime>` values. Non-goals: live countdowns, reminders,
server clock or eligibility changes, relative SEO or cache text, polling.
