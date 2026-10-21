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

const ROSTER_WAIT_MS = 2_000;
const ROSTER_STATEMENT_MS = 500;
const ROSTER_LOCK_MS = 400;
const ROSTER_CLEANUP_MARGIN_MS = 250;

/**
 * Refresh before session issuance when healthy; throw on optional failure so
 * the caller can warn and continue. The application bound includes acquiring
 * a connection. Local SQL limits cancel actual work, not just the JS wait,
 * and restore even nonzero pooled settings on commit or rollback.
 */
export async function upsertRosterUser(sql: Sql | null, user: RosterUpsert): Promise<void> {
  if (!sql) return;
  const store = sql as Sql & {
    begin?: (run: (tx: Sql) => Promise<void>) => Promise<void>;
  };
  const deadlineAt = Date.now() + ROSTER_WAIT_MS;
  let expired = false;
  const check = () => {
    if (expired || Date.now() >= deadlineAt) throw new Error("Roster write deadline elapsed");
  };
  const insert = async (tx: Sql) => {
    check();
    await tx`INSERT INTO users (id, username, avatar, member, updated_at)
      VALUES (${user.id}, ${user.username}, ${user.avatar}, ${user.member}, now())
      ON CONFLICT (id) DO UPDATE SET
        username = excluded.username, avatar = excluded.avatar,
        member = excluded.member, updated_at = now()`;
    check();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("Roster write deadline elapsed"));
    }, ROSTER_WAIT_MS);
  });
  const write = (async () => {
    if (store.begin) {
      await store.begin(async (tx) => {
        // A queued BEGIN may acquire its connection after the caller left.
        // Refuse it before setting timeouts or issuing a stale roster write.
        check();
        const remaining = deadlineAt - Date.now() - ROSTER_CLEANUP_MARGIN_MS;
        if (remaining <= 1) throw new Error("Roster write deadline elapsed");
        const statement = Math.min(ROSTER_STATEMENT_MS, remaining);
        const lock = Math.min(ROSTER_LOCK_MS, statement - 1);
        await tx.unsafe(`SET LOCAL statement_timeout = '${statement}ms'`);
        check();
        await tx.unsafe(`SET LOCAL lock_timeout = '${lock}ms'`);
        // Do not start a write whose installed limit no longer fits the budget.
        if (statement > deadlineAt - Date.now() - ROSTER_CLEANUP_MARGIN_MS)
          throw new Error("Roster write deadline elapsed");
        await insert(tx);
      });
    } else {
      // Minimal injected Sql fixtures have no transactions. Native clients do.
      await insert(sql);
    }
  })();
  try {
    // Both outcomes remain observed even if transport/acquisition settles late.
    await Promise.race([write, deadline]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
