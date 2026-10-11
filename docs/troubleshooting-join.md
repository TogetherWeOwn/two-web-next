# Troubleshooting join and Discord sign-in

For moderators helping someone join the TWO Discord or sign in to the Next
website. Companion: [moderator admin guide](moderator-admin-guide.md).
The member-facing instructions are on `/faq`.

## Start with the page and the wording

Ask which path they used, the exact sentence shown, and the approximate time
with timezone. Record **only the path**, not the full callback URL: its query
can contain an OAuth code and state. Never ask for passwords, tokens, cookies,
callback codes, or screenshots of the Discord approval/callback URL.

There are two different journeys:

- **One-click join:** `/join` → **Join with Discord** → `/join/discord` →
  Discord approval → `/join/callback`. Success signs them in and normally
  returns to the homepage. A validated same-site `next` path can instead take
  them back to another page without a homepage notice. Failures render a
  recovery page with **Try again** and **Join with an invite link instead**.
- **Sign-in:** `/auth/discord` → Discord approval →
  `/auth/discord/callback` → homepage. This also attempts to add them to the
  server, but an auto-join failure does not prevent website sign-in.
- **Invite fallback:** `/discord` redirects to a Discord invite without
  consulting the session, database or bot. It bypasses website OAuth, not
  Discord's rules screening or the validity of the invite itself.

Give out the canonical paths above, not legacy URLs. `/join/redirect` is not
mounted. Old `/auth/discord/redirect` links now redirect to a fresh
`/auth/discord` journey; they are not a callback or a reason to reuse an approval.

## Homepage notices

These are the four recognized `n` notices. The text is a useful clue, not proof
of membership or authentication: someone can type a notice query themselves.

| Notice | Exact text | What to tell the member |
|---|---|---|
| `joined` | "You're in. Welcome to the TWO Discord." | Open Discord and finish its rules/membership screening before posting. |
| `already_member` | "Signed in. You're already in the TWO Discord." | Open the existing server; if posting is locked, check the rules screen. |
| `join_failed` | "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below." | Website sign-in succeeded, but automatic server entry failed. Use **Join with an invite link instead** or `/discord`, finish screening, then sign out and sign in again to refresh website membership. |
| `signin_failed` | "Discord sign-in didn't complete. Please try again." | Start a fresh sign-in at `/auth/discord`. If it fails again, use `/discord` for server entry and report the repeated sign-in failure. |

`join_failed` is the **sign-in** flow's result. The one-click join flow shows
its own recovery page instead and does **not** issue a new signed-in session
when automatic entry fails. Do not promise that a recovery page signed them in.

## One-click join recovery pages

All of these offer **Try again** (a fresh `/join/discord` journey) and the
invite fallback. Do not reload, bookmark, share or replay `/join/callback`.

| Heading | Exact message | Meaning and next step |
|---|---|---|
| **Join cancelled** | "You cancelled the Discord approval, so we couldn't add you to the server. Try again, or use the invite link below." | Consent was declined. Nothing to reset; retry only if they want to approve, or use the invite. |
| **Join didn't complete** | "Discord didn't complete the approval. Try again, or use the invite link below." | Discord returned another approval error. Try once afresh; repeated or widespread failures go to engineering. |
| **Join link expired** | "That join link expired. Approvals last ten minutes — try again below." | Missing, mismatched or expired state/code; often a stale callback or lost journey cookie. Start again in the same browser and approve promptly. |
| **Discord is unreachable** | "We couldn't reach Discord to complete the join. Try again in a moment, or use the invite link below." | Token exchange or user lookup failed; this recovery page returns 503. It does not establish the root cause. Try once later or use the invite. |
| **We couldn't add you automatically** | "You're nearly there — use the invite link below to join the server directly." | The automatic add was refused or failed. Use the invite; do not keep replaying the approval. |

An expired Discord authorization code can also produce **Discord is
unreachable**; Next does not expose a separate `invalid_grant` message.
A 200 response on another recovery page is not a successful join.

**Slow down a little** (429) means the request budget was exceeded. Wait for
`Retry-After` if available, otherwise at least a minute, before starting a
fresh journey. Do not repeatedly click, refresh or try to evade the limit.

## Still locked out after a successful join

- **Cannot post in Discord:** finish Discord's membership/rules screening.
  Website sign-in is not permission to skip the rules. See `/faq`.
