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

## Screens and route reference

Use the navigation **Events**, **Featured**, **Join attempts**, or **Site**.
There is no panel-specific sign-out button; return to the homepage to sign out.
In the table, `:key` means an event's key and `:id` a featured slot's ID. The
POST paths are form actions, **not URLs to open or call manually**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | **Moderation** dashboard. |
| GET | `/admin/events` | Events list, search and status filter. |
| GET | `/admin/events/new` | **New event** form. |
| POST | `/admin/events` | **Create draft**. |
| GET | `/admin/events/:key` | Edit event and read its RSVP roster. |
| POST | `/admin/events/:key` | **Save** event fields. |
| POST | `/admin/events/:key/publish` | **Publish** a draft. |
| POST | `/admin/events/:key/cancel` | **Cancel** / **Cancel event**. |
| POST | `/admin/events/:key/rsvp-pause` | **Pause RSVPs** without cancelling. |
| POST | `/admin/events/:key/rsvp-reopen` | **Reopen RSVPs** on an eligible event. |
| GET | `/admin/featured` | Featured content list. |
| GET | `/admin/featured/new` | **New featured slot** form. |
| POST | `/admin/featured` | **Create** a slot. |
| GET | `/admin/featured/:id` | Edit a slot. |
| POST | `/admin/featured/:id` | **Save** slot settings. |
| POST | `/admin/featured/:id/delete` | **Delete this slot**. |
| GET | `/admin/join-attempts` | Read-only join diagnostics. |
| GET | `/admin/join-attempts/:id` | Read-only attempt outcome and trace detail. |

These are all 18 routes in `src/admin/routes.tsx` (9 GET, 9 POST). There is
no `/admin/featured-contents` legacy resource URL. Mutating buttons submit
immediately: the current panel does **not** implement confirmation dialogs.
Double-check the event/slot and intended action before pressing one.

## Create, edit and publish an event

