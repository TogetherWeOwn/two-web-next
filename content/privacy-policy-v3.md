## Who we are, and what this covers

Together We Own is an adult gaming community. This policy covers the community
website and the community's Discord bot in our server: what they store about
you, who can see it, what it is never used for, and how to get it deleted.
Discord itself is governed by Discord's own privacy policy — this page is only
about what we keep on our side.

## What we store

Your identity comes from Discord, and only Discord. Signing in uses Discord
OAuth with two scopes — `identify`, so we know who you are, and `guilds.join`,
so our bot can add you to the server in one click if you are not in it yet.
We never ask Discord for your email address or your list of servers. Your
roles in our server are read by our own bot when you sign in, not through your
sign-in.

Concretely, the website keeps:

- **Your Discord identity** — Discord user ID, display name (or username if
  you have no display name), avatar, and whether you are in our server. This
  is a cache of what Discord told us: it is overwritten from Discord on every
  sign-in, and it renders read-only — only your bio, games, timezone and
  leaderboard switch have an edit form.
- **What you write yourself** — bio, games list, timezone and leaderboard visibility. This lives in a
  separate place the sign-in sync never touches, so signing in can never eat
  your bio.
- **Your sign-in session** — a record holding your Discord ID, name, avatar,
  whether you are in our server, and whether you are a moderator (worked out
  from your Discord roles when you sign in). Signing out ends it at once; the
  record is deleted after it expires.
- **Your event RSVPs** — which events you answered going, maybe or not going,
  whether you are on a waitlist, and when you answered.
- **Join attempts** — each time someone uses the one-click join, we note the
  outcome, the campaign tag on the link if there was one, a request ID, and
  the Discord ID once Discord has told us who you are. This is how we can
  tell whether joining works. Kept for 90 days, then deleted.
- **Rate-limit counters** — to stop abuse, sign-ins, sign-outs and form posts
  are counted against your IP address (profile and RSVP edits against your
  Discord ID instead). Counters older than five minutes are deleted the next
  time the site counts a request.
- **Event searches** — the words searched for and how many results came back,
  with nothing that links a search to you: no user, no session, no IP
  address. Kept for 90 days, then deleted.
- **Leaderboard views** — which board was opened, for which season, and how
  many rows it showed, with nothing that links a view to you: no user, no
  session, no IP address. Kept for 90 days, then deleted. Whether you appear
  on leaderboards is kept on your profile, and you can switch it yourself.
- **Activity stats are not stored here at all.** Rank, tenure and milestones
  are read live from the bot's records when a profile loads; if they cannot
  be read within half a second, the stats section is left out and the rest of
  the page still loads.

What we never store, ever — in the website database: email addresses (we never ask for one), passwords (there is no password column — Discord OAuth is the only way in), message content, location, or voice audio. The website does not keep support-ticket transcripts; the bot does, as described below.

## Who can see it

Member profiles are members-only. Signed in with Discord as a member of our
server, you can view any member's profile; logged out, you get a sign-in
prompt instead of a profile. Only you can edit your bio, games, timezone and leaderboard visibility.

On an event page, signed-in members see the names of the people going.
Moderators see every RSVP through the admin panel. RSVPs are not sent to
Discord.

When a member opens another member's profile or an event page's list of who
is going, that look is written down: who viewed, when, and whose records.
Moderators see more through the admin panel, and every look there is written
down the same way. That access log is kept for 90 days. Changes moderators
make to events and featured content are kept in an edit history that records
which moderator made each change and what changed.

Support-ticket transcripts are visible only to the staff who handle that ticket.

The member leaderboard is members-only. It ranks members by how many events
they answered going to, optionally for one season or one game, and shows only
rank, display name and that count. It never counts join attempts and shows no
dates. When it shows other members, that look is written down in the access
log like any other look at members' records. To stay off leaderboards, turn
off visibility on your profile, DM a moderator, or open a private support ticket;
you will be removed from every board and every count.

## What the Discord bot keeps

The bot runs features in our server, and it keeps records for them. Most of
those records are kept in our own database. We do not sell, license, or
commercialize this data, or share it with advertising networks, data brokers, or
monetization services (see "Selling and sharing" below).

- **Membership and invites** — your Discord user ID, when you joined and left,
  which invite link you joined through, and activity milestones.
- **Levels and ranks** — XP totals earned from your activity in our server, such
  as posting messages; the awards and cooldowns that produced them; your rank;
  and any raid exclusion that applies to you.
- **Events and RSVPs** — the event details we publish to Discord (name, start
  and end time, location and description), and the RSVP and attendance facts the
  bot records for events. RSVPs you make on this website are not sent to Discord.
- **Moderation and safety** — moderation actions taken against you, with the
  moderator's ID and the reason; automod counts, which store your ID, the
  message ID and the rule that matched, never the message text; and join-risk
  evidence (account age, join time, risk score and reasons) and anti-nuke
  containment records that name you.
- **Support tickets** — when a ticket is opened in our server, the IDs of the
  people who opened and claimed it. When the ticket closes, the bot saves a
  transcript of its messages, including their text and attachment links.
  Support-ticket transcripts are kept for 90 days after they are saved, then
  deleted.
- **Voice rooms** — for temporary voice rooms: the owner's and creator's IDs, the
  block and grant lists, and vote-kick records (who started a vote and who it
  targeted). The bot never records audio.
- **Posts and sign-ups** — looking-for-group posts and who signed up for them,
  self-role claims, and scheduled and sticky messages, with the IDs of the people
  who created or edited them.
