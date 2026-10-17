# Event host privacy and safety checklist

For people coordinating a member event. Use this checklist to limit access and
route concerns; it does not grant moderator authority, change community policy,
or authorize production moderation actions.

## Before the event

- [ ] Use only the event details and coordination information needed to host
  this event. Hosts do not need moderator-panel access, the RSVP roster, or a
  member-list export to coordinate an event.
- [ ] Do not export, copy, or share member lists, RSVP rosters, join-attempt
  records, or member identifiers. Keep any necessary coordination in the
  approved event channel; share member-specific context only through the
  approved private support process.
- [ ] Share only the event information intended for attendees. Do not forward
  private member information to attendees or other hosts “just in case.”

## If a privacy or safety concern comes up

1. If someone may be in immediate danger, contact local emergency services
   first. Do not put yourself or another attendee at risk.
2. Route the concern promptly to an **authorized moderator** through the
   approved private support process. If the concern is about that moderator,
   use the established alternate moderator/support contact. The moderator owns
   the moderation decision and will decide whether further escalation is needed.
3. Share only what the moderator needs to locate and assess the concern: the
   event, approximate time and timezone, a short neutral description, and where
   the original information can be accessed through the approved channel. Do
   not investigate, confront people, circulate allegations, or promise an
   outcome or response time.
4. Keep any follow-up in the approved private channel. Do not put evidence or
   identifying details in shared event notes, public channels, or general host
   chat. If unsure whether something is safe to share, ask the moderator before
   sending it.

## Never copy into shared notes or general host chat

- Passwords, access tokens, OAuth codes, session cookies, callback URLs or
  query strings, and other credentials.
- Private member data, including Discord/member identifiers, names tied to
  sensitive circumstances, RSVP/attendance details, private messages or
  support-ticket contents, and information that identifies a person involved
  in a concern.
- Raw logs, diagnostic dumps, database output, or unredacted screenshots and
  message transcripts that may contain credentials or private member data.

For a minimal coordination note, record only the event, date/time, a broad
category (for example, “privacy concern routed”), and whether an authorized
moderator has been contacted. Do not include the person’s identity or reproduce
the evidence. The original material stays in its approved source; the authorized
moderator decides how it is reviewed and handled.

## Boundaries

Hosts do not access the moderator admin panel, perform moderation actions,
change roles, contact members from exported data, or seek another route when
access is denied. The moderator guide documents that the RSVP roster is
read-only and has no export control; member-data access and any safety response
must follow the authorized private process. See the [moderator admin guide](moderator-admin-guide.md#read-the-rsvp-roster)
and [threat model](threat-model.md) for the application’s access and data
boundaries.
