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
normal browsing can rotate and extend that window. For immediate invalidation,
an authorized operator should run the command below. It does not depend on the
moderator signing out. First dry-run, check the active-session count, then apply
revocation for the moderator's Discord snowflake:

```sh
node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> --target production
node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> --target production --apply
```

The command revokes only active sessions; the database URL is supplied through
`DATABASE_URL`, never as an argument. Remote database URLs—including
production-looking ones—require `--target production`. See [the runbook procedure](runbook.md#a-moderator-lost-their-role).

## Auth-wall probe (staging only)

`bin/admin-authwall-probe.mjs` verifies all nine admin POST routes answer each
leg correctly: guests bounce to session recovery (303), signed-in
non-moderators get 403, and moderators read the dashboard (200). It logs in
both QA identities, sends empty bodies (expectations resolve before any
handler touches the database, so it writes nothing), and prints only statuses
— never tokens, cookies, or bodies. Run it with `QA_AUTH_TOKEN` from an
approved secret binding:

```sh
QA_AUTH_TOKEN=<from the approved binding, never pasted> node bin/admin-authwall-probe.mjs
```

It spends two QA-login hits and stays inside the admin-write throttle budget.
Live runs belong to the authorized cutover procedure, not CI.

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

## Create, edit and publish an event

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
   | Starts / Ends | Required local wall time, `YYYY-MM-DD HH:mm`; end must be after start. |
   | Timezone | Recognized timezone; defaults to `Europe/London`. Local form times are interpreted in this zone and stored as UTC. |
   | Location | Optional, at most 255 characters. |
   | Capacity | Empty = unlimited; otherwise a whole number from 1 to 2147483647. On edit, it cannot be lower than the current **Going** count; equality is allowed. |
   | Repeats (new events only) | **Does not repeat** or **Weekly**. Weekly requires Occurrences (1–52, including the first) or Repeat until (`YYYY-MM-DD`); when both are set the earlier bound wins. Every series is capped at 52 total occurrences, even with only a Repeat until date. |

3. Press **Create draft**. Creation always starts as `draft`; you cannot publish
   by changing a form field. After creation you land on the edit screen.
4. Check details and timezone. Press **Save** for edits. Validation failures
   show **Check the highlighted fields and try again.** with the submitted values
   retained; correct the fields rather than assuming the save happened. Title,
   description and location reject control/invisible characters; ordinary emoji
   sequences are allowed.
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
- `past` is a list filter/status, not something moderators set with a button.
  Public pages can classify an event as past by its end time even while the stored
  status still says `published`; the admin `past` filter need not include every
  ended event.
- Cancelled/past event fields can still be edited, but saving does not reopen the
  event. For the edited event itself, published/cancelled saves attempt asynchronous
  Discord write-back; draft/past saves do not. Saving a series parent can also
  shift children and enqueue their write-backs, regardless of the parent's status
  (see **Weekly series** below). Do not repeatedly save/publish to force a queue repair.
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

## Featured content settings and homepage delivery

The homepage displays eligible published slots under **From the community team**.
**Show from** is inclusive and **Show until** exclusive; slots appear in ascending
position order, with ID breaking ties. A checked **Published** box alone does not
guarantee display: its visibility window must qualify, and unavailable or slow
featured reads omit the section. There is no **Preview** control or preview route.
After an authorized content change, check the homepage before claiming it is live.

To prepare or maintain an approved slot:

1. Open `/admin/featured` and choose **New featured slot**, or open an existing
   title to edit. **Search titles** matches title text case-insensitively;
   **Published** filters All/Published/Unpublished. Press **Filter** to apply
   and return to page 1.
   The list shows **Published** (`yes`/`no`), **Position**, **Window (UTC)** and
   **Last changed** (UTC), ordered by ascending position by default. **Position**
   and **Last changed** column links toggle sorting while retaining filters
   and return to page 1. Use **Previous**/**Next** for 25-row pages, which keep
   filters and sort. There is no drag-and-drop ordering.
2. Fill in these settings:

   | Field | Rule |
   |---|---|
   | Headline | Required, at most 255 characters. |
   | Body | Optional supporting text. |
   | Link | Optional full HTTP(S) URL, at most 255 characters. |
   | Image URL | Optional full HTTPS URL on `cdn.discordapp.com` or an additional public host approved by maintainers in `FEATURED_IMAGE_HOSTS`, at most 255 characters; no credentials or custom port. This site's host is not automatically allowed for new input. No upload or check that the image exists. |
   | Image description | Required when an image URL is supplied, at most 255 characters. Describe the image accessibly. |
   | Published | Unchecked by default; a stored publication setting, not proof of homepage display. |
   | Position | Nonnegative whole number; defaults to 0, lower numbers sort first. |
   | Show from / Show until | Optional UTC `YYYY-MM-DD HH:mm`; when both exist, until must follow from. Unlike event times, these are UTC. |

3. Press **Create** or **Save** and verify the stored settings in the editor/list.
   Use only public links and media you are authorized to share; do not paste
   private-service URLs, personal data, or expiring/signed URLs into site content.
4. To withdraw a slot without removing its record, uncheck **Published** and save.
   **Delete this slot** removes the row immediately, without a confirmation dialog;
   prefer retaining/unpublishing it unless deletion is explicitly authorized.

Older/imported same-site images can still render on the homepage, but saving a
slot applies the current Image URL rules even if that field was unchanged.
Legacy instructions about a live preview or image crop do not apply to this panel.

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
4. Name the two exceptions, which stay tamper-proof as evidence: past
   member-data access-log entries (never rewritten for one person; they
   delete themselves after 90 days) and the moderator edit history (it keeps
   the name of the moderator who made each change). Discord-side data (roles,
   messages, tickets) is out of scope here and is handled through Discord's
   own moderation tools.

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
approximate time with timezone, whether `/discord` worked, and whether others
are affected. Strip callback queries and personal information before handing
that summary to site maintainers/engineering. Share any necessary member-specific
context only through the approved private support process.

| Report | Moderator response |
|---|---|
| Join recovery or sign-in notice | Follow the [join troubleshooting guide](troubleshooting-join.md); one-click join and sign-in have different failure behavior. |
| **Slow down a little** (429) | Wait for `Retry-After`, or at least a minute if unavailable. Do not repeatedly click or bypass the limit. |
| **Something broke on our side** (500) | Offer `/discord` for server entry and escalate the path, wording and time. Do not guess the cause. |
| **We will be right back** (503) | Use the invite offered by the page or `/discord`; escalate if it persists. Do not restart anything. |
| Admin/member-data request returns 503 or says unavailable | Stop that operation and report it to engineering; protected reads can fail closed when the database/session/audit path is unavailable. |
| Event page says cancelled | Explain that the event is not happening; check `/events` for an approved replacement. |

`/discord` is the database-, session- and bot-free invite fallback. It cannot
repair an invalid invite or a Discord outage. Escalate an unusable invite or
widespread repeated join/sign-in failures promptly.

## Source references

For maintainers checking this guide:

- [Admin routes](../src/admin/routes.tsx): complete route inventory and form actions.
- [Admin pages](../src/admin/pages.tsx), [validation](../src/admin/validation.ts),
  [store](../src/admin/store.ts), [recurrence](../src/admin/recurrence.ts),
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
- [Event sync](../src/events/sync.ts), [public event reads](../src/events/reads.ts)
  and [RSVP rules](../src/events/rsvp.ts): asynchronous write-back and public behavior.
- [App routes](../src/index.tsx), [public pages](../src/pages.tsx),
  [missed-search widget](../src/events/search-log.ts) and
  [error pages](../src/errors.tsx): current homepage wiring and diagnostic copy.
- [Admin tests](../test/admin.test.ts), [admin read tests](../test/admin-reads.test.ts)
  and [event search tests](../test/event-search.test.ts): executable behavior checks.
