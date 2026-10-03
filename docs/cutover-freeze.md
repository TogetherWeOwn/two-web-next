# Cutover freeze window and member announcement (draft)

Staging-safe draft: prose plus read-only commands only. No production
mutation. Production cutover execution, DNS changes and any database or
secret step stay in the separately approved operator procedure; this file
only drafts the freeze notice and the member-facing words.

## Freeze window (draft text for the release card and ops channel)

> Freeze from `<UTC start>` to `<UTC end>`: no merges to `main` except the
> reviewed cutover release and Director-approved Sev-1 fixes. The freeze
> lifts when the 48h post-flip watch exits; the lifter posts the lift on
> the same card. See the short release freeze in
> [releases.md](releases.md#cutting-a-release) for the cut mechanics.

Read-only checks (no mutation, no credentials):

```bash
(
  set -euo pipefail
  git fetch origin
  git log origin/main --oneline -5
  gh pr list --base main --state open
)
```

## Member announcement: Discord (draft)

> Hi everyone — the website moves to its new home soon.
> From `<UTC start>` to `<UTC end>` the site is frozen: please hold profile
> and event edits until we say it is over.
> Sign-in stays Discord-only, profiles and RSVPs carry over, and our
> privacy page now shows version 2 (same Privacy link in the site footer;
> Discord chats stay under Discord's own policy).
> If something looks wrong after the move, DM a moderator or open a
> private support ticket. Thank you for your patience.

## Member announcement: site banner (draft)

> Moving to our new site soon — edits frozen `<dates UTC>`. Privacy page
> updated to version 2; details in Discord.

The banner links to the relative path `/privacy`, never a pasted URL.

## Privacy policy version 2 note (draft)

The live source is [content/privacy-policy-v2.md](../content/privacy-policy-v2.md),
served at `/privacy` and bundled via `src/privacy-content.ts`. Member words:

> Version 2 says in plain terms what the site keeps: your Discord identity
> (ID, display name, avatar, server membership, refreshed from Discord on
> every sign-in), what you write yourself (bio, games, timezone), sessions,
> RSVPs, join attempts (90 days), short-lived rate-limit counters and
> anonymous search counts. It never asks for your email or server list, and
> never stores passwords, message content, location or voice. Profiles are
> members-only; moderator looks are access-logged (90 days). A material
> change ships as a new numbered version announced in Discord, with older
> versions kept in public history.
