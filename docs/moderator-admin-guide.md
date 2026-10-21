# Moderator admin guide for Next

For moderators using the rebuilt TWO website. This is the Next admin, not
Laravel/Filament. Use the deployment approved by the maintainers; all URLs below
are paths on that site. A staging walkthrough uses only authorized fixture
content, never real member incidents or unapproved live changes.

Companion: [troubleshooting join and Discord sign-in](troubleshooting-join.md).
This guide is checked against repository source; it is not a claim that staging
or production has been exercised. The [parity matrix](parity.md) tracks the
migration, but its older pending labels are not a substitute for current screens.

## Get into the panel

1. Open `/admin`. There is no separate admin password or login form: guests go
   to Discord sign-in at `/auth/discord`.
2. Approve using the Discord account that has the authorized moderator role.
   Successful Next sign-in and one-click join both recompute moderator status
   through a bot role lookup, matching configured role **IDs**, not role names.
3. After a role change, sign out using the homepage's **Sign out** button and
   sign in again, then open `/admin` explicitly.
4. A signed-in non-moderator gets 403. A failed role lookup or blank allowed-role
   configuration also fails closed; 403 does not prove the Discord role is
   missing. Ask the maintainers to check after one fresh sign-in.

Never borrow another person's session or use the QA authentication seam to get
admin access. If access or member-data audit logging fails, stop and escalate;
do not bypass it with direct database queries or another endpoint.

## A moderator lost their role

Moderator status is copied into the session at sign-in, so removing a Discord
role does not update existing sessions. First confirm the Discord moderator
role has been removed. If the moderator stops visiting pages, the idle session
expires within two hours (120 minutes after its last session-refreshing page view);
normal browsing can rotate and extend that window. Kit-served admin pages renew
the sliding session exactly like the Hono panel. For immediate invalidation,
an authorized operator should run the command below. It does not depend on the
moderator signing out. First dry-run, check the active-session count, then apply
revocation for the moderator's Discord snowflake:

```sh
node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> --target staging
node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> --target staging --apply
```

