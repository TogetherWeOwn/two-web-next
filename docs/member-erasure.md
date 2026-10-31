# Member erasure

`bin/erase-member.mjs` backs the published deletion promise
(`src/privacy-content.ts` "Deletion"): "Ask anytime to be removed … and we
delete your rows." A moderator who receives a removal request runs this
operator command; there is no self-serve path.

## Usage

```sh
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake>
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --target staging
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply --target production --confirm <host>
```

- Dry-run is the default: it prints per-table row counts only, never row
  contents. `--apply` deletes.
- `DATABASE_URL` comes from the environment only — never argv, never logs.
  The output is one JSON line with `ok: true`, `mode`, `counts`, `passes`
  and `deletesPerPass`; the URL is never printed. `counts` keeps one key per table; `passes` is the
  number of session-chase passes executed and `deletesPerPass` the session
  rows each pass deleted, in order. A dry-run reports `passes: 0` with an
  empty list because no chase ran.
- Any host outside `agent-testdb` and loopback (`localhost`, `127.0.0.1`,
  `::1`) needs `--target staging` or `--target production`. A
  production-looking URL needs `--target production`, and `--target staging`
  on it is refused. The target is an operator assertion: the tool cannot
  verify which environment a host belongs to.
- `--apply` against a remote host also needs `--confirm <host>`, typed
  exactly as the `DATABASE_URL` host (no trimming, no case folding). A missing
  or different value is refused with `E_CONFIRM` before any connection opens.
  A remote dry-run (the default) never refuses: it prints `targetHost` and,
  without the flag, a `confirmHint`, so an agent can read the host, then
  re-run the apply with `--confirm <host>`. Local hosts ignore the flag. It is
  a non-interactive check (no prompt), so it narrows the existing destructive
  path without adding any authority.
- A remote connection must verify the server certificate. The URL needs
  `sslmode=verify-full` or `sslrootcert=system` (an alias for verify-full).
  `require`, `verify-ca`, `disable`, and other query parameters are refused.
  The driver receives only the parsed endpoint fields. Both destructive
  operator CLIs (`erase-member` and `revoke-sessions`) enforce this same
  floor through one shared core, `bin/operator-db-core.mjs`: the override
  refusal, the verify-full requirement, and the throwing client are
  identical in both.
- A loopback URL without `sslmode` connects without TLS, as
  `revoke-sessions` does. Add `sslmode=require` when the local server enforces
  TLS.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused for every host.
- Every refusal happens before a connection opens. Refusal messages are
  fixed strings: the URL, the password, and the Discord id never appear in
  output.
- The Discord id is validated before any connection is opened. A malformed id
  exits 2 without touching the database.

Exit codes: 0 success, 2 usage/config/refusal (including a malformed id),
1 driver/transaction failure (changes rolled back if a transaction started).

## Machine-readable errors (both member-data CLIs)

`erase-member` and `revoke-sessions` emit exactly one failure JSON line to
stderr: `{ "ok": false, "code": "E_TARGET", "message": "…", "next": "…" }`.
No stdout accompanies a failure. Messages and next actions are fixed strings;
argv, endpoint details, Discord ids and driver/row contents are never echoed.
Success remains one stdout JSON line with the existing count/chase fields and
additive `ok: true` (`stampsPerPass` replaces `deletesPerPass` for revocation).
`--help` exits 0 without configuration and prints usage plus this shared table.

The table is defined once in `bin/operator-cli-errors.mjs`, rendered by both
help commands and checked here by `test/operator-cli-error-table.test.mjs`.