- **Invite worked but `/profile` says forbidden:** membership in the website
  session may be stale after `join_failed`. Sign out using the homepage's
  **Sign out** button, then sign in again. A persistent failure needs engineering.
- **Moderator gets 403 at `/admin`:** sign out and back in once after a role
  change. Both successful Next sign-in and one-click join recompute moderator
  status through the bot's Discord role lookup. A missing allowed role, blank
  role configuration or failed lookup all fail closed. A fresh 403 is **not**
  proof the person lost their Discord role; ask the maintainers to check.
- **Missing server preview on `/join`:** the widget is optional. The join
  button and invite remain the paths to try; a missing preview alone does not
  mean joining is broken.

## Moderator diagnostics and escalation

Use `/admin/join-attempts` only for a legitimate support incident. It is
read-only and contains member identifiers: do not copy its rows into a public
channel. It shows up to 100 rows per page within the last 90 days, newest first.
Filter by **Outcome** or an exact **Discord id or request id**; **Filter** returns
to page 1, and **Previous**/**Next** retain the filters. Open an outcome link for
the recorded detail; older-than-window details return 404. See the
[admin guide](moderator-admin-guide.md#read-only-join-attempts) for controls.

The `/admin` **Join funnel, last 90 days** counts the whole window, not one viewer
page. These are aggregate hints cached for 60 seconds, not live membership checks.
A failed/slow optional read can omit the widget; absence does not mean zero
attempts. This does not bypass admin session or audit checks.

The join attempt outcomes are **not** the homepage notice names:

| Stored outcome | Meaning in the one-click journey |
|---|---|
| `added` | Discord reported a newly added member (normally `joined` on the homepage). |
| `already_member` | Discord reported the member was already present. |
| `denied` | Discord returned an approval error, including cancelled consent. |
| `error` | State/code validation or token exchange/user lookup failed. |
| `degraded` | Automatic server entry failed or was refused after identity lookup. |

The table is not a complete sign-in history: `/auth/discord/callback` does not
write join-attempt rows, throttled requests do not reach the recorder, and a
missing join store can leave no row. The current live add-member call also
leaves Request ID empty; do not promise a trace ID or infer success from an
absent row. List and detail reads attribute the returned rows' recorded Discord
IDs directly, excluding the viewer, without requiring a current users row or
membership flag. Missing, invalid or partial member keys refuse the contents;
they are not silently omitted from attribution. Empty lists and self-only reads
create no access row. Audit-write failures always refuse protected contents,
even with the legacy enforcement setting disabled. Any reported audit failure
or 503 on member data is a stop condition, not a reason to find another access path.

Escalate to the site maintainers/engineering with:

1. Path and exact wording (callback query removed), approximate time and timezone.
2. Whether the invite at `/discord` worked and whether website sign-in worked.
3. Whether one person or several people are affected, with an approximate count.
4. [Discord status](https://discordstatus.com), if a widespread Discord failure
   is suspected. Do not label a generic recovery message a confirmed outage.

A single cancelled approval needs no escalation. For a repeatedly stuck member,
try one fresh private browser window, then escalate if it persists. Many failures
at once, an unusable invite, or sign-in failing for everyone need prompt
engineering attention. Do not promise a fix time, change roles to bypass checks,
reset credentials, edit database rows, deploy or restart anything.

## Source references

This guide describes the implementation, not a live staging certification:

- [Join routes](../src/join/route.ts): journey cookies, ten-minute expiry,
  recovery wording, attempt recording and successful-session issuance.
- [Join service](../src/join/service.ts): outcomes, safe return paths, throttling
  and the direct Discord add-member call.
- [Auth routes](../src/auth/routes.ts): `/auth/discord`, its callback and
  logout; [app routes](../src/index.tsx): `/discord`;
  [page text](../src/pages.tsx): notices, join/recovery pages and FAQ.
- [Role lookup](../src/roles.ts) and [rate-limit page](../src/errors.tsx).
- [Admin routes](../src/admin/routes.tsx), [admin pages](../src/admin/pages.tsx),
  [table queries](../src/admin/table-list.ts), [admin reads](../src/admin/reads.ts)
  and [join-funnel widget](../src/admin/join-funnel.ts): read-only controls,
  retention window, pagination and cached aggregate diagnostics.
- [Admin guard](../src/admin/guard.ts), [sessions](../src/sessions.ts) and
  [access logging](../src/access-log.ts): session availability and audit enforcement.
