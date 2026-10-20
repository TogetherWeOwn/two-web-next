# Weekly TWO Community event run-of-show

Use this as a repeatable 55-minute session template, plus preparation and closeout, for the TWO Community goal's target of one weekly event held for four consecutive weeks. This is an operating checklist for the already-authorized event owner/operator; it does not grant permission, change policy, or claim a goal result. Use the goal's existing metric definitions and the [weekly reporting convention](community-participation-metrics.md#weekly-reporting-convention) adopted 2026-10-20. The latter settles reporting periods only; it changes no goal target or policy. This guide does not define an attendance-counting rule.

A scheduled or published event is not proof that a session happened. An RSVP is not attendance evidence. Record a session as **unverified** unless the closeout has evidence that it actually took place; do not claim a four-week run is complete while any required week is missing, cancelled, or unverified under the approved metric definition.

## Existing event lifecycle

Use the current site instance only if already authorized to do so; this guide does not create events or publish announcements.

| Need | Existing interface | Reference |
| --- | --- | --- |
| Create, review, and publish the event record | `/admin/events` | [Create, edit, and publish an event](moderator-admin-guide.md#create-edit-and-publish-an-event) |
| View an event and use member RSVP controls | `/events` and `/e/<key>` | [Event workflow and public RSVP availability](moderator-admin-guide.md#create-edit-and-publish-an-event) |
| Read RSVP responses for planning | Event edit screen | [Read the RSVP roster](moderator-admin-guide.md#read-the-rsvp-roster) |
| Cancel the event record | `/admin/events` list or event edit screen | [Cancel, past events, and unsupported controls](moderator-admin-guide.md#cancel-past-events-and-unsupported-controls) |

Admin-created events begin as drafts. Publishing and cancellation use the existing moderator workflow; a cancelled event is terminal. The event guide notes that publish attempts Discord synchronization but does not confirm an announcement was delivered. Do not publish a Discord message or other public announcement as part of following this guide; use the separate, authorized process. RSVP totals help with planning only and must not be reported as attendance. If the authorized lead uses a weekly series, see [Weekly series](moderator-admin-guide.md#weekly-series); each generated occurrence is its own draft and must be handled through the existing workflow.

## Roles

Assign named people before confirming the session. A person may combine lead and recorder duties, but the host and safety moderator must both be explicitly covered.

| Role | Responsibility |
| --- | --- |
| Event lead (authorized operator) | Owns the checklist, confirms the event record, makes the final go/cancel decision, and ensures closeout is recorded. Only this already-authorized role performs admin actions. |
| Host / facilitator | Runs the activity, welcomes participants, and keeps the agenda within its timeboxes. |
| Safety moderator | Stays available throughout, watches for safety or access issues, and can call a pause so the lead can decide whether to continue or cancel under existing policy. |
| Recorder | Notes actual start/end and the source of occurrence evidence; does not infer attendance from RSVPs. |

If the lead, host, or safety moderator is unavailable at the final preflight, the checklist fails. Do not treat an automated agent or bot as a substitute for a human-facing event role.

## Preparation and run-of-show

Put every scheduled time in the event's stated timezone and include the timezone in organizer notes. The durations below are a default template, not a minimum attendance or goal-scoring rule.

| When | Timebox | Action |
| --- | ---: | --- |
| T−48 hours | 15 min | Lead selects the activity and confirms the lead, host, safety moderator, recorder, and any backup. Agree on a 55-minute agenda and check that the activity needs no new spend, monetization, or production change. |
| T−24 hours | 15 min | Authorized lead checks the event title, description, start/end, timezone, access details, and RSVP page in the existing admin and event interfaces. Correct errors through the existing workflow. Any public or Discord announcement remains outside this guide. |
| T−15 minutes | 10 min | Lead and host run the pass/fail preflight below. Resolve a correctable issue and repeat the full check once before T−5 minutes. |
| T+0 to +5 min | 5 min | Host welcomes people and states the activity and how to participate. |
| T+5 to +10 min | 5 min | Host gives brief context and participation norms; moderator confirms the session is ready to continue. |
| T+10 to +40 min | 30 min | Run the main activity. Host keeps to the agreed format; moderator watches access and safety. |
| T+40 to +50 min | 10 min | Open discussion, questions, or participant sharing. |
| T+50 to +55 min | 5 min | Host summarizes, closes the activity, and states any already-approved follow-up. Do not make new commitments or announce monetization. |
| By T+65 min | 10 min | Recorder and lead complete the closeout evidence row below. |

## Pass/fail preflight and cancellation decision

The preflight is **PASS only when every check is true**. A blank, unknown, or failed check is FAIL; do not average the checks or infer readiness from RSVPs.

- [ ] The authorized lead verified the event record has the correct title, date, start/end, timezone, and access details; the event is in the intended lifecycle state for the planned session.
- [ ] Lead, host, safety moderator, and recorder have confirmed their roles and availability; the lead, host, and safety moderator are present for the final check.
- [ ] The host and moderator can access the planned venue and required materials; the session link or location works for the intended participants.
- [ ] The agenda fits the timebox, participation instructions are ready, and the moderator knows the existing pause/cancellation path.
- [ ] No unresolved safety or permission concern remains.
- [ ] Running the event requires no new spend, monetization, production change, or out-of-scope public publishing.

**GO:** The authorized lead may proceed only when all six checks pass. The lead records the decision and preflight time.

**NO-GO / cancel:** Any safety or permission concern, missing lead/host/moderator, or unresolved failed check at T−5 minutes means do not start. The authorized lead uses the existing cancellation workflow in the [Moderator admin guide](moderator-admin-guide.md), records the reason and the event's cancelled state, and informs the assigned roles through their existing channel. Because cancellation is terminal, a later session needs a new event record through the normal authorized process. A cancelled or merely scheduled event is not a held event.

If a new spend, monetization, production change, or public announcement is needed, stop this run-of-show and use the separate authorization/process; this guide is not approval for any of them.

## Closeout evidence

The recorder gives the lead a short, non-sensitive record by T+65 minutes:

- ISO reporting-week label `YYYY-Www` and exact UTC `[start, end)` interval from the [scorecard](community-weekly-scorecard.md#reporting-period), assigned by the event's actual start instant in UTC; event key or event-page reference. Note: “counted by UTC instant, displayed in host zone”.
- Scheduled start/end and timezone, plus actual start/end only when observed.
- Event-record state as shown by the existing interface (for example, published or cancelled), kept separate from whether the session's occurrence was evidenced.
- Occurrence evidence reference and timestamp, such as a contemporaneous recorder/host closeout note that confirms the session began and ended. Do not use the event listing, publish status, agenda, or RSVP list alone as proof.
- RSVP total may be included for planning context, clearly labeled **RSVPs, not attendance**. Only enter an attendance count when the approved metric definition specifies its source and counting rule; this guide does not supply one.

If the occurrence evidence is absent or ambiguous, record **unverified** and do not say the event was held or credit it toward the four-consecutive-week target. A human must review any metric edge case using the approved scorecard definition rather than this operating guide.

## Synthetic checklist walk-through

This is a fictional acceptance check, not an event report or evidence of an event taking place. Assume a session is scheduled for 18:00–18:55 UTC and that `SIMULATED-LOG-1` is a test-only closeout reference.

| Step | Synthetic observation | Expected result |
| --- | --- | --- |
| T−48 h preparation | Authorized lead, host, moderator, and recorder are assigned; agenda and no-new-spend check are complete. | Roles and scope checks pass. |
| T−24 h event details | Event title, time, timezone, access and RSVP interface match the fictional plan; event exists in the intended state. | Event-details check passes; RSVP is planning data only. |
| T−15 min: event record | Fictional title, date, start/end, timezone, and access details match the plan; the event is in the intended state. | Check 1 passes. |
| T−15 min: roles | Lead, host, moderator, and recorder are assigned; lead, host, and moderator confirm availability. | Check 2 passes. |
| T−15 min: access/materials | Host and moderator verify the fictional venue and required materials are available. | Check 3 passes. |
| T−15 min: agenda | Participation instructions are ready, the agenda fits 55 minutes, and moderator knows the cancellation path. | Check 4 passes. |
| T−15 min: safety/permission | No unresolved safety or permission concern exists in the fictional scenario. | Check 5 passes. |
| T−15 min: scope | No new spend, monetization, production change, or public publishing is needed. | Check 6 passes; lead records GO only after all six checks pass. |
| T+0 to +5 | Host welcomes the room and explains how to participate. | Opening stays within its five-minute slot. |
| T+5 to +10 | Host gives context; moderator confirms no unresolved safety/access issue. | Context and safety check complete before activity. |
| T+10 to +40 | Host runs the planned activity while moderator remains available. | Main activity stays within its 30-minute slot. |
| T+40 to +50 | Host opens the floor for discussion. | Discussion ends within ten minutes. |
| T+50 to +55 | Host summarizes and closes. | Session ends within its 55-minute plan. |
| By T+65 closeout | Recorder supplies `SIMULATED-LOG-1` with fictional observed start/end times; no attendance count is inferred from RSVPs. | In the simulated scenario only, occurrence is evidenced; this table is not a real held-event claim. |

**Cancellation negative control:** Repeat the same fictional timeline but make the safety moderator unavailable at T−5 minutes. Expected result: preflight FAIL, no GO, the authorized lead follows the existing cancellation UI and records the cancellation; the session is not reported as held. A missing, cancelled, or unverified reporting week prevents claiming four consecutive qualifying weeks.

## Explicitly out of scope

This guide does not perform or authorize owner-run event execution, Discord or other public publishing, monetization, spend, production or staging changes, attendee-data collection, or a new attendance/goal-credit policy. Keep TWO Next a fresh start; no legacy import.