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

The home page recognizes exactly these six `n` notices. The query only selects
which copy to display; anyone can type it. It does not prove that a callback ran,
that sign-in succeeded, or that the person is a Discord member.

| Notice | Exact text | What to tell the member |
|---|---|---|
| `joined` | "You're in. Welcome to the TWO Discord." | On a real successful callback, automatic add reported a new member. Open Discord and finish its rules/membership screening before posting. The query itself is not a membership check. |
| `already_member` | "Signed in. You're already in the TWO Discord." | On a real successful callback, Discord reported an existing member. Open the server and finish screening if needed; the notice is not a live membership check. |
| `join_failed` | "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below." | This sign-in flow could not add the person automatically and creates a non-member session. Use **Join with an invite link instead** or `/discord`, then finish Discord screening. Do not say membership was established. |
| `signin_failed` | "Discord sign-in didn't complete. Please try again." | This is the generic sign-in failure, not a diagnosis of cancellation or a Discord outage. Start a fresh sign-in at `/auth/discord`; if it repeats, report the failure without sharing callback parameters. |
| `signin_denied` | "You cancelled the Discord sign-in, so we didn't sign you in. Nothing changed — try again whenever you like." | This is the cancelled-consent outcome, distinct from a generic failure or provider outage. If the person wants to continue, start again at `/auth/discord`. The query alone does not prove that consent was cancelled. |
| `signin_unavailable` | "Discord did not answer just now, so we could not sign you in. This is on Discord, not you — please try again in a minute." | This is the provider-unavailable outcome during code exchange or user lookup. Wait a minute and try a fresh sign-in; do not infer an outage from the generic `signin_failed` copy. |

The browser shows only the site's own wording; it does not expose Discord's
`error_description`. Do not treat a notice name or sentence as evidence of
authentication, current membership, or the cause of a failure.

`join_failed` belongs to the **sign-in** flow. A failed automatic add still
issues a non-member session, so the notice does not mean the person joined.
The one-click `/join` flow has its own recovery page and does **not** issue a new signed-in session
when automatic entry fails. Do not promise that a recovery page signed them in.

## Sign-in returns and failed auto-join

When sign-in and automatic Discord entry succeed, the destination order is:
an explicit safe `?next=` on the sign-in link, then the safe destination
recorded when an unauthenticated visitor was bounced from a GET/HEAD page, then
the callback's default landing. Returns are same-site paths: a value must start
with one `/` and cannot be an absolute or protocol-relative URL, a backslash,
whitespace, a scheme, control characters, or an oversized value. The saved
destination values are signed and checked again when used. An admitted callback
consumes the saved return journey; a stray callback does not, so a later valid
callback can still use it. A missing or rejected value is ignored and the next
available option is considered.

If automatic Discord entry fails, the callback has a non-member session and
lands at `/?n=join_failed` instead of sending the person to a protected page
that would return 403 and hide the failed-auto-join explanation. That generic
403 still offers an invite link, but not the reason automatic entry failed.
When a safe return destination was recorded, it is kept as the intended
destination for a plain retry. If this followed an expired write, its recovery notice also stays
pending. A successful retry can return to the original safe page and show the
one-shot resubmit notice; the failed auto-join or its notice does not prove
membership. A bounced write goes to write recovery, never back into a resubmit.

## Expired-write recovery

When a guest or expired session tries to submit a write, the write is refused.
A JSON request stays a **401** and includes a safe `recovery` URL; it does not
silently redirect an API client through OAuth. A native form submission gets a
**303** to `/auth/recover?next=...`, where `next` is a safe GET destination —
a same-origin safe Referer when available, otherwise the route's GET fallback.
The write URL is never used as the return destination.

The recovery page says: **“Your earlier changes were not saved. Sign in again,
then review and submit them when you are ready.”** Follow **Log in with Discord**,
then return to the page and review the values before explicitly submitting
again. The earlier request body was not saved or replayed, and no write was
performed. Do not promise draft restoration; re-enter anything that is missing
and verify the form before resubmitting.

After sign-in and successful automatic entry, the callback returns to the safe
destination. The first eligible visible page shows a one-shot banner: **“You
signed in again. Your earlier changes were not saved. Review and submit them
again.”** The banner is a reminder, not a restored draft. If auto-join fails
first, sign-in can still succeed with a non-member session, but the browser
lands on `join_failed` while the recovery notice and safe retry destination
remain pending. A later successful retry can return to the original page and
display the banner.

## One-click join recovery pages

All of these offer **Try again** (a fresh `/join/discord` journey) and the
invite fallback. Do not reload, bookmark, share or replay `/join/callback`.