1. Open `/admin/events`, choose **New event**, or open an existing event by its
   title. **Search** matches title only; **Status** filters `draft`, `published`,
   `cancelled` or `past`. **RSVPs** filters Open/Paused; **Series** filters
   Parent/Child/Standalone; **Fill** filters Full/Has seats/Unlimited.
   Press **Filter** to apply. The default order is newest start time first;
   **Title**, **Status** and **Starts** column links change the sort. Use
   **Previous**/**Next** for 25-row pages, retaining filters and sort.
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
   | Capacity | Empty = unlimited; otherwise a positive whole number. On edit, it cannot be lower than the current **Going** count; equality is allowed. |
   | Repeats (new events only) | **Does not repeat** or **Weekly**. Weekly requires Occurrences (1–52, including the first) or Repeat until (`YYYY-MM-DD`); when both are set the earlier bound wins. Every series is capped at 52 total occurrences, even with only a Repeat until date. |

3. Press **Create draft**. Creation always starts as `draft`; you cannot publish
   by changing a form field. After creation you land on the edit screen.
4. Check details and timezone. Press **Save** for edits. Validation failures
   show **Check the highlighted fields and try again.** with the submitted values
   retained; correct the fields rather than assuming the save happened.
5. On the list press **Publish**, or use the edit screen's **Publish** button.
   Only drafts offer it. This changes the status to `published` and attempts to
   enqueue Discord synchronization; it does **not** confirm a Discord announcement
   has already appeared. A queue failure does not undo the committed content change.
6. On the authorized deployment, check `/events` and `/e/<key>` using the same
   event key from the edit URL. Draft pages are hidden from non-moderators; a
   published, not-ended event can accept RSVPs when its RSVP setting is open.
   A successful moderator view alone does not prove a draft is public.

A fresh time in the daylight-saving **gap** is rejected; choose a real time and
ask engineering if the intended instant is unclear. There is no repeated-hour
occurrence chooser. Do not move unchanged times just to make the form save.

The form's navigation **Cancel** link only leaves the editor. It is different
from the **Cancel event** action.

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
  event. Published/cancelled saves attempt asynchronous Discord write-back;
  draft/past saves do not. Do not repeatedly save/publish to force a queue repair.
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
retain their times. Check affected occurrences after saving. There is no bulk
series cancel or repeat-rule editor.

### Read the RSVP roster

The event edit screen shows **RSVPs (count)** with **Member**, **Status**, and
**Answered** (UTC), newest responses first. The count includes all answers,
not only going seats. This is a read-only roster: no adding/removing answers,
changing seats or exporting members. Read it only for authorized moderation.
Reads of other members are access-logged; empty rosters and self-only reads create
no access row. Audit-write failures block the response under the default
fail-closed policy, not every deployment configuration. Stop and escalate any
reported audit failure; a rendered page is not proof that logging succeeded.

## Featured content settings and homepage delivery

The homepage displays eligible published slots under **From the community team**.
**Show from** is inclusive and **Show until** exclusive; slots appear in ascending
position order, with ID breaking ties. A checked **Published** box alone does not
guarantee display: its visibility window must qualify, and unavailable or slow
featured reads omit the section. There is no **Preview** control or preview route.
After an authorized content change, check the homepage before claiming it is live.

To prepare or maintain an approved slot:

1. Open `/admin/featured` and choose **New featured slot**, or open an existing
   title to edit. The list shows **Published** (`yes`/`no`), **Position**, and
   **Window (UTC)**, ordered by ascending position.
2. Fill in these settings:

   | Field | Rule |
   |---|---|
   | Headline | Required, at most 255 characters. |
   | Body | Optional supporting text. |
   | Link | Optional full HTTP(S) URL, at most 255 characters. |
   | Image URL | Optional full HTTP(S) URL on this site or HTTPS `cdn.discordapp.com`, at most 255 characters. Other hosts are rejected by the security-policy allowlist; no upload or check that the image exists. |
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

Legacy instructions about a live preview, image crop or homepage events teaser
are not a guarantee for this Next version. No drag-and-drop ordering is provided.

## Join attempts and dashboard widgets

### Read-only join attempts

`/admin/join-attempts` shows **Outcome**, **Source**, **Discord id**, **Request id**,
and **Attempted** (UTC). It shows at most the newest **100 rows in the last
90 days**, not every server join or sign-in.

Use **Outcome** (`added`, `already_member`, `error`, `denied`, `degraded`) and
**Discord id or request id**, then **Filter**. Search is an exact ID match, not
a username/substring search. Empty cells mean unavailable values, not verified
anonymity. Source is attribution, not authenticated identity. Select an outcome
link to open `/admin/join-attempts/:id`: it shows **Outcome**, **Source**,
**Attempted at (UTC)** and **Trace** (**Request ID**, **Discord ID**) as recorded.
Missing identifiers appear as a dash. Use **Back to join attempts** to return.
There is no edit, delete, retry or pagination control. The list declares recorded
Discord IDs for access logging; a detail declares a subject only when its Discord
ID maps to a stored user, regardless of that user's current membership flag.
Missing/unmapped IDs on a detail, empty lists and self-only reads create no access
row. Audit-write failures block the response under the default fail-closed policy,
not every deployment configuration. Stop and escalate any reported audit failure;
a rendered detail is not proof that an access row was written.

For outcome meanings and safe escalation, use the
[join troubleshooting guide](troubleshooting-join.md#moderator-diagnostics-and-escalation).
Request ID is normally blank for the current live Discord add-member call.
The ordinary sign-in flow does not write these rows; absence is not proof of
success or no attempted join. Keep member identifiers private.

### Dashboard

`/admin` has **Events** and **Featured content** cards plus these diagnostic
sections when their data is available:

- **Join funnel, last 90 days:** counts for each join outcome across the full
  window, not just the viewer's 100-row cap. Aggregate counts contain no member
  identifiers; a `denied` count is not a ban count.
- **Top searches with no results:** the top 10 normalized search queries, miss
  counts and last-searched timestamps. Queries are lowercased, whitespace-collapsed
  and capped at 255 characters; there is no searcher identity/IP attribution.
  The widget query does not itself apply a 90-day cutoff. Treat repeated misses
  as content-planning hints, not promises of demand or a way to identify someone.

A missing section is not proof of zero incidents: a failing/slow optional
missed-search query can omit that section while the dashboard remains available.
Missing database configuration is different: normal signed-in session resolution
and admin access are unavailable, not just the widgets. A signed-session request
can return 503; guests still go to sign-in. Stop and escalate rather than assuming
an otherwise usable panel with empty counts.
There is no activity-log/member-access-log viewer, user editor, role/ban manager
or join-attempt mutation screen here.

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
  [event-list query](../src/admin/event-list.ts) and [reads](../src/admin/reads.ts):
  labels, limits, transitions, series, filters, roster, join viewer and funnel counts.
- [Featured reads](../src/featured.ts) and [image policy](../src/featured-image.ts):
  homepage visibility windows and the accepted image hosts.
- [Admin guard](../src/admin/guard.ts), [access log](../src/access-log.ts),
  [roles](../src/roles.ts) and [throttling](../src/throttle.ts): permissions,
  member-data access logging, its default fail-closed policy and request limits.
- [Event sync](../src/events/sync.ts), [public event reads](../src/events/reads.ts)
  and [RSVP rules](../src/events/rsvp.ts): asynchronous write-back and public behavior.
- [App routes](../src/index.tsx), [public pages](../src/pages.tsx),
  [missed-search widget](../src/events/search-log.ts) and
  [error pages](../src/errors.tsx): current homepage wiring and diagnostic copy.
- [Admin tests](../test/admin.test.ts), [admin read tests](../test/admin-reads.test.ts)
  and [event search tests](../test/event-search.test.ts): executable behavior checks.
