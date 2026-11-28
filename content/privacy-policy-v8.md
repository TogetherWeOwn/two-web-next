## Who we are, and what this covers

Together We Own is an adult gaming community at togetherweown.com (two.gg
redirects there). This policy covers the community website: what it stores
about you, who can see it, and how to get it deleted. Discord itself is
governed by Discord's own privacy policy, and our Discord bot has its own
in-server privacy controls — this page is about what the website keeps on
our side.

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
- **Your event RSVPs** — which events you answered going, maybe or not going on
  the website, and when you answered. Website RSVPs do not use waitlists at
  launch; separately, Discord `/rsvp` answers (going, interested or declined)
  are stored by our Discord bot and power a single best-effort reminder posted
  in the event's Discord channel during the final 15 minutes before start,
  never by DM.
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

Member profiles are members-only. Signed in with Discord as a member of our
server, you can view any member's profile; logged out, you get a sign-in
prompt instead of a profile. Only you can edit your bio, games, timezone and leaderboard visibility.

On an event page, signed-in members see the names of the people going.
Moderators see every website RSVP through the admin panel. Individual website
RSVPs and member identities are not sent to Discord — background syncing to
Discord mirrors only public event details (such as title, time, location and
description). Separately, if you RSVP inside Discord with `/rsvp` as going or
interested, the bot posts at most one best-effort reminder in the event's
Discord channel (never a DM) with notification pings suppressed.

When a member opens another member's profile or an event page's list of who
is going, that look is written down: who viewed, when, and whose records.
Moderators see more through the admin panel, and every look there is written
down the same way. That access log is kept for 90 days. Changes moderators
make to events and featured content are kept in an edit history that records
which moderator made each change and what changed; each content row also keeps
its author's Discord ID as its authorship mark.

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
  and you are signed out. No session lasts more than 24 hours after you sign
  in: the absolute clock starts at login and page loads never extend past it.
  Signing out ends it.
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

There are no ads, advertising trackers, or cross-site tracking scripts on this
site, and no tracking cookies. To measure page-load speed and core web
performance, Cloudflare Web Analytics uses a lightweight, cookieless Real User
Monitoring beacon (`/cdn-cgi/rum`) injected by Cloudflare's edge on HTML
responses. It sets no cookies, uses no browser local storage, performs no
cross-site tracking or user fingerprinting, and does not store visitor IP
addresses — Cloudflare uses the IP address transiently at the nearest data
center to derive coarse country information and discards it. Beacon
measurements can include the page address path, referrer, and descriptions of
slow or shifting page elements. Cloudflare receives this data as our service
provider (as a processor under its customer data processing terms; Cloudflare's
own privacy policy also describes some processing it does for its own purposes).
Cloudflare retains unsampled Web Analytics data for 7 days and provides access
to aggregated trends for up to 6 months; that access window is not a promise
about when every Cloudflare record is deleted.

**Correction for legacy third-party tags.** Earlier versions of this policy
said there were no third-party analytics or advertising trackers on this site,
and no third-party scripts. That was inaccurate for an earlier period: our
operator reported that a legacy Cloudflare Zaraz setup delivered Google
Analytics 4, Google Ads and Meta pixel tags on this site, and that no consent
step was configured in Zaraz. The operator reported Zaraz tracking events on
3 November 2026 and a site-wide rule disabling Zaraz on 4 November 2026 at
about 06:16 UTC. The old tag settings still exist in our Cloudflare account;
keeping them does not mean they are running. We do not know how long those
tags were active, how many people they reached, what each event contained, or
what Google or Meta received or kept, and we do not claim earlier third-party
data was deleted. This correction does not turn any advertising tracking on.

The one third-party embed is the live lobby widget on the join page: an iframe
served by Discord showing who is online right now, loaded only when you click
to show it and sent no referrer. If it is unavailable, the page shows a plain
line of text from our own site instead. Avatars and other pictures load from
our own site or straight from Discord's image server (`cdn.discordapp.com`),
which is told only that the request came from this site. Our own application
adds no JavaScript to this policy page. Cloudflare's security service can
still add a small script of its own to pages, including this one, to tell
people apart from automated traffic, and Cloudflare's edge may still inject
its cookieless page-speed beacon unless `/privacy` is excluded in Cloudflare
Web Analytics rules. Elsewhere on the site, interactivity comes from small
first-party scripts served from this site, such as the copy-link button and
the RSVP button on event pages.

The site runs on Cloudflare, which handles each request (including your IP
address) to deliver the page. Our own request logs record the page route,
the response status, how long it took and which Cloudflare data center
served it — never your IP address or who you are.

## Deletion

Ask anytime to be removed — DM a moderator or open a private support ticket —
and we delete your rows: your member record, profile, RSVPs, sign-in sessions
and join attempts. Signing in again later starts a fresh record.

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

Version 6 caps every sign-in at an absolute 24 hours after login: page loads still restart the sliding window with a fresh token, but renewal never extends past the absolute clock, so a changed Discord role takes effect no later than the next login after the cap. No collection, erasure category or retention period changes.

Version 8 names togetherweown.com as the canonical domain (with two.gg redirecting to it), corrects earlier versions to disclose legacy Google Analytics 4, Google Ads and Meta tags delivered through Cloudflare Zaraz (reported disabled on 4 November 2026) and Cloudflare's security script, discloses cookieless Cloudflare Web Analytics (`/cdn-cgi/rum`) page-speed measurement (no cookies, no stored IPs, 7 days unsampled and up to 6 months aggregated access window in Cloudflare), updates the join-page Discord preview wording to click-to-load, removes unshipped waitlist claims, clarifies that website-to-Discord syncing mirrors event details rather than individual RSVPs, and describes the Discord bot's 15-minute channel-only `/rsvp` reminders. It does not turn on any advertising tracking, claim earlier third-party data was deleted, or change member-record deletion. Version 7 was an unpublished draft for future public profiles and Steam linking and was never in effect.