| Heading | Exact message | Meaning and next step |
|---|---|---|
| **Join cancelled** | "You cancelled the Discord approval, so we couldn't add you to the server. Try again, or use the invite link below." | Consent was declined. Nothing to reset; retry only if they want to approve, or use the invite. |
| **Join didn't complete** | "Discord didn't complete the approval. Try again, or use the invite link below." | Discord returned another approval error. Try once afresh; repeated or widespread failures go to engineering. |
| **Join link expired** | "That join link expired. Approvals last ten minutes — try again below." | Missing, mismatched or expired state/code; often a stale callback or lost journey cookie. Start again in the same browser and approve promptly. |
| **Discord is unreachable** | "We couldn't reach Discord to complete the join. Try again in a moment, or use the invite link below." | Token exchange or user lookup failed; this recovery page returns 503. It does not establish the root cause. Try once later or use the invite. |
| **Discord throttled the approval** | "Discord is rate-limiting approvals right now. Wait a moment, then try again below, or use the invite link." | Token exchange or user lookup was throttled (429); this recovery page returns 503 with `Retry-After` when Discord sent a usable backoff. Wait, then try once afresh or use the invite. |
| **We couldn't add you automatically** | "You're nearly there — use the invite link below to join the server directly." | The automatic add was refused or failed. Use the invite; do not keep replaying the approval. |
| **Discord throttled the automatic add** | "Discord is rate-limiting automatic adds right now. Wait a moment, then try again below, or use the invite link." | The automatic add was throttled (429); this recovery page returns 503 with `Retry-After` when Discord sent a usable backoff. Wait, then start a fresh journey or use the invite. |

An expired Discord authorization code can also produce **Discord is
unreachable**; Next does not expose a separate `invalid_grant` message.
A 200 response on another recovery page is not a successful join: it does
not mean joined and does not sign in.

Throttling looks different depending on where it happened:

**Slow down a little** is the website's own 429 page. A website 429 is local
admission: the join budget was exceeded before Discord was contacted. It
carries `Retry-After` from the website, records no join-attempt row, and
never implies a session.

A Discord automatic-add backoff renders the 503
**Discord throttled the automatic add** recovery and records the distinct
`rate_limited` attempt outcome. It carries the provider's `Retry-After`
when the provider sent a usable backoff.

A Discord 429 during token exchange renders the 503
**Discord throttled the approval** recovery and records an `error` attempt.
It carries `Retry-After` when the provider sent a usable backoff.

In all three cases, wait for `Retry-After` if present (otherwise at least a
minute), then start a fresh journey at `/join/discord` or use the invite
link below. Do not repeatedly click, refresh, replay `/join/callback`, or
try to evade the limit.

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
| `rate_limited` | Discord rate-limited the automatic add. The callback renders the 503 **Discord throttled the automatic add** recovery (with `Retry-After` when the provider sent a usable backoff). Wait, then start a fresh journey or use the invite. |

The table is not a complete sign-in history: `/auth/discord/callback` does not
write join-attempt rows, website-throttled (429 admission) requests do not reach
the recorder, and a missing join store can leave no row. A Discord
automatic-add backoff (`rate_limited`) is recorded; a local admission refusal
is not. The current live add-member call also
leaves Request ID empty; do not promise a trace ID or infer success from an
absent row. List and detail reads attribute the returned rows' recorded Discord
IDs directly, excluding the viewer, without requiring a current users row or
membership flag. Missing, invalid or partial member keys refuse the contents;
they are not silently omitted from attribution. Empty lists and self-only reads
create no access row. Audit-write failures always refuse protected contents;
no setting changes that. Any reported audit failure
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

## Source-to-guide checklist

- [x] **Notices:** [shared notice copy](../src/home-copy.ts) supplies all six exact
  values; [auth routes](../src/auth/routes.ts) distinguish generic failure,
  cancelled consent and provider unavailability. Mapped in
  [Homepage notices](#homepage-notices), including the warning that `?n=` is
  not proof of authentication or membership.
- [x] **Return precedence:** [return journey](../src/return-journey.ts) selects
  explicit `next`, then the gate-recorded intended page, then the caller's
  default; [auth routes](../src/auth/routes.ts) preserve the safe retry target
  after failed auto-join. Mapped in
  [Sign-in returns and failed auto-join](#sign-in-returns-and-failed-auto-join).
- [x] **Expired writes:** [write recovery](../src/write-recovery.tsx) defines
  JSON 401 versus native 303, safe GET destinations and the recovery copy;
  [auth routes](../src/auth/routes.ts) carry the notice through a failed
  auto-join retry. Mapped in
  [Expired-write recovery](#expired-write-recovery).

## Source references

This guide describes the implementation, not a live staging certification:

- [Join routes](../src/join/route.ts): journey cookies, ten-minute expiry,
  recovery wording, attempt recording and successful-session issuance.
- [Join service](../src/join/service.ts): outcomes, safe return validation,
  throttling and the direct Discord add-member call.
- [Homepage notice copy](../src/home-copy.ts): the six recognized notices.
- [Return journey](../src/return-journey.ts): signed explicit and intended
  destinations and their precedence.
- [Write recovery](../src/write-recovery.tsx): expired-write redirects,
  recovery copy and one-shot notice behavior.
- [Auth routes](../src/auth/routes.ts): `/auth/discord`, its callback, failed
  auto-join retry and logout; [app routes](../src/index.tsx): `/discord`;
  [page text](../src/pages.tsx): notices, join/recovery pages and FAQ.
- [Role lookup](../src/roles.ts) and [rate-limit response](../src/error-responses.tsx).
- [Admin routes](../src/admin/routes.tsx), [admin pages](../src/admin/pages.tsx),
  [table queries](../src/admin/table-list.ts), [admin reads](../src/admin/reads.ts)
  and [join-funnel widget](../src/admin/join-funnel.ts): read-only controls,
  retention window, pagination and cached aggregate diagnostics.
- [Admin guard](../src/admin/guard.ts), [sessions](../src/sessions.ts) and
  [access logging](../src/access-log.ts): session availability and audit enforcement.
