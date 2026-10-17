# Event cancellation and reschedule communications

Use these templates only after an authorized moderator has made and verified the corresponding event change in the site. Replace every bracketed field with verified information; remove optional wording that does not apply. Do not guess, promise, or invent event details.

## Cancellation

**Before sending:** In the moderator event editor, confirm the event shows `Status: cancelled`. Open its public event link and confirm it displays the cancelled-event page (HTTP 410). The old link is intentionally retained as a cancelled-event page, not a missing event. If either check fails, do not send this message; resolve the site state first.

> **[Event title] is cancelled.** It will not take place at [original date and time, including timezone]. Please do not attend. Check the site's Events page for an approved replacement; if none is listed, do not rely on a replacement schedule. You do not need to take any further action for this event.

Do not include replacement date, time, location, or other details unless they have been separately approved and verified on the site.

## Reschedule

A reschedule message must state the complete, verified new date, time, and timezone. Do not send it with missing or uncertain replacement details. For a cancelled event, cancellation is terminal: use an approved replacement event rather than trying to reopen or republish the cancelled event.

**Before sending:** Confirm the authorized update or approved replacement is saved in the moderator panel, its status is the intended one, and its public event page shows the new details. Compare the displayed date, time, and timezone with the approved schedule. If the page or timezone is unclear, pause and resolve that before sending.

> **[Event title] has moved.** The new date and time are **[new date] at [new time] [timezone]**. The previous schedule was [old date and time, including timezone]. Please check the event page at [event link] for the current details and update your calendar. If you can no longer attend, review your RSVP on that page and change it if needed.

Do not replace the bracketed new date, time, or timezone with estimates, relative wording (such as “next Friday”), or details copied from an unverified source. Keep the old schedule only when it is known and useful; it does not replace the explicit new schedule.

## Separate actions and delivery

- Approval to change an event does not by itself authorize publishing a message on an external channel. Obtain the applicable authorization, then publish the verified copy as a separate action.
- Discord synchronization is separate from external message publishing. Do not infer that a post was synchronized, or that synchronization was delivered, from a site save or a public post. Follow the applicable authorization and verify delivery through its own evidence.
- Saving a published or cancelled event may attempt asynchronous Discord write-back. That attempt is not proof of delivery and does not authorize a separate announcement. Report only what the available evidence confirms.

## Site-state reference

The moderator guide documents cancellation as terminal and says old public links remain a cancelled-event page. Its staging moderator journey checks draft access as 403, confirms `Status: cancelled` in the admin panel, then confirms the guest request to `/e/:key` returns 410. That is the cancellation verification pattern above; it does not test message publication or Discord delivery.
