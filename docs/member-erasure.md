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
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply --target production
```

- Dry-run is the default: it prints per-table row counts only, never row
  contents. `--apply` deletes.
- `DATABASE_URL` comes from the environment only — never argv, never logs.
  The output is one JSON line (`{"mode","counts"}`); the URL is never printed.
- Any host outside `agent-testdb` and loopback (`localhost`, `127.0.0.1`,
  `::1`) needs `--target staging` or `--target production`. A
  production-looking URL needs `--target production`, and `--target staging`
  on it is refused. The target is an operator assertion: the tool cannot
  verify which environment a host belongs to.
- A remote connection must verify the server certificate. The URL needs
  `sslmode=verify-full` or `sslrootcert=system` (an alias for verify-full).
  `require`, `verify-ca`, `disable`, and other query parameters are refused.
  The driver receives only the parsed endpoint fields.
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
1 driver/transaction failure (changes rolled back).

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
| `join_attempts` | `discord_id` |

A second apply is a no-op: every count returns 0.

## What is retained and why

- `events.created_by` / `featured_contents.created_by` stay in place. They
  record authorship of moderator content, not member data; removing them
  would rewrite community history without removing anything about the member.
- `member_data_access_logs` is immutable with a 90-day prune
  (`drizzle/1018_audit-immutability.sql`, W13 `model:prune`). Past access
  records are compliance evidence and cannot be rewritten per request.
- `activity_log` is append-only and retained indefinitely per CISO decision
  (retain). No job prunes it; although the database trigger permits deletion
  after 90 days, nothing does so — that exception stays an unused safety valve.
  It records cutover and moderation evidence and is never edited per subject.
  Revisit only through the whole-schema retention ledger.
- The Discord-side mirror (roles, messages, tickets) is out of scope here:
  Discord is governed by Discord's own privacy policy, and removal there
  happens through Discord's moderation tools, not this command.

## Throttle buckets (ephemeral, self-deleting)

`web_throttle_hits.bucket` embeds a Discord id in two write budgets:
`rsvp-write:<discord id>` (`src/events/rsvp.ts`) and
`profile-write:<discord id>` (`src/profiles/routes-admission.ts`). These rows are not
deleted by `eraseMember`: the rsvp path prunes counters older than five
minutes before judging the budget (`pruneThrottle` in `src/events/rsvp.ts`);
the join admission path (`checkJoinThrottle` in `src/join/service.ts`, shared
by the profile path) judges and records first, then prunes expired rows for
admitted requests. Both prunes are bounded by
`THROTTLE_COUNTER_RETENTION_MINUTES = 5`, so a member's buckets age out on the
next counted request anywhere on the site. `test/member-erasure-coverage.test.ts`
pins this: it fails on any new member-keyed column or `*-write:${...}` bucket
that is neither erased above nor documented here with its own deletion proof.

## Scope

No production run in the authoring card: a staging dry-run is the most it
may do. Tests run only against `agent-testdb` (or the CI Postgres service)
through `test/helpers/member-data-db.ts` fixtures with disposable schemas —
never staging or production data.
