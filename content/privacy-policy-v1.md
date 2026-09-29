## Who we are, and what this covers

Together We Own is an adult gaming community. This policy covers the community
website: what it stores about you, who can see it, and how to get it deleted.
Discord itself is governed by Discord's own privacy policy — this page is only
about what we keep on our side.

## What we store

Your identity comes from Discord, and only Discord. Signing in uses Discord
OAuth with two scopes — `identify` and `guilds.members.read` — enough to know
who you are and what roles you hold in our server. The one-click join flow asks
separately for permission to add you to the server, so a returning member
checking their profile is never asked for that.

Concretely, the website keeps:

- **Your Discord identity** — Discord user ID, username, display name, avatar,
  server join date, and moderator flag. This is a cache of what Discord told us:
  it is overwritten from Discord on every sign-in, it renders read-only, and
  the profile says where each line came from.
- **What you write yourself** — bio, games list, and timezone. This lives in a
  separate place the sign-in sync never touches, so signing in can never eat
  your bio.
- **Activity stats are not stored here at all.** Ranks and XP are read live
  from the bot when your profile loads; if the bot is unreachable the stats
  section shows its empty state and the rest of the page still loads.

What we never store, ever — in the website database: email addresses (we never ask for one), passwords (there is no password column — Discord OAuth is the only way in), message content, location, or voice audio. Support-ticket transcripts are the one narrow exception, and they live in Discord, not here: staff-only, kept for 90 days, then deleted.

## Who can see it

Member profiles are members-only. Signed in with Discord, you can view any
member's profile; logged out, you get a sign-in prompt instead of a profile.

Moderators see more through the admin panel, and every look is written down:
who viewed, when, and whose records. That access log is kept for 90 days.
Private support-ticket transcripts live in Discord, not in this site's
database: staff-only, kept for 90 days, then deleted.

## Cookies and tracking

One session cookie keeps you signed in while you use the site (plus the XSRF
anti-forgery cookie on form pages). There is no remember-me cookie on purpose:
signing in again re-reads your Discord roles, so a changed role takes effect at
the next login instead of lingering in a cookie.

There are no third-party analytics or advertising trackers on this site. The
one third-party embed is the live lobby widget on the join page: an
iframe served by Discord showing who is online right now, with no fallback
content sent anywhere else. This policy page itself ships no JavaScript at
all — elsewhere on the site, interactivity comes from the site's own
first-party scripts (the global bundle carries no imports; the event page
adds a small copy-link script) and the Livewire runtime on interactive pages.

## Deletion

Ask anytime to be removed — DM a moderator or open a private support ticket —
and we delete your rows.

## Changes to this policy

A material change ships as a new numbered version of this page, announced in
Discord. The previous versions stay in the site's public history, so you can
see exactly what changed.
