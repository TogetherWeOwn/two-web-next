// User-roster write (N6: TOG-9898). Ports two-web's
// DiscordLoginController/JoinController `updateOrCreate` on the Discord id:
// sign-in and join refresh username/avatar/member on every login. The
// moderator flag is NEVER part of this write — `users` has no moderator
// column by design, and the flag is recomputed from Discord role IDs at login
// into the session row (src/roles.ts). W7 profile reads and W11 admin reads
// depend on this table.

import type { Sql } from "../sessions";

/** The only columns the roster write may carry. No moderator field exists here on purpose. */
export type RosterUpsert = {
  id: string;
  username: string;
  avatar: string | null;
  member: boolean;
};

const ROSTER_MIGRATION = [
  `create table if not exists users (
    id text primary key,
    username text not null,
    avatar text,
    member boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
];

// Fixture helper only (TOG-19721): the same shape as
// drizzle/0000_init-users.sql, kept identical so disposable test schemas
// match migrated databases. Sign-in must NOT call migrateRoster(): the
// runtime role holds read/write only, no schema CREATE.
export async function migrateRoster(sql: Sql): Promise<void> {
  for (const stmt of ROSTER_MIGRATION) await sql.unsafe(stmt);
}

/**
 * Insert-or-refresh the roster row for a Discord user. Repeat logins update
 * the row in place — never a duplicate. A null store is a no-op (sign-in
 * stays up when there is no database, like recordAttempt); any other failure
 * throws so the caller can warn-and-continue without blocking sign-in.
 */
export async function upsertRosterUser(sql: Sql | null, user: RosterUpsert): Promise<void> {
  if (!sql) return;
  await sql`INSERT INTO users (id, username, avatar, member, updated_at)
    VALUES (${user.id}, ${user.username}, ${user.avatar}, ${user.member}, now())
    ON CONFLICT (id) DO UPDATE SET
      username = excluded.username, avatar = excluded.avatar,
      member = excluded.member, updated_at = now()`;
}
