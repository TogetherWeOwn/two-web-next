# RSVP states and safe recovery

For members checking their own answer and moderators helping with an RSVP.
Start at the event page (`/e/…`), not a write endpoint. The
[Events FAQ](https://togetherweown.com/faq#faq-events) gives the short version;
[moderator incident guidance](moderator-admin-guide.md#moderator-boundaries-and-incidents)
sets the support boundary. This guide describes the implementation, not a live
incident diagnosis or a delivery guarantee.

## Read the answer before the sync notice

The answer and the Discord mirror are different things. **Going** reserves a
seat; it is not attendance. **Waitlisted** records a place in line, not a held
seat. A sync notice describes the mirror, not a different seat allocation.

Use the first matching branch below. If the page cannot show a current answer,
stop and use [private support](#private-support-and-escalation); do not guess
that a request succeeded or failed.

### Going — You're in

Your answer is Going and you have a seat. This does not prove you attended.
Check the event's current time and status before setting off. To change your
mind, use **Can't make it** when available to withdraw the answer and release
the seat. Do not submit another RSVP just to check whether you are Going.

### Waitlisted — You're on the waitlist

**You're on the waitlist — #2 in line** is an example position, not a seat or a
promise of entry. While the event is published, taking RSVPs and not ended,
a released seat promotes the earliest waiting member in first-in, first-out
(FIFO) order. A paused or closed event freezes promotion.

Reload the event to check your current position or whether your answer is now
Going. Promotion does not require another save. If **A seat opened up — I'm in**
is offered, it is a request, not a guarantee: the current FIFO allocation still
wins. **Someone just took that seat.** means that claim did not secure a seat;
check your place rather than repeatedly claiming. Use **Leave the waitlist**
to withdraw when available. Leaving and rejoining gives you a new place, not
your old priority. Do not rely on a promotion notification: the site cannot
guarantee Discord delivery.

### Saved. Syncing to Discord.

The answer is saved; the Discord mirror is pending. This does not mean the
reservation failed. Going still means a seat and Waitlisted still means a
place without a seat. Do not save again to force mirroring.

After a short wait, reload the event once to check the current answer and sync
notice. For a **persistent mirror delay** — it is still pending after that
check — stop and contact a moderator through private support. Do not repeatedly
save, withdraw/rejoin or retry to repair the mirror. There is no promised sync
completion time or notification.

### Synced to Discord.

The saved answer has a mirror stamp. This does not prove attendance or delivery
of a notification to you. Check the event page for the current answer; no extra
save is needed to confirm it. Report a persistent discrepancy through private
support rather than trying to repair Discord yourself.

### We couldn't confirm your RSVP. Check the event before trying again.

This is an **unknown result**, not the saved/pending notice and not proof of a
failed write. A lost connection or an unreadable success response can leave
the outcome uncertain. Further RSVP controls on that page are disabled.

Use **Refresh the event** and read your current answer before another write.
If Going or Waitlisted already matches your intention, stop: do not submit it
again. If a fresh signed-in page clearly shows a different answer or no answer,
review the current event status and available controls before making one
deliberate change. If the read fails, stays unclear, or another attempt becomes
unknown, stop and contact private support. Do not replay the earlier request or
treat a network error as proof that nothing was saved.

### Your session expired.

Use **Log in with Discord**, then return to the event and check your current
answer before choosing whether to submit. Follow the existing
[join and sign-in recovery guide](troubleshooting-join.md#expired-write-recovery)
if sign-in itself fails; it explains recovery pages and the invite fallback.
The refused request is not replayed, and sign-in is not proof of an RSVP.
If one fresh sign-in still leaves you unable to read or change your answer,
stop and contact private support. Do not replay a callback or the old write.

### Slow down — try again in a moment / Retry-After

The throttle notice says **Nothing changed** for that refused attempt; it does
not undo an earlier saved answer. Wait for the displayed seconds or
`Retry-After` interval. If no usable wait is given, wait at least a minute.
Then check the event and, only if a change is still needed and allowed, make
one deliberate submission. If throttling persists, stop and contact private
support. Do not repeatedly click, switch identities or bypass the limit.
Do not send response headers to support.

### RSVPs are paused for this event — check back soon.

Stop trying to make a new RSVP. Check back later by reloading the event; do not
keep submitting to see whether the pause has lifted. An existing Going or
Waitlisted answer may still have **Can't make it** or **Leave the waitlist**
for withdrawal. Use only the controls the current page offers. Ask a moderator
through private support if the pause or your answer needs clarification; do
not assume an unpause time or force a promotion.

### This one has been and gone — ended event

Stop trying to RSVP to this event. Check `/events` for another event or an
approved replacement. Do not submit from an old tab or use another endpoint
to get around the closed state. If the date looks wrong, report the sanitized
path, exact visible sentence and approximate time/timezone through private
support rather than guessing that the event is open.

### Cancelled

The event is not happening. Stop RSVP submissions and check `/events` for an
approved replacement; do not assume one exists or that your answer transfers.
Ask a moderator through private support if you need clarification. Do not try
to bypass cancellation with an old form or another endpoint.

A stale page can reload automatically when a write is refused because the
event is no longer taking RSVPs. Read the new page and follow its branch;
the reload is not confirmation that the write succeeded.

## Private support and escalation

Use the server's **ticket or support button** for the approved private support
process (one active ticket at a time), or DM a moderator as described in the
[FAQ support section](https://togetherweown.com/faq#faq-tickets). If Discord
entry or website sign-in is the problem, follow the
[existing join recovery steps](troubleshooting-join.md), not repeated RSVPs.

For an RSVP report, send only:

1. The **sanitized page path**: remove query strings, fragments and personal
   information. Use the event page path, never a full callback URL.
2. The **exact visible sentence**, transcribed rather than a screenshot that
   might expose other members.
3. The **approximate time and timezone** when it appeared.

Moderators forward that same minimal summary to the site maintainers/engineering
through the approved private support process if the bounded check above does
not resolve it. Do not promise a cause, fix time, seat, attendance, notification
or Discord delivery.

Never request or share roster/member exports, callback queries, cookies,
headers, credentials, passwords or tokens. Do not ask members to collect network
captures, run manual SQL, edit rows, perform queue replay or retry saves to repair
mirroring. A denied or unavailable protected read is a stop condition, not a
reason to find another access path. Existing
[host capacity and FIFO procedures](moderator-admin-guide.md#host-rsvp-and-waitlist-procedure)
remain separate; this guide adds no moderator repair powers.

## Source references and synthetic checks

- [Shared RSVP copy](../src/islands/contracts-rsvp-button.ts): the exact saved,
  unknown, expiry, waitlist, paused and throttle sentences.
- [RSVP page rendering](../src/events/rsvp-button.tsx): Going/Waitlisted and
  mirror stamps, paused withdrawals and closed pages.
- [Browser RSVP handling](../assets/islands/rsvp-button.js): unknown-outcome
  write lockout and refresh link, session expiry, throttle and stale-page reload.
- [RSVP routes](../src/events/routes-rsvp.tsx): saved answer response fields
  and withdrawal status handling.
- [RSVP service](../src/events/rsvp.ts) and [FIFO allocation](../src/events/waitlist.ts):
  one answer per member/event, current policy, released seats and promotion.
- [Synthetic outcome matrix](../test/rsvp-recovery-outcome-matrix-acceptance.test.ts):
  saved/pending, mirrored, waitlisted, promoted-on-reload, unknown transport or
  unreadable response, expired, throttled, paused, ended and cancelled fixtures.
  These execute the shipped browser code with synthetic responses; they are not
  live writes, database race verification or proof of notification delivery.
- [Shared FAQ acceptance](../test/faq-rsvp-recovery-acceptance.test.ts): Hono,
  compiled Kit and Markdown guidance, guide links and bounded support decisions.