The command revokes only active sessions; the database URL is supplied through
`DATABASE_URL`, never as an argument. The examples target staging: confirm the
authorized staging database before running them. For an authorized production
incident, confirm the production database and replace `--target staging` with
`--target production` in both commands. Remote non-production URLs require
`--target staging` or `--target production`; production-looking URLs require
exactly `--target production` and refuse `--target staging`, even on a local
host. Local hosts otherwise need no target. The flag asserts the intended scope,
not environment discovery; never use the production assertion for staging.
See [the runbook procedure](runbook.md#a-moderator-lost-their-role).

## Quarterly moderator access review (role-audit half)

Once a quarter, pair this read-only comparison with the
[quarterly review](runbook.md#quarterly-moderator-access-review):
audit first to find drift, then revoke app-only sessions, then re-run to confirm
clean. An authorized operator runs the command and builds both ID lists with
the read-only queries in [the cutover checklist](cutover-check.md#moderator-role-audit-w16-pre-flip):
a read-only SELECT over live `web_sessions` for the app set, and a paginated
guild-members read filtered against `DISCORD_MODERATOR_ROLE_IDS` for the
Discord set. Moderators never supply the lists and never paste member
identifiers into public channels. The app set sees only sessions live in the
120-minute sliding TTL, so expect `discord-only` for moderators not signed in
during that window; close on `app-only` = 0 per the runbook. Treat `app-moderators.txt`, `discord-moderators.txt`,
and `members.jsonl` as member data and `discord-auth.conf` as a credential:
run the recipe from a scratch directory outside the checkout and keep all
four files out of the repo. Delete them after the run:
`rm app-moderators.txt discord-moderators.txt members.jsonl discord-auth.conf`.

The command compares the Discord-moderator set against the app-moderator set.
It reads only the ID lists it is given: it never touches the network, never
opens a database, never changes roles, and never reads or prints tokens or
secrets.

```sh
node --import ./bin/ts-hook.mjs bin/role-audit.mjs --discord-file=<path> --app-file=<path> [--json]
node --import ./bin/ts-hook.mjs bin/role-audit.mjs --discord-ids=<csv> --app-ids=<csv> [--json]
```

Each side needs exactly one source (`--*-file` or `--*-ids`, not both, not
neither). Files hold either a JSON array of strings or newline/comma separated
IDs. Exit codes:

| Exit | Meaning | Response |
|---|---|---|
| 0 | Sets match (empty on both sides is a clean pass) | Record the clean result |
| 1 | Drift: the sets differ | Record `discord-only` as information; clear app-only access with the revoke procedure above, then re-run until `app-only` is 0 |
| 2 | Usage or malformed input (missing side, both sources for one side, unknown flag, bad file, non-snowflake ID) | Fix the invocation or input, then re-run |

`discord-only` means the person has the Discord role but no live app session;
they gain the panel at next sign-in, so this is not a denial to troubleshoot.
`app-only` means a live app session without the Discord role: excess privilege
until the session expires or is revoked.

Keep evidence counts-only: the text report prints exact counts plus at most 20
IDs per side (`…and N more` beyond that), and `--json` reports exact
`discordCount`/`appCount` with truncated `shown` lists and `omitted` counts.
Record the review date, the counts, the outcome, and the follow-up actions in
the private review record. Keep ID lists, member identifiers, database URLs, tokens, and secrets out of the record and all public text.

## Auth-wall probe (staging only)

`bin/admin-authwall-probe.mjs` verifies all nine admin POST routes answer each
leg correctly: guests bounce to session recovery (303), signed-in
non-moderators get 403, and moderators read the dashboard (200). It logs in
both QA identities, sends empty bodies (expectations resolve before any
handler touches the database, so it writes nothing), and prints status checks
and fixed redirect classes (`empty`, `network-path`, `root-relative`, or
`other-location`; an absent header is `null`). Unexpected redirect targets are
never printed verbatim, nor are tokens, cookies, or bodies. Response disposal is
best-effort and cannot change or delay the status/header verdict. Run it with
`QA_AUTH_TOKEN` from an approved secret binding:

```sh
QA_AUTH_TOKEN=<from the approved binding, never pasted> node bin/admin-authwall-probe.mjs
```

It spends two QA-login hits and stays inside the admin-write throttle budget.
Live runs belong to the authorized cutover procedure, not CI. The queue
operator legs (preview, redispatch, source-evidence) have their own drill in
[the redrive runbook](queue-redrive-runbook.md#auth-wall-drill-staging-only).

## Busy writes and retrying

Event create, Save/PATCH, publish/cancel and RSVP pause/reopen, and featured
create, Save and Delete apply transaction-local `lock_timeout` and
`statement_timeout` database bounds of two seconds each. These are per-statement bounds, not a
whole-request deadline: a multi-occurrence series can execute many statements
inside one atomic transaction. The bounds include dependent recurrence children,
waitlist changes and audit writes, and do not change pooled connection defaults.

If a database statement times out, the mutation transaction rolls back before
the existing private, no-store 503 outage response is returned. No success
redirect or write-back is sent for that refused mutation. Keep the submitted
draft in the existing editor/recovery flow, wait briefly, then retry; a timeout
is not confirmation that your changes saved. Validation errors still use their
normal field errors. If the outage continues, use the response's support reference
when contacting the maintainers.

## Busy inventory reads and retrying

The event, featured-content and activity-log inventory lists each run inside
one transaction with transaction-local `lock_timeout` and `statement_timeout`
database bounds of two seconds each, covering the event list's second
Going-count statement as well. These are per-statement bounds, not a
whole-request deadline: each inventory statement gets its own budget, and the
bounds expire with the transaction without changing pooled connection defaults.

If an inventory statement times out, the read transaction rolls back before
the existing private, no-store 503 outage response is returned. A refused
inventory never renders as an empty list: wait briefly, then reload the page.
If the outage continues, use the response's support reference when contacting
the maintainers.

## Correct a rejected draft

Event and featured-content create/edit forms show the actual validation errors
above the editor after a rejected save (HTTP 422). Submitted values remain in
the form; a rejection is not a successful save. With JavaScript enabled, focus
starts at this error summary. Press Tab to reach an error link and Enter to move
to its control, then correct the value using the message beside that field.
The links also work by keyboard without JavaScript. General errors with no
editable control remain plain text in the summary; read and resolve those too.

For event schedules, check the local wall time and IANA timezone together: a
clock-change gap is not a valid time. Check capacity and create-only repeat
settings when listed. For featured images, correct the approved HTTPS image URL
and its image description. Explicitly choose **Create draft**, **Create** or
**Save** again after correcting the errors. The summary is from the last rejected
submission, not live validation, and does not disappear merely because you type.

Ordinary form loads do not move focus. The existing unsaved-draft departure
warning stays armed after rejection and while you correct the draft; navigating
away can still discard it. Kit presentations use the same form actions: rejected
POSTs are rendered by Hono, not a second Kit save or error endpoint.

## Screens and route reference

Use the navigation **Events**, **Featured**, **Join attempts**, **Activity log**, or **Site**.
There is no panel-specific sign-out button; return to the homepage to sign out.
In the table, `:key` means an event's key and `:id` a featured slot's ID. The
POST paths are form actions, **not URLs to open or call manually**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | **Moderation** dashboard. |
| GET | `/admin/events` | Events list, filters, sorting and pagination. |
| GET | `/admin/events/new` | **New event** form. |
| POST | `/admin/events` | **Create draft**. |
| GET | `/admin/events/:key` | Edit event and search/sort its read-only RSVP roster. |
| POST | `/admin/events/:key` | **Save** event fields. |
| POST | `/admin/events/:key/publish` | **Publish** a draft. |
| POST | `/admin/events/:key/cancel` | **Cancel** / **Cancel event**. |
| POST | `/admin/events/:key/rsvp-pause` | **Pause RSVPs** without cancelling. |
| POST | `/admin/events/:key/rsvp-reopen` | **Reopen RSVPs** on an eligible event. |
| GET | `/admin/featured` | Featured content list, title/publication filters, sorting and pagination. |
| GET | `/admin/featured/new` | **New featured slot** form. |
| POST | `/admin/featured` | **Create** a slot. |
| GET | `/admin/featured/:id` | Edit a slot. |
| POST | `/admin/featured/:id` | **Save** slot settings. |
| POST | `/admin/featured/:id/delete` | **Delete this slot**. |
| GET | `/admin/join-attempts` | Read-only join diagnostics, filters and pagination. |
| GET | `/admin/join-attempts/:id` | Read-only attempt outcome and trace detail. |
| GET | `/admin/activity-log` | Read-only activity log, subject/causer filters and pagination. |

These are the 19 canonical routes in `src/admin/routes.tsx` (10 GET, 9 POST).
Five additional GET routes retain legacy bookmarks as 301 redirects:

| Legacy path | Destination |
|---|---|
| `/admin/events/create` | `/admin/events/new` |
| `/admin/events/:key/edit` | `/admin/events/:key` |
| `/admin/featured-contents` | `/admin/featured` |
| `/admin/featured-contents/create` | `/admin/featured/new` |
| `/admin/featured-contents/:id/edit` | `/admin/featured/:id` with the native ID resolved from the imported legacy ID, not a native-ID fallback. |

All 24 routes (15 GET, 9 POST) use the moderator guard. Legacy redirects drop
query strings; an invalid or unmapped legacy featured ID returns 404, and an
unavailable lookup returns 503. Use the canonical links for new instructions.
Mutating buttons submit immediately: there is no action-confirmation dialog.
Double-check the event/slot and intended action before pressing one. The event
editor's separate browser warning for unsaved changes is not action approval.

### Kit admin shells (shipped; join-attempts pair Kit-served)

Each of the 10 admin GET routes above also ships a Kit shell. The
mixed-mode truth: the migration is GET-only; all 9 POST form actions stay
Hono with no manifest entries of their own. Most shell entries in
`src/route-ownership.ts` (`ROUTE_MANIFEST`) still read `enabled: false`, so
Hono serves those pages; the join-attempts list and detail entries read
`enabled: true`, so Kit serves those two pages wherever the Kit handler
runs. Kit shells reuse the same guard,
reads, filters, sort, pagination and copy, mirroring the event/featured
CRUD, RSVP roster, and join-attempts audit workflows below; the remaining
shells stay disabled pending their enablement reviews described in
[Kit parity gates](kit-parity-gates.md).

| Admin path | Kit shell |
|---|---|
| `/admin` | `web/src/routes/admin/+page.svelte` |
| `/admin/events` | `web/src/routes/admin/events/+page.svelte` |
| `/admin/events/new` | `web/src/routes/admin/events/new/+page.svelte` |
| `/admin/events/:key` | `web/src/routes/admin/events/[key]/+page.svelte` |
| `/admin/featured` | `web/src/routes/admin/featured/+page.svelte` |
| `/admin/featured/new` | `web/src/routes/admin/featured/new/+page.svelte` |
| `/admin/featured/:id` | `web/src/routes/admin/featured/[id]/+page.svelte` |
| `/admin/activity-log` | `web/src/routes/admin/activity-log/+page.svelte` |
| `/admin/join-attempts` | `web/src/routes/admin/join-attempts/+page.svelte` |
| `/admin/join-attempts/:id` | `web/src/routes/admin/join-attempts/[id]/+page.svelte` |

All shells render inside the shared `web/src/lib/AdminShell.svelte` chrome
with server-side rendering only (no client takeover): moderator-only pages
with a skip link, `noindex, nofollow`, no canonical link, and no guest
chrome. If a shell ever misbehaves after enablement, the rollback is a
manifest disable: returning its entry to `enabled: false` hands the route
back to the unchanged Hono handler. Each shell is pinned by its Kit suite —
`test/kit-admin-*` for dashboard, events and featured,
`test/kit-join-attempt*` and `test/kit-activity-log*` for those shells. The
Kit parity gates additionally cover the enabled join-attempts pair:
`PARITY_ROUTES` in `ci/kit-parity-gates.mjs` covers public routes
(including `/events/past`, `/join`, `/auth/recover`, `/about`, `/faq`, and
the hot-zone paths), the authenticated member leaderboard
(`/leaderboards/members`) and the moderator join-attempts list and detail;
the remaining moderator-admin journeys stay Hono-only, ledgered as skipped.

## Create, edit and publish an event

Before publishing, use the [event page content readiness checklist](event-content-readiness.md) to confirm members can decide whether and how to attend.

1. Open `/admin/events`, choose **New event**, or open an existing event by its
   title. **Search** matches title only; **Status** filters `draft`, `published`,
   `cancelled` or `past`. **RSVPs** filters Open/Paused; **Series** filters
   Parent/Child/Standalone; **Fill** filters Full/Has seats/Unlimited.
   Full/Has seats compare finite capacity with **Going** answers only, not Maybe
   or Waitlist; unlimited events are separate. Open/Paused describes the RSVP
   setting, not whether the event's status/time allows new answers.
   Press **Filter** to apply and return to page 1. The default order is newest
   start time first; **Title**, **Status** and **Starts** column links change the
   sort and return to page 1. Use **Previous**/**Next** for 25-row pages, retaining
   filters and sort.
   Starts display as UTC timestamps, not local wall time.
2. Fill in the form:

   | Field | Rule |
   |---|---|
   | Title | Required, at most 100 characters. |
   | Game | Optional, at most 100 characters. |
   | Description | Optional, at most 1000 characters. |
   | Accessibility notes | Optional, at most 1000 characters. Confirmed access details only; shown on the event page under Accessibility. |
   | Starts / Ends | Required local wall time, `YYYY-MM-DD HH:mm`; end must be after start. |
   | Timezone | Recognized timezone; defaults to `Europe/London`. Local form times are interpreted in this zone and stored as UTC. |
   | Location | Optional for drafts; required to publish, at most 255 characters. |
   | Organizer name | Optional, at most 500 characters. Shown on the event page as Hosted by; name only a host who has agreed to be listed. |
   | Public joining link | Optional, at most 2048 characters. Must be a public http(s) URL without sign-in credentials; shown on published pages as the joining link. |
   | Joining instructions | Optional, at most 5000 characters. Verified public steps shown under How to join. |
   | Capacity | Empty = unlimited; otherwise a whole number from 1 to 2147483647. On edit, it cannot be lower than the current **Going** count; equality is allowed. |
   | Repeats (new events only) | **Does not repeat** or **Weekly**. Weekly requires Occurrences (1–52, including the first) or Repeat until (`YYYY-MM-DD`); when both are set the earlier bound wins. Every series is capped at 52 total occurrences, even with only a Repeat until date. |

3. Press **Create draft**. Creation always starts as `draft`; you cannot publish
   by changing a form field. After creation you land on the edit screen.
4. Check details and timezone. Press **Save** for edits. Validation failures
   show **Check the highlighted fields and try again.** with the submitted values
   retained; correct the fields rather than assuming the save happened. Title,
   description, accessibility notes, location, organizer name, joining link
   and joining instructions reject control/invisible characters; ordinary
   emoji sequences are allowed.
5. On the list press **Publish**, or use the edit screen's **Publish** button.
   Only drafts offer it. This changes the status to `published` and attempts to
   enqueue Discord synchronization; it does **not** confirm a Discord announcement
   has already appeared. A queue failure does not undo the committed content change.
6. On the authorized deployment, check `/events` and `/e/<key>` using the same
   event key from the edit URL. Draft pages are hidden from non-moderators; a
   published, not-ended event can accept RSVPs when its RSVP setting is open.
   A successful moderator view alone does not prove a draft is public.

A fresh time in the daylight-saving **gap** is rejected; choose a real time and
ask engineering if the intended instant is unclear. A fresh repeated-hour time
uses the second occurrence (after the clocks go back, e.g. 01:30 GMT on
25 October 2026), as the old site did; there is no occurrence chooser. Unchanged edit times
preserve the stored instant. Do not move them just to make the form save.

The form's navigation **Cancel** link only leaves the editor. It is different
from the **Cancel event** action. Save event changes before roster search/sort
or other navigation: with JavaScript enabled, the edit screen requests a browser
leave-page warning for unsaved changes (including after a rejected Save).
**Save** itself is exempt; the warning is not a substitute for saving.

### Cancel, past events and unsupported controls

- **Cancel** on the list / **Cancel event** on edit is available for drafts and
  published events. Cancellation is terminal: no reopen or republish. Make an
  approved replacement event if needed. Check carefully; there is no confirmation
  dialog. Old public links remain a cancelled-event page, not a missing record.
  Use the [event cancellation and reschedule communication checklist](events-communications.md)
  after verifying the site state.
- `past` is a list filter/status, not something moderators set with a button.
  Public pages can classify an event as past by its end time even while the stored
  status still says `published`; the admin `past` filter need not include every
  ended event.
- Cancelled/past event fields can still be edited, but saving does not reopen the
  event. For the edited event itself, published/cancelled saves attempt asynchronous
  Discord write-back; draft/past saves do not. Saving a series parent can also
  shift children and enqueue their write-backs, regardless of the parent's status
  (see **Weekly series** below). Do not repeatedly save/publish to force a queue repair.
- Cancellation records the event's cancelled status; it does not record who attended
  or whether an RSVP holder showed up. Retained RSVP answers (including `going`) are
  responses, not attendance evidence. Do not count cancelled events or their RSVP
  rows as verified attendance. No-show treatment is unsupported by the stored data;
  leave it unknown rather than inferring absence from an RSVP or lack of an RSVP.
- There is **no event delete, restore, unpublish, bulk action or cover-image
  upload** in this panel. Repeat rules are available on creation, not as editable
  recurrence fields afterward. Escalate needs outside the visible controls
  instead of invoking other APIs.

### Pause or reopen RSVPs

Published events that have not ended show **Pause RSVPs** or **Reopen RSVPs**
on the list and edit screen. These actions keep the event published; pausing is
not cancellation and does not remove existing answers. Reopening can promote
waiting members into available seats in first-in-first-out order. Both changed
settings attempt asynchronous Discord write-back, not immediate delivery.
Drafts, cancelled events and ended events cannot use these controls. If a
transition is refused, check status and end time rather than retrying another API.

### Host RSVP and waitlist procedure

Use the member-facing event page to understand each answer:

- **Going:** the member sees **You're in** and **Can't make it**. Going holds a place under the event's capacity rules; it is not proof that the member attended.
- **Waitlisted:** the member sees their position in line when available (otherwise a general waitlist notice) and **Leave the waitlist**. A waitlisted answer is not a seat or attendance.
- **Withdrawn:** withdrawing removes the member's answer. Their page returns to the RSVP action allowed by current availability (join the waitlist when full); the host does not need to remove or replace the answer.
- **Automatically promoted:** on a published, open, not-ended event, a freed seat or an increase in capacity is assigned to the FIFO waitlist head automatically. After reloading, that member sees **You're in**; the Going count reflects the occupied seat. Hosts must not manually claim or assign a seat for anyone.

To handle a capacity change, edit the event in `/admin/events` and save the intended capacity. A blank capacity means unlimited. The editor refuses a finite capacity below the current Going count and leaves the event unchanged; Maybe, Not going, and Waitlisted answers do not count toward that floor. Increasing capacity can promote queued members in FIFO order. Paused, draft, cancelled, or ended events do not promote the line; reopening an eligible event can promote it. If a save is refused or the displayed state is unclear, stop and ask the maintainers rather than editing RSVP rows or using another route.

A complete host check is on-screen and event-level: confirm the correct event, its start/timezone and published status, whether RSVPs are open or paused, the intended capacity, and the public Going count. After changing capacity or reopening RSVPs, reload the event page and confirm the visible count and status. Use the admin roster only in place when authorized; it is read-only, its total includes every answer status, and it is not an attendance register. Do not export or copy the roster, member names, IDs, or waitlist details into notes or public channels. Record only the event-level outcome, check time, and visible aggregate counts. Count attendance only from verified actual participation, not from Going or Waitlisted answers.

**Capacity-one dry run:** one member answers Going and fills the single seat. A second member joins and sees **#1 in line**. When the first withdraws, the second is promoted automatically; after reload they see **You're in**, and the count is **1 of 1 going**. No host seat claim is needed.

Sources: [critical browser journeys](critical-journeys.md#critical-browser-journeys), [waitlist browser journey](../e2e/event-waitlist.spec.ts), [RSVP/waitlist tests](../test/rsvp-waitlist.test.ts), [RSVP write behavior](../src/events/rsvp.ts), and [capacity and promotion rules](../src/events/waitlist.ts).

### Weekly series

Choose **Weekly** only for an approved series and review its count/end date
before **Create draft**. Occurrences retain local wall time across clock changes;
subsequent occurrences in a spring-forward gap move forward by that gap, and
repeated-hour times use the first occurrence. Fresh ambiguous first-event times
still follow the event form's validation rules.

Each occurrence has its own event page and status. Cancelling an occurrence does
not cancel the whole series. Moving the parent's start/end times also shifts
not-yet-started children by the corresponding time differences; started instances
retain their times. Shifted published/cancelled children attempt asynchronous
Discord write-back even when the edited parent is draft or past. For example,
saving new times on a draft parent can move a published future child and enqueue
its Discord update. This does not change the children's statuses or confirm
Discord delivery. Check affected occurrences after saving. There is no bulk
series cancel or repeat-rule editor.

### Read the RSVP roster

The event edit screen shows **RSVPs (count)** with **Member**, **Status**, and
**Answered** (UTC), newest responses first by default. **Search members** with
**Search** matches username text case-insensitively; **Status** and **Answered**
column links toggle sorting while retaining the search. The count is the number
of matching answers (all statuses, not just going seats), so searching can
reduce it. The roster shows 100 answers per page with a "Showing a-b of N"
line; **Previous** and **Next** keep the search and sort and return to the
roster section. Sorting or searching again starts back on page 1. Save event
edits before these controls reload the page. This is a read-only roster: no adding/removing answers,
changing seats or exporting members. Read it only for authorized moderation.
Reads of other members are access-logged; empty rosters and self-only reads create
no access row. Audit-write failures always refuse protected contents, including
when the legacy `MEMBER_ACCESS_LOG_ENFORCE` setting is false. Stop and escalate any
reported audit failure; do not try disabling enforcement or another access path.

### RSVP is not attendance

An RSVP is a member's answer for an event, not a check-in. The supported answers
are `going`, `maybe`, `not_going`, and `waitlisted`; the roster's **Answered**
time is when that answer was last updated, not when the member attended. Event
status (`draft`, `published`, or `cancelled`) is separate from RSVP status.

The current records provide no check-in or attendance field. Therefore they do
not establish that a member attended, and absence of an RSVP does not establish
that they did not attend. Cancellation is terminal and existing answers are
retained, but cancellation does not establish attendance or a no-show. Keep these
outcomes distinct:

| Record evidence | Supported conclusion | Not established |
| --- | --- | --- |
| Event status `cancelled`, with any retained RSVP (including `going`) | The event is cancelled; the answer remains a recorded response | Attendance, no-show, or whether a planned replacement occurred |
| Event remains scheduled/published and member has `going` | The member recorded a `going` RSVP | Attendance or later cancellation/no-show |
| An explicit attendance/check-in record from a separately documented source | Attendance only to the extent that source's identity, event, timestamp, and verification are documented | Anything beyond that source's coverage; this repository defines no such attendance source |

Do not turn RSVP counts, the read-only roster, event end times, or Discord
write-back state into attendance totals. The repository documents RSVP persistence
and event lifecycle, not attendance verification or no-show policy. If attendance
is needed, treat it as unknown unless a separately approved, source-backed
attendance record is available; do not add or infer a product policy here.

## Featured content settings and homepage delivery

The homepage displays eligible published slots under **From the community team**,
in ascending position order, with ID breaking ties. **Show from** is inclusive
and **Show until** is exclusive. A checked **Published** box alone does not
guarantee display: its visibility window must qualify, and unavailable or slow
featured reads omit the section. Publication is a stored setting; delivery is
what guests actually see. After an authorized content change, check the homepage
before claiming it is live.

### Status

Every slot shows one status badge, evaluated at a single check instant:

- `unpublished`: **Published** is unchecked, whatever the window says.
- `scheduled`: published, and **Show from** is still in the future.
- `expired`: published, and **Show until** has been reached.
- `live`: published inside its window. Only live slots can appear on the homepage.

An empty bound stays open-ended: a published slot with no bounds is live. The
list and the edit page apply the same precedence; the badge is a visibility
verdict, not a second publish switch.

### Slot list

Open `/admin/featured` and choose **New featured slot**, or open an existing
title to edit. **Search titles** matches title text case-insensitively;
**Published** filters All/Published/Unpublished. Press **Filter** to apply and
return to page 1.

The list shows **Title**, **Status**, **Position**, **Window (UTC)** and
**Last changed** (UTC), ordered by ascending position by default, with ID
breaking ties. The window shows each bound as a full UTC timestamp, or a dash
for an open bound. **Position** and **Last changed** column links toggle sorting
while retaining filters and return to page 1. Use **Previous**/**Next** for
25-row pages, which keep filters and sort; the bar shows the current page
number. There is no drag-and-drop ordering.

### Field rules

| Field | Rule |
|---|---|
| Headline | Required, at most 255 Unicode code points. |
| Body | Optional supporting text, at most 1000 Unicode code points after trimming. |
| Link | Optional full HTTP(S) URL, at most 255 characters. |
| Image URL | Optional full HTTPS URL on `cdn.discordapp.com` or an additional public host approved by maintainers in `FEATURED_IMAGE_HOSTS`, at most 255 characters; no credentials or custom port. This site's host is not automatically allowed for new input. No upload or check that the image exists. |
| Image description | Required when an image URL is supplied, at most 255 Unicode code points. Describe the image accessibly. |
| Published | Unchecked by default; a stored publication setting, not proof of homepage display. |
| Position | Whole number from 0 to 2147483647; defaults to 0, lower numbers sort first. |
| Show from / Show until | Optional UTC `YYYY-MM-DD HH:mm[:ss[.ffffff]]` (a space or `T` may separate date and time); seconds 00-59; up to 6 fractional digits; when both exist, until must be strictly after from. Unlike event times, these are UTC. |

The editor reloads stored window bounds at full microsecond precision, so saving
unrelated changes keeps the existing precision: leave the two fields as loaded.
Retyping a bound to minute precision narrows it on purpose.

### Preview and safe editing

The edit page shows a **Homepage preview** panel: the last saved content,
checked at the printed UTC time. Pressing **Create** or **Save** refreshes it.
Typed-but-unsaved edits never appear there, and neither do rejected
submissions: after a failed save the form keeps the submitted values for
correction while the preview still shows the last saved row. The new-slot page
has no preview. When the slot is not currently visible, the panel says so
instead of rendering the slot. An inline preview is not proof of guest homepage
delivery: verify the homepage as a guest after an authorized change.

Follow one coherent workflow per approved change:

1. Open the slot, edit, and press **Create** or **Save**.
2. On rejection, read the notice, fix the highlighted fields, and save again;
   the submitted values stay in the form.
3. On success the page reloads: inspect the refreshed preview and status badge.
4. Verify the homepage as a guest before claiming the change is live.
5. To withdraw a slot without removing its record, uncheck **Published** and save.

Leaving the page with unsaved changes triggers a browser warning; the
rejected-save redisplay is guarded the same way. There is no autosave: an
unsaved draft exists only in the open document, so leaving or reloading without
saving loses it. A repeated **Save** within 10 seconds is ignored; if a save
seems interrupted, reopen the slot and check its stored settings before saving
again. An expired session shows a notice and keeps the edits; use its sign-in
link to recover.

If another moderator saves the slot after you opened it, your **Save** is
refused with a conflict notice instead of overwriting their change: nothing is
saved, and your complete draft stays in the form for reference. Follow the
**Review the current version** link to load the current saved row, re-apply
the change you still intend, and save again. Pressing **Save** again on the
conflict page without reviewing still refuses — it never silently rebases or
overwrites — and reloading the conflict page resubmits the refused save
instead of clearing it. To start over with the current saved row, follow
**Review the current version** or reopen the slot. When two
moderators must edit one slot, take turns: the second saver always reviews
first.

Use only public links and media you are authorized to share; do not paste
private-service URLs, personal data, or expiring/signed URLs into site content.
**Delete this slot** removes the row immediately, without a confirmation dialog;
prefer retaining/unpublishing it unless deletion is explicitly authorized.

Older/imported same-site images can still render on the homepage, but saving a
slot applies the current Image URL rules even if that field was unchanged.
Legacy instructions about an image crop do not apply to this panel.

## Join attempts and dashboard widgets

### Read-only join attempts

`/admin/join-attempts` shows **Outcome**, **Source**, **Discord id**, **Request id**,
and **Attempted** (UTC). It shows up to **100 rows per page** from the last
**90 days**, newest first, not every server join or sign-in. Use **Next** for older
rows and **Previous** to return, retaining filters; **Filter** returns to page 1.

Use **Outcome** (`added`, `already_member`, `error`, `denied`, `degraded`) and
**Discord id or request id**, then **Filter**. Search is an exact ID match, not
a username/substring search. Empty cells mean unavailable values, not verified
anonymity. Source is attribution, not authenticated identity. Select an outcome
link to open `/admin/join-attempts/:id`: it shows **Outcome**, **Source**,
**Attempted at (UTC)** and **Trace** (**Request ID**, **Discord ID**) as recorded.
Missing request IDs appear as a dash. Detail links only resolve attempts within
the same 90-day window. **Back to join attempts** returns to the unfiltered first
page. There is no edit, delete or retry control. Cancelled consent, expired state
and failures before identity exchange can record a null Discord ID; those attempts
remain visible with an empty Discord cell (a dash in detail), without inventing a
member subject. Request/source fields are still diagnostics, not proof of anonymity.
List and detail reads attribute every retrieved non-null Discord ID directly,
including the list's unrendered pagination lookahead and excluding the viewer; they
do not require a current users row or membership flag. Missing owner projections
and malformed non-null IDs still refuse the whole response rather than silently
dropping subjects. Empty, null-ID-only and self-only reads create no access row.
Audit-write failures for actual member subjects always refuse protected contents,
even with the legacy enforcement setting disabled.
Stop and escalate any refusal rather than seeking another access path.

For outcome meanings and safe escalation, use the
[join troubleshooting guide](troubleshooting-join.md#moderator-diagnostics-and-escalation).
Request ID is normally blank for the current live Discord add-member call.
The ordinary sign-in flow does not write these rows; absence is not proof of
success or no attempted join. Keep member identifiers private.

### Read-only activity log

`/admin/activity-log` shows **Who**, **What**, **When** and **Subject** for each
recorded change. It shows up to **50 rows per page**, newest first. Use
**Subject** (type, ID or description) and **Causer** (ID substring), then
**Filter**; use **Next** for older rows and **Previous** to return. There is no
edit or delete control, and the raw change payload is never shown.

**Who** is a Discord ID for current activity. Imported rows keep their legacy
internal causer IDs, shown with a **legacy ID** label; those IDs are not
remapped to members and are never access-log subjects. Views that name a member
write one access row; system-only or legacy-only pages create no per-subject
row, the same rule as join attempts. Keep member identifiers private.

### Dashboard

`/admin` has **Events**, **Featured content** and **Activity log** cards plus
these diagnostic sections when their data is available:

- **Join funnel, last 90 days:** counts for recorded outcomes across the full
  window, not just one 100-row viewer page. Aggregate counts contain no member
  identifiers; a `denied` count is not a ban count. Counts are cached for 60 seconds
  and may lag a new attempt; refreshing is not a live recount. An empty result
  says **No join attempts in the window.**
- **Top searches with no results:** the top 10 normalized search queries, miss
  counts and last-searched timestamps. Queries are lowercased, whitespace-collapsed
  and capped at 255 characters; there is no searcher identity/IP attribution.
  The widget query does not itself apply a 90-day cutoff. Treat repeated misses
  as content-planning hints, not promises of demand or a way to identify someone.
  Only complete reads are recorded here: a search run while `/events` warns that
  Discord events may be missing is skipped, because a partial read cannot prove a
  genuine no-match. A query absent from this list may still have been tried during
  a Discord outage, so never read a missing row as proof nobody searched for it.

A missing section is not proof of zero incidents: failing/slow optional funnel
or missed-search reads can omit their section while the dashboard remains
available. Both reads start together with a 1.5 s budget; that optional
widget behavior does not relax authorization or access-log enforcement.
Missing database configuration is different: normal signed-in session resolution
and admin access are unavailable, not just the widgets. A signed-session request
can return 503; guests still go to sign-in. Stop and escalate rather than assuming
an otherwise usable panel with empty counts.
There is no member-access-log viewer, user editor, role/ban manager
or join-attempt mutation screen here.

## Member deletion requests

Members can ask anytime to be removed, by DM to a moderator or through a
private support ticket; the published privacy policy promises deletion of
their rows on such a request. There is no self-serve delete button and no
delete control in this panel, so a moderator who receives a request records
it and hands it to the site maintainers/operator. Never ask for or paste
passwords, tokens, or other credentials while handling the request.

1. Confirm the request comes from the member themselves, by DM or private
   ticket. Keep the member's Discord user ID inside that private thread.
2. Hand the Discord user ID to the site maintainers/operator through the
   approved private support process. Do not run database commands, edit rows,
   or try another endpoint yourself.
3. Tell the member what happens: the operator deletes their member record,
   profile, RSVPs, sign-in sessions (this signs them out everywhere), and
   join attempts in one transaction, following the
   [member-erasure operator runbook](member-erasure.md). Signing in again
   later starts a fresh record.
4. Name the full exception inventory from the published policy's Deletion
   section, not just the two tamper-proof evidence records: past
   member-data access-log entries (never rewritten for one person; they
   delete themselves after 90 days), the moderator edit history (it keeps
   the name of the moderator who made each change), moderator-content
   authorship marks (a Discord ID kept on the content row while that row
   exists), and residual Discord-keyed rate-limit counters (cleaned up
   lazily when a later request that runs cleanup arrives, never erased
   on request). Discord-side data
   (roles, messages, tickets) is out of scope here and is handled through
   Discord's own moderation tools.

Do not promise a completion time; the operator runs the command and confirms
the per-table counts.

## Moderator boundaries and incidents

Only perform content actions you are authorized to take. Do not:

- Deploy, restart services, run host commands, change configuration or credentials.
- Change moderator roles or write database rows to work around a denied action.
- Export member identifiers, join attempts or RSVP rosters into public channels.
- Request or paste passwords, tokens, cookies, OAuth codes or callback query strings.
- Treat a notice, empty dashboard or preview as proof of a completed live action.
- Promise a Discord announcement, membership change or fix time without evidence.

For a member incident, collect the **page path**, exact visible sentence,
Support reference shown on the error page, approximate time with timezone,
whether `/discord` worked, and whether others are affected. Strip callback
queries and personal information before handing that summary to site
maintainers/engineering. Share any necessary member-specific context only
through the approved private support process.

| Report | Moderator response |
|---|---|
| Join recovery or sign-in notice | Follow the [join troubleshooting guide](troubleshooting-join.md); one-click join and sign-in have different failure behavior. |
| **Slow down a little** (429) | Wait for `Retry-After`, or at least a minute if unavailable. Copy the Support reference from the page into the incident report. Do not repeatedly click or bypass the limit. |
| **That request is too large** (413) on event create/save | Wire body is over the 64K `form` cap ([body budgets](body-limits.md#classes-and-derivation)). Shrink the payload and retry. Order is guard, then cap, then throttle: sign-in and moderator role still come first (a guest redirect or 403 takes precedence), but the cap runs before the write throttle, so an oversized body answers 413 even when the budget is spent, and 429 applies only to bodies at or under the cap. |
| **Something broke on our side** (500) | Offer `/discord` for server entry and escalate the path, wording, Support reference and time. Do not guess the cause. |
| **We will be right back** (503) | Use the invite offered by the page or `/discord`; copy the Support reference into the incident report and escalate if it persists. Do not restart anything. |
| Admin/member-data request returns 503 or says unavailable | Stop that operation and report it to engineering; protected reads can fail closed when the database/session/audit path is unavailable. |
| 403 on a moderator/admin surface | Expect it for a signed-in non-moderator, a stale role cache, or a form-action path opened directly by a signed-in non-moderator. Verify the role in-server, then re-check after a fresh sign-in and role sync ([sign-in check](#get-into-the-panel)); non-moderators get 403 and failed lookups fail closed ([probe expectations](#auth-wall-probe-staging-only)). If a current moderator hits it, escalate the path and time. |
| Dashboard card or section missing on `/admin` (Join funnel, Top searches with no results) | Do not read absence as zero: a failing or slow optional read omits its section inside the 1.5 s budget while the dashboard stays available. Stop and escalate the path and time with timezone. A signed-session 503 or missing database configuration is different: the panel itself is unavailable, so report it the same way. |
| Event page says cancelled | Explain that the event is not happening; check `/events` for an approved replacement. |

`/discord` is the database-, session- and bot-free invite fallback. It cannot
repair an invalid invite or a Discord outage. Escalate an unusable invite or
widespread repeated join/sign-in failures promptly.

## Source references

For maintainers checking this guide:

- [Admin routes](../src/admin/routes.tsx): complete route inventory and form actions.
- [Admin pages](../src/admin/pages.tsx), [validation](../src/admin/validation.ts),
  [store](../src/admin/store.ts) ([event writes](../src/admin/store-event-writes.ts),
  [event reads](../src/admin/store-event-reads.ts),
  [access log](../src/admin/store-access.ts)), [recurrence](../src/admin/recurrence.ts),
  [event-list query](../src/admin/event-list.ts), [table queries](../src/admin/table-list.ts),
  [reads](../src/admin/reads.ts) and [join-funnel widget](../src/admin/join-funnel.ts):
  labels, limits, transitions, series, filters, roster, pagination and cached counts.
- [Event-editor navigation warning](../public/islands/admin-event-editor.js):
  unsaved-change handling when leaving the edit screen.
- [Featured reads](../src/featured.ts), [image validation policy](../src/image-policy.ts)
  and [image rendering](../src/featured-image.ts): homepage windows and image-host rules.
- [Admin guard](../src/admin/guard.ts), [access log](../src/access-log.ts),
  [sessions](../src/sessions.ts), [roles](../src/roles.ts) and
  [throttling](../src/throttle.ts): permissions, member-data access logging,
  its default fail-closed policy and request limits.
- [Role-audit command](../bin/role-audit.mjs) and
  [role-audit comparison](../src/probes/role-audit.ts): deploy-time moderator
  set comparison, exit codes and bounded counts-only report.
- [Event sync](../src/events/sync.ts), [public event reads](../src/events/reads.ts)
  and [RSVP rules](../src/events/rsvp.ts): asynchronous write-back and public behavior.
- [App routes](../src/index.tsx), [public pages](../src/pages.tsx),
  [missed-search widget](../src/events/search-log.ts) and
  [error pages](../src/error-pages.tsx): current homepage wiring and diagnostic copy.
- [Admin tests](../test/admin.test.ts), [admin read tests](../test/admin-reads.test.ts)
  and [event search tests](../test/event-search.test.ts): executable behavior checks.
- [Route ownership](../src/route-ownership.ts) and the
  [Kit parity gates](kit-parity-gates.md): which renderer owns each admin GET
  and the manifest-disable rollback. The `test/kit-*` suites pin each Kit
  shell; the parity gates ledger admin journeys as skipped.
