## Who we are, and what this covers

Together We Own is an adult gaming community. This policy covers the community
website: what it stores about you, who can see it, and how to get it deleted.
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
  sign-in, and it renders read-only — only your profile fields (below)
  have an edit form.
- **What you write yourself** — bio, games list, timezone and leaderboard visibility. This lives in a
  separate place the sign-in sync never touches, so signing in can never eat
  your bio.
- **Your handle and visibility choices** — your profile lives at
  `/u/<handle>`; the handle defaults to your Discord username and you can
  change it. Every profile field has a Public or Members-only toggle:
  display name, avatar, ladder rank and member-since date start public,
  while bio, games, timezone and Steam start members-only. Search
  indexing stays off unless you opt in.
- **Your linked Steam account, if you link one** — linking is optional and
  link-only: Discord stays the only way to sign in. We keep your Steam ID,
  persona name, avatar, profile link, what you are currently playing, and
  your top 5 games by playtime, refreshed from Steam daily. Your owned
  games are offered as suggestions when you edit your games list. One
  Steam account per member: an additional link attempt is refused with an
  explanation. Unlinking removes all synced Steam data immediately, and
  moderators can unlink an account too.
- **Your banner, links and featured games** — a banner image you upload, up
  to 5 links, up to 6 featured games, and an accent colour. The banner is
  size-limited and re-encoded to strip metadata, then stored in R2
  (Cloudflare object storage) and follows your visibility choices.
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
  Discord ID instead). Five minutes is an age cutoff, not a deletion timer:
  an expired counter survives until a later request that runs cleanup deletes
  it, so counters can linger past five minutes on a quiet site.
- **Event searches** — the words searched for and how many results came back,
  with nothing that links a search to you: no user, no session, no IP
  address. Kept for 90 days, then deleted.
- **Leaderboard views** — the anonymous board-view log records which board
  was opened, its scope and season, and the result count, with no user,
  session or IP address. It is kept for 90 days. This is separate from
  member-data access auditing: when the member leaderboard reads other
  members' records, the access log records who viewed, when, and whose
  records were read, also for 90 days. Hot-zone boards use the anonymous
  board-view log without member-data access auditing. Whether you appear
  on leaderboards is kept on your profile, and you can switch it yourself.
- **Activity stats are not stored here at all.** Rank, tenure and milestones
  are read live from the bot's records when a profile loads; if they cannot
  be read within half a second, the stats section is left out and the rest of
  the page still loads.

What we never store, ever — in the website database: email addresses (we never ask for one), passwords (there is no password column — Discord OAuth is the only way in), message content, location, or voice audio. Support-ticket transcripts are the one narrow exception, and they live in Discord, not here: staff-only, kept for 90 days, then deleted.

## Who can see it

Profiles have two audiences: Public (anyone on the web) or Members
(signed-in members of our server). Each field carries your choice: display
name, avatar, ladder rank and member-since date are public by default,
while bio, games, timezone and Steam are members-only by default, and
every field has its own toggle. Leaving a field empty hides it. The
public view shows your display name only — never your Discord username or
ID; the members view adds your username and a Message on Discord button.
Only you can edit your profile. If you leave the server, your public
profile shows a not-found page while members still see it marked former
member.

Public profiles tell search engines not to index them. That changes only
if you opt in to indexing.

On an event page, signed-in members see the names of the people going.
Moderators see every RSVP through the admin panel. RSVPs are not sent to
Discord.

When a member opens another member's profile or an event page's list of who
is going, that look is written down: who viewed, when, and whose records.
Moderators see more through the admin panel, and every look there is written
down the same way. That access log is kept for 90 days. Changes moderators
make to events and featured content are kept in an edit history that records
which moderator made each change and what changed; each content row also keeps
its author's Discord ID as its authorship mark.

Anyone can report a public profile with its Report button; the report goes
to a moderator queue. Moderators can hide any profile field, and every
hide is written to the audit log.

Private support-ticket transcripts live in Discord, not in this site's
database: staff-only, kept for 90 days, then deleted.

The member leaderboard is members-only. It ranks members by how many events
they answered going to, optionally for one season or one game, and shows only
rank, display name and that count. It never counts join attempts and shows no
dates. When it shows other members, that look is written down in the access
log like any other look at members' records. You can opt out of leaderboards at any time — switch it off on your profile, or DM a moderator
or open a private support ticket — and you leave every board and every count.

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

Ask anytime to be removed — DM a moderator or open a private support ticket —
and we delete your rows: your member record, profile, RSVPs, sign-in sessions
and join attempts, plus your linked Steam account data and banner image.
Signing in again later starts a fresh record.

Two evidence records are exceptions, because they are kept tamper-proof as
evidence and are not edited on request. The access log (who looked at whose
records, described above) is not rewritten for one person; it deletes itself
after 90 days. The moderator edit history keeps the name of the moderator who
made each change.

Two further traces also stay, and neither is erased with your rows. Moderator
content you authored keeps your Discord ID on the content row as its
authorship mark (described above): that mark is your identifying data, and it
lasts as long as the content row does. Residual rate-limit counters keyed to
your Discord ID (described above) are not deleted with your rows either; they
are cleaned up lazily when a later request that runs cleanup arrives, so an
expired counter can linger until such a request arrives.

## Changes to this policy

A material change ships as a new numbered version of this page, announced in
Discord. The previous versions stay in the site's public history, so you can
see exactly what changed.

Version 3 adds the member leaderboard and its opt-out: a members-only board that ranks members by going RSVPs for published events, filterable by season, scope and game. It uses anonymous board-view telemetry, separately from viewer-linked member-data access auditing when it reads other members' records. It never counts join attempts, and opting out removes a member from every board and every count.

Version 4 names the two further Deletion traces alongside the two tamper-proof evidence records: moderator-content authorship marks (a Discord ID kept with the content row) and residual Discord-keyed rate-limit counters (cleaned up lazily when a later request that runs cleanup arrives). The five deleted row categories are unchanged, and no retention period changed.

Version 5 clarifies that anonymous board-view telemetry and viewer-linked member-data access auditing are separate records. No collection, erasure category or retention period changes.

Version 6 adds public profiles with per-field Public/Members visibility, an indexing opt-in, Steam linking with daily-synced data removed on unlink, banner images, and profile reporting with moderator field hiding. Erasure gains linked-account rows and the banner image; no retention period changes.