- **Audit trail** — a record of configuration changes and operator actions, with
  the IDs of the people who made them.

The bot keeps message text only in support-ticket transcripts.

Most bot records have no automatic deletion timer. They stay until we erase
them for you on request, or until the feature that created them removes them.
Backup copies can also hold them (see "Deletion" below).

## Why the bot asks Discord for sensitive data

Discord sends the bot sensitive data only when we ask for it, and we ask only
for what these features need:

- **Member list** — always requested. It lets the bot see joins and leaves,
  match them to invites, and give roles.
- **Moderation log** — always requested. It lets the bot record moderation
  actions taken in our server, so moderators can see who did what.
- **Invites** — always requested. It attributes each join to the invite link used.
- **Voice state** — always requested. It runs temporary voice rooms: who is in
  which room. The bot never receives or stores voice audio.
- **Online status** — requested only when voice rooms use it to name rooms, and
  only when that feature is switched on.
- **Message content** — requested only when a feature that needs it is switched
  on: support tickets, automod or custom text commands. Otherwise the bot never
  receives message text.

## Cookies and tracking

Every cookie this site sets is its own: signed, `__Host-` prefixed, never
readable by scripts, and sent only to this site over HTTPS.

- `__Host-two_session` keeps you signed in. It holds a random token, not your
  details. It lasts 120 minutes, and the clock restarts, with a fresh token,
  each time you load a page that uses your sign-in; stay away for two hours
  and you are signed out. Signing out ends it.
- `__Host-two_session_status` lets other open tabs notice that you signed
  out. It can only check whether a session is still live and can never sign
  anyone in. It lasts as long as the session cookie.
- `__Host-two_oauth_state`, `__Host-two_join_state`, `__Host-two_login_next`,
  `__Host-two_login_intended`, `__Host-two_join_next`,
  `__Host-two_join_source`, `__Host-two_join_result` and
  `__Host-two_expired_write` carry one sign-in, join or form-retry journey:
  an anti-forgery code, the page to return you to, the join campaign tag, or
  a one-time result message. Each lasts at most 10 minutes, and none of them
  holds anything you typed.
- In browsers that cannot pass messages between tabs, the sign-out check
  stores only a timestamp in your browser's local storage — nothing about
  who you are.

There is no remember-me cookie on purpose: signing in again re-reads your
Discord roles, so a changed role takes effect at the next login instead of
lingering in a cookie.

There are no third-party analytics or advertising trackers on this site, and
no third-party scripts. The one third-party embed is the live lobby widget on
the join page: an iframe served by Discord showing who is online right now,
loaded only when you scroll to it and sent no referrer. If it is unavailable,
the page shows a plain line of text from our own site instead. Avatars and
other pictures load from our own site or straight from Discord's image server
(`cdn.discordapp.com`), which is told only that the request came from this
site. This policy page itself ships no JavaScript at all — elsewhere on the
site, interactivity comes from small first-party scripts served from this
site, such as the copy-link button and the RSVP button on event pages.

The site runs on Cloudflare, which handles each request (including your IP
address) to deliver the page. Our own request logs record the page route,
the response status, how long it took and which Cloudflare data center
served it — never your IP address or who you are.

## Deletion

Ask anytime to be removed. DM a moderator or open a private support ticket in
our server. A moderator passes the request to the operator, who checks it and
then deletes:

- on the website: your member record, profile (including leaderboard visibility), RSVPs, sign-in sessions and join
  attempts. Signing in again later starts a fresh record;
- in the bot: the records in "What the Discord bot keeps" that name you, which
  include your membership and invite records, XP and ranks, RSVPs and
  attendance facts, moderation and safety records, support-ticket transcripts
  you opened or claimed, voice-room records, and posts and sign-ups.

Deletion covers records from our server only; records from any other Discord
server are not affected. It removes what is stored when the request is carried
out. It does not reach:

- backup copies. Backups are kept as a limited set of recent snapshots rather
  than for a set period, so an older backup can still hold your records until
  it rotates out. Before restored data is opened to anyone, earlier deletion
  requests are applied to it again;
- Discord itself. Messages and attachments you posted on Discord are governed by
  Discord, and removing them happens through Discord's own tools;
- logs kept outside our databases.

There is no opt-out switch yet for the bot's records, so a deletion does not stop
new activity from being recorded while you remain in the server. Deletion is carried out by an
operator, not instantly, and we do not promise a completion time.

Some records are kept on purpose:

- The access log (who looked at whose records, described above) is not rewritten
  for one person; it deletes itself after 90 days.
- The moderator edit history keeps the name of the moderator who made each change.
- The bot's settings history keeps the IDs of the staff and moderators who changed
  settings, and active settings keep the staff, raid and test ID lists they were
  configured with.
- The bot's deletion receipt records the operator and a time, never your ID.
- One replay guard for a moderation action may keep an ID that was used as its
  key, so that a delayed duplicate cannot repeat the action.

## Selling and sharing

We do not sell, license or commercialize any of the data described in this
policy, including the Discord data the bot receives. We do not share it with
advertising networks, data brokers or monetization services. The only parties
that handle it are the infrastructure providers that run the website and the
bot, and they handle it only to run them.

## Changes to this policy

A material change ships as a new numbered version of this page, announced in
Discord. The previous versions stay in the site's public history, so you can
see exactly what changed.

Version 3 adds the member leaderboard and its opt-out: a members-only board that ranks members by going RSVPs for published events, filterable by season, scope and game, with each view logged without identity like other board views. It never counts join attempts, and opting out removes a member from every board and every count. It also describes the community bot's records, data requests, and deletion limits.
