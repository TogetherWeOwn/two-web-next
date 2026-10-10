# Member erasure

`bin/erase-member.mjs` backs the published deletion promise
(`src/privacy-content.ts` "Deletion"): "Ask anytime to be removed … and we
delete your rows." A moderator who receives a removal request runs this
operator command; there is no self-serve path.

## Usage

```sh
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake>
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply
node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply --target production
```

- Dry-run is the default: it prints per-table row counts only, never row
  contents. `--apply` deletes.
- `DATABASE_URL` comes from the environment only — never argv, never logs.
  The output is one JSON line (`{"mode","counts"}`); the URL is never printed.
- A production-looking connection string is refused unless `--target
  production` is passed explicitly.
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

- `events.created_by` / featured `created_by` stay in place. They record
  authorship of moderator content, not member data; removing them would
  rewrite community history without removing anything about the member.
- `member_data_access_logs` is immutable with a 90-day prune
  (`drizzle/1018_audit-immutability.sql`, W13 `model:prune`). Past access
  records are compliance evidence and cannot be rewritten per request.
- `activity_log` is append-only and retained. No job prunes it today; although
  the database trigger permits deletion after 90 days, nothing currently does so.
  It records cutover and moderation evidence and is never edited per subject.
- The Discord-side mirror (roles, messages, tickets) is out of scope here:
  Discord is governed by Discord's own privacy policy, and removal there
  happens through Discord's moderation tools, not this command.

## Scope

No production run in the authoring card: a staging dry-run is the most it
may do. Tests run only against `agent-testdb` (or the CI Postgres service)
through `test/helpers/member-data-db.ts` fixtures with disposable schemas —
never staging or production data.
