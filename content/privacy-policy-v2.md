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
  sign-in, and it renders read-only — only your bio, games and timezone have
  an edit form.
- **What you write yourself** — bio, games list, and timezone. This lives in a
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
- **Activity stats are not stored here at all.** Rank, tenure and milestones
  are read live from the bot's records when a profile loads; if they cannot
  be read within half a second, the stats section is left out and the rest of
  the page still loads.

What we never store, ever — in the website database: email addresses (we never ask for one), passwords (there is no password column — Discord OAuth is the only way in), message content, location, or voice audio. Support-ticket transcripts are the one narrow exception, and they live in Discord, not here: staff-only, kept for 90 days, then deleted.

## Who can see it

Member profiles are members-only. Signed in with Discord as a member of our
server, you can view any member's profile; logged out, you get a sign-in
prompt instead of a profile. Only you can edit your bio, games and timezone.

On an event page, signed-in members see the names of the people going.
Moderators see every RSVP through the admin panel. RSVPs are not sent to
Discord.

When a member opens another member's profile or an event page's list of who
is going, that look is written down: who viewed, when, and whose records.
Moderators see more through the admin panel, and every look there is written
down the same way. That access log is kept for 90 days. Changes moderators
make to events and featured content are kept in an edit history that records
which moderator made each change and what changed.

Private support-ticket transcripts live in Discord, not in this site's
database: staff-only, kept for 90 days, then deleted.

## Cookies and tracking

Every cookie this site sets is its own: signed, `__Host-` prefixed, never
readable by scripts, and sent only to this site over HTTPS.

- `__Host-two_session` keeps you signed in. It holds a random token, not your
  details. It lasts 30 days and is renewed, with a fresh token, each time you
  load a page that uses your sign-in. Signing out ends it.
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

There is no separate remember-me cookie, and no role is kept in a cookie:
signing in again re-reads your Discord roles, so a changed role takes effect
at your next sign-in.

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
and we delete your rows.

## Changes to this policy

A material change ships as a new numbered version of this page, announced in
Discord. The previous versions stay in the site's public history, so you can
see exactly what changed.
