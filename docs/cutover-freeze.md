# Cutover freeze window and member announcement (archived)

> **Archived 2026-10-12. Historical record, not a live instruction.** Do not
> declare a freeze, post an announcement or change any setting from this
> file.
>
> **Outcome.** Production went live on 2026-10-10 and the apex now serves
> `two-web-next`. The 48h post-flip watch ran `2026-10-10 00:52 UTC` to
> `2026-10-12 00:52 UTC`, and the cutover closed on 2026-10-12. The flip and
> the watch are recorded on the cutover card in the team tracker, including
> whether and how a freeze was applied. Their receipts are not in this
> repository, so a gate snapshot built from public repo state alone, such as
> [cutover-gates.md](cutover-gates.md), can still read NO-GO.
>
> **The proposal is withdrawn.** The freeze window below was written before
> the flip date was set. Take no freeze from this file: any future freeze
> (for example around a rollback and re-flip) needs new dates decided at that
> time. Companion docs that repeated this freeze (the runbook watch
> section, the rollback checklist, the watch spec and run record) are
> reconciled to this withdrawn status; read any remaining historical
> reference as describing the withdrawn proposal.
>
> **Current guidance** lives in [runbook.md](runbook.md#48h-post-flip-watch)
> (watch procedure) and [releases.md](releases.md) (release mechanics: the
> production promote cuts the release, with no release freeze).
>
> The member-facing banner code in `src/freeze-banner.ts` stays flag-gated
> off by default: leave `FREEZE_BANNER_ENABLED` unset, and nothing renders.
> This file is kept so existing links resolve.

## Original proposal (historical)

Window proposed while the CEO go/no-go on the cutover card was pending:
freeze `2026-10-14 00:00 UTC` to `2026-10-18 00:00 UTC`. The flip target was
14–16 Oct; the tail to 18 Oct was meant to cover the 48h post-flip watch.
The text promised a follow-up docs PR to move the dates if the CEO deferred;
this archive replaces that PR.

The draft was staging-safe: prose plus read-only commands only, with no
production mutation. Production cutover execution, DNS changes and any
database or secret step stayed in the separately approved operator
procedure; the file only drafted the freeze notice and the member-facing
words.

## Freeze window (historical text, superseded)

> Freeze from `2026-10-14 00:00 UTC` to `2026-10-18 00:00 UTC`: no merges to `main` except the
> Director-approved Sev-1 fixes. The cutover promote itself cuts the
> `v1.0.0` release, so no release merge is needed. The freeze lifts when
> the 48h post-flip watch exits; the lifter posts the lift on the same card.
> See [releases.md](releases.md#cutting-a-release) for the release mechanics.

Read-only checks from the draft (no mutation, no credentials):

```bash
(
  set -euo pipefail
  git fetch origin
  git log origin/main --oneline -5
  gh pr list --base main --state open
)
```

## Member announcement: Discord (historical draft, superseded)

> Hi everyone — the website moves to its new home soon.
> From `2026-10-14 00:00 UTC` to `2026-10-18 00:00 UTC` the site is frozen:
> please hold profile and event edits until we say it is over.
> Sign-in stays Discord-only, profiles and RSVPs carry over, and our
> privacy page now shows version 2 (same Privacy link in the site footer;
> Discord chats stay under Discord's own policy).
> If something looks wrong after the move, DM a moderator or open a
> private support ticket. Thank you for your patience.

## Member announcement: site banner (historical draft, superseded)

> Moving to our new site soon — edits frozen `14–18 Oct UTC`. Privacy page
> updated to version 2; details in Discord.

The banner links to the relative path `/privacy`, never a pasted URL.

## Privacy policy version 2 note (historical draft)

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