| Code | Exit | Message | Next action |
| --- | --- | --- | --- |
| E_MODE_CONFLICT | 2 | --apply and --dry-run conflict; they cannot be used together. | Choose one mode: --dry-run (the default) or --apply. |
| E_TARGET | 2 | --target must be staging or production. | Set --target staging or --target production for the intended environment. |
| E_DUPLICATE_FLAG | 2 | A flag or Discord id was repeated. | Supply each flag and the Discord id only once. |
| E_UNKNOWN_FLAG | 2 | Unknown or unsupported flag. | Remove the unknown flag; use --help for supported options. |
| E_URL_ARG | 2 | Connection URLs are not accepted as arguments. | Supply DATABASE_URL through the environment only, never argv. |
| E_DISCORD_ID | 2 | Missing or malformed Discord id. | Supply --discord-id=<snowflake> using a nonzero, unpadded decimal Discord id. |
| E_DATABASE_URL | 2 | Refusing: DATABASE_URL is missing or invalid. | Check DATABASE_URL in the environment without logging its value. |
| E_TLS_OVERRIDE | 2 | Refusing: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification. | Remove NODE_TLS_REJECT_UNAUTHORIZED=0 from the environment. |
| E_PRODUCTION_TARGET | 2 | Refusing: production database without --target production. | Verify the intended environment before selecting --target production. |
| E_REMOTE_TARGET | 2 | Refusing: remote database needs --target staging or --target production. | Verify the intended environment and supply its --target explicitly. |
| E_TLS_REQUIRED | 2 | Refusing: remote database must use sslmode=verify-full or sslrootcert=system. | Configure verified TLS in the environment URL; do not disable verification. |
| E_CONFIRM | 2 | Refusing: --apply with --target staging or --target production requires --confirm <host>. | Re-run with --confirm <host> where <host> exactly matches the DATABASE_URL host; a dry-run shows the requirement. |
| LOCK_TIMEOUT | 1 | operation failed; changes rolled back (lock timeout 55P03). | Retry once the lock clears; verify with a dry-run first. |
| TX_FAILED | 1 | operation failed; transaction rolled back if it started. | Check connectivity and migrations without logging DATABASE_URL; re-run the dry-run. |

## Bounded waits

Like `revoke-sessions`, the command sets its own session
`statement_timeout` (10s) and `lock_timeout` (5s) on its single connection
only; global database policy is unchanged. If a member row or table is
locked, the run fails bounded with exit 1 and the redacted "operation
failed; changes rolled back" message; the transaction rolls back, so a
timed-out run erases nothing and all member tables stay unchanged. A lock
timeout (SQLSTATE 55P03) carries a distinct retry hint instead of the
generic failure text. Verify with a dry-run to read the per-table counts,
then retry (re-run) the apply once the lock clears. If timeouts repeat, escalate to the DevOps &
Reliability Engineer with the redacted error and the dry-run counts; do
not retry in a loop and do not erase by another path.

For the separate case where a moderator has lost their Discord role but their
member account should remain, use the [moderator session-revocation procedure](moderator-admin-guide.md#a-moderator-lost-their-role). It explains the session expiry window and how to end active sessions without erasing member data.

## What is deleted

For ONE Discord id, in one transaction:

| Table | Column |
| --- | --- |
| `users` | `id` (PK = Discord id) |
| `profiles` | `user_id` |
| `rsvps` | `user_id` |
| `web_sessions` | `user_id` (this signs the member out everywhere) |
| `web_session_grace` | `user_id` (retired predecessor identity and bearer hashes) |
| `join_attempts` | `discord_id` |

The output counts carry one key per table: `web_sessions` counts live
session rows and `web_session_grace` counts retired predecessor records, so a
rotated member shows 1 under each key. Dry-run includes those same rows. The
disposable-Postgres proofs in `test/session-predecessor-grace-postgres.test.ts`
and `test/session-predecessor-grace-erasure.test.ts` check dry-run, deletion,
repeat apply and preservation of another member's live session and grace.

A second apply is a no-op: every count returns 0.

### Freed seats

Deleting a `going` RSVP frees a seat. In the same transaction, apply hands
each freed seat to the event's waitlist head, exactly as a member's own
withdrawal does (`promoteWaitlist` in `src/events/waitlist.ts`). It first
locks the member's events in id order, the same order the RSVP verbs use.
The `rsvps` trigger advances each affected event's `sync_revision`, so the
reconcile cron re-syncs Discord for published and cancelled events. The CLI
has no Worker queue, so it does not enqueue the sync itself. Nor can it retire
the Worker's isolate-local guest caches (`src/events/anon-cache.ts`), so a
guest page can show the old going count until its entry expires: up to 60 s
on `/events` and 300 s on `/events/past`. Dry-run writes nothing and promotes
no one.

### Provisional: profile rows (not yet enforced)

These rows land with the profiles changes: per-field visibility, handles
and linked accounts (Steam first) with the schema change, and profile
reports with the moderation change. Until each change merges,
`eraseMember` does not delete them — today there is nothing to delete,
because the tables, the new `profiles` columns and the banner store do not
exist yet.

| Table or store | Key | End of life |
| --- | --- | --- |
| `linked_accounts` | `user_id` | Unlink deletes the member's rows immediately; erasure deletes them in the same transaction. |
| `profiles` new columns (handle, visibility map, index opt-in, accent, banner key, links, featured games) | `user_id` | Ride the existing `profiles` row delete; no new key. |
| Banner image object (R2) | `profiles.banner_key` | Deleted with erasure. |
| `profile_reports` (planned) | subject and reporter member ids | 90-day rows; erasure deletes reports about the member and reports they filed. |

Field hides are written to `activity_log` and stay under its existing rule
(append-only moderation evidence, retained indefinitely, never edited per
subject).

## Concurrent rotations

A rotation that is already in flight when erasure reaches its session
removal cannot smuggle its successor past the erase. The session removal
repeats its DELETE with a fresh snapshot until one pass finds no session
row left for the member, and the reported `web_sessions` count is the
rows the erase itself physically deleted, accumulated across passes. The
result also reports `passes` (how many chase passes ran) and
`deletesPerPass` (session rows deleted per pass, in order), so a rotated
member's chase is visible forensically without changing the uncapped
chase itself. A rotation that starts after erasure has removed its
source fails on the missing row without minting a successor.

Boundary: this converges over rotations of sessions that existed when
erasure ran. It is not a tombstone and not a sign-in ban: a genuinely
new session created after erasure authenticates normally, and a sign-in
racing the final pass can land after it. Retained-table policy is
unchanged, and nothing here authorizes running erasure outside the
Scope below.

## What is retained and why

- `events.created_by` / `featured_contents.created_by` stay in place. Each
  holds the author's Discord ID, which is identifying data, retained as the
  authorship mark on moderator content; removing it would rewrite community
  history. The mark is not rewritten per erasure request and has no separate
  TTL: it lasts as long as its content row does (deleting a featured row
  takes its mark with it; this command never deletes event rows). This
  affects only authors with a populated field, not every erased member.
- `member_data_access_logs` is immutable with a 90-day prune
  (`drizzle/1018_audit-immutability.sql`, W13 `model:prune`). Past access
  records are compliance evidence and cannot be rewritten per request.
- `activity_log` is append-only and retained indefinitely per CISO decision
  (retain). No job prunes it; although the database trigger permits deletion
  after 90 days, nothing does so — that exception stays an unused safety valve.
  It records cutover and moderation evidence and is never edited per subject.
  Revisit only through the whole-schema retention ledger.
- `agent_event_*` (`agent_event_grants`, `agent_event_idempotency_keys`,
  `agent_event_audits`, `agent_event_hits`) are machine tables, not member
  rows. They are keyed by machine credential grant (`agent_id`, grant id),
  never by Discord id or user id, so erasing one member leaves them untouched:
  there is nothing member-keyed in them to delete. Their own cleanups still
  apply: audit and replay-key rows age out at 90 days through the daily
  `model:prune` (`AGENT_EVENT_AUDIT_RETENTION_DAYS`,
  `IDEMPOTENCY_KEY_RETENTION_DAYS` in `src/jobs/constants.ts`, wired in
  `src/jobs/cron.ts`); rate-counter rows (`agent_event_hits`) are pruned
  lazily after five minutes, like the throttle buckets below
  (`src/agent-events/rate-limit.ts`, `src/agent-events/shield.ts`); grants
  last until they expire or are disabled, with no age-based deletion. The
  published [retention ledger](retention-ledger.md) has no row for these
  tables yet, so the windows above are cited from the code, not the ledger.
- `event_search_logs` holds aggregate search counts only: one row per search
  with the normalized query text and how many results it returned — no user
  id, session, or IP by design (`src/db/admin-schema.ts`). Erasure leaves it
  because no row belongs to a member. Rows older than 90 days are deleted by
  the daily `model:prune` (`EVENT_SEARCH_LOG_RETENTION_DAYS = 90`), as
  published in the [retention ledger](retention-ledger.md).
- `board_view_logs` holds aggregate board-view counts only: board key, scope,
  season, and result count — no user id, Discord id, session, IP, or username
  by design (`src/db/admin-schema.ts`). Erasure leaves it for the same reason.
  Rows older than 90 days are deleted by the daily `model:prune`
  (`BOARD_VIEW_LOG_RETENTION_DAYS = 90`), as published in the
  [retention ledger](retention-ledger.md).
- `web_oauth_journeys` holds short-lived login handshake rows keyed by a
  random state hash (`state_hash`, flow, expiry) — no member columns, so
  erasure has nothing to delete. Each handshake expires after ten minutes
  (`OAUTH_JOURNEY_TTL_SECONDS = 600` in `src/oauth-journeys.ts`) and expired
  rows are swept when the next login starts (`sweepExpired`, called from
  `src/auth/routes.ts` and `src/join/route-start.ts`), as published in the
  [retention ledger](retention-ledger.md).
- The Discord-side mirror (roles, messages, tickets) is out of scope here:
  Discord is governed by Discord's own privacy policy, and removal there
  happens through Discord's moderation tools, not this command.

## Throttle buckets (ephemeral, self-deleting)

`web_throttle_hits.bucket` embeds a Discord id in two write budgets:
`rsvp-write:<discord id>` (`src/events/rsvp.ts`) and
`profile-write:<discord id>` (`src/profiles/routes-admission.ts`). These rows are not
deleted by `eraseMember`. Five minutes is an age cutoff, not a physical
deletion deadline: an expired row survives until a later cleanup deletes it,
so a quiet site can hold expired rows past the five-minute mark — there is no
exact-five-minute deletion guarantee. Cleanup is lazy and path-dependent: the
rsvp path prunes expired rows before judging the budget (`pruneThrottle` in
`src/events/rsvp.ts`), so a request refused on budget or a closed event has
already run the shared prune (an unknown-event id exits before the prune);
the join admission path (`checkJoinThrottle`
in `src/join/service.ts`, shared by the profile path) judges and records
first, then prunes expired rows after every verdict, admitted or refused
(a throttle-admitted profile write still prunes before the owner check can
refuse it). Both prunes are bounded by
`THROTTLE_COUNTER_RETENTION_MINUTES = 5`. `test/member-erasure-coverage.test.ts`
pins this: it fails on any new member-keyed column or `*-write:${...}` bucket
that is neither erased above nor documented here with its own deletion proof.
`test/privacy-deletion-exceptions.test.ts` pins the public Deletion wording:
creator marks and residual Discord-keyed counters are named without promising
immediate erasure of either.

## Scope

No production run in the authoring card: a staging dry-run is the most it
may do. Tests run only against `agent-testdb` (or the CI Postgres service)
through `test/helpers/member-data-db.ts` fixtures with disposable schemas —
never staging or production data.
