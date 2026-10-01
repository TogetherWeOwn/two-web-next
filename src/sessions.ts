// DB-backed sessions over Postgres via Hyperdrive in production.
// Local/dev: DATABASE_URL (agent-testdb). Production: a Hyperdrive binding
// plumbed through the same Sql contract (W1/S1 own the binding shape).
//
// Table contract (kept in raw SQL until W3's Drizzle scaffold merges, then
// re-expressed as a Drizzle table on the same `web_sessions` name):
//   web_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
//     username TEXT NOT NULL, avatar TEXT, member BOOLEAN NOT NULL,
//     moderator BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL,
//     expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ)
// The cookie carries a random token (`two_` + 32 bytes, base64url); the DB
// stores only its SHA-256 hex. Nothing session-shaped lives in KV.

import {
  createMemoryOAuthJourneyStore,
  createPostgresOAuthJourneyStore,
  migrateOAuthJourneys,
  type OAuthJourneyStore,
} from "./oauth-journeys";

export type DbSessionRow = {
  userId: string;
  username: string;
  avatar: string | null;
  member: boolean;
  moderator: boolean;
};

export type SessionStore = {
  journeys: OAuthJourneyStore;
  create: (session: DbSessionRow & { tokenHash: string; expiresAt: Date }) => Promise<void>;
  /** Fresh authentication: revoke the supplied prior token and insert atomically. */
  replace: (oldTokenHash: string, replacement: DbSessionRow & { tokenHash: string; expiresAt: Date }) => Promise<void>;
  get: (tokenHash: string) => Promise<DbSessionRow | null>;
  /** Rotation: delete the old row and insert the replacement atomically. */
  rotate: (
    oldTokenHash: string,
    replacement: DbSessionRow & { tokenHash: string; expiresAt: Date },
  ) => Promise<boolean>;
  revoke: (tokenHash: string) => Promise<void>;
  /** Expiry GC (W13 model:prune): delete rows reads can no longer see. Returns rows removed. */
  sweepExpired: (now: Date) => Promise<number>;
};

/**
 * `postgres`/`Hyperdrive` client surface the store needs: one tagged-template
 * call plus `unsafe` for the static migration DDL (postgres.js rejects
 * dynamically-built template calls, so DDL goes through `unsafe` with no
 * interpolated values).
 */
export type Sql = (<T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>) & { unsafe: (query: string) => Promise<unknown> };

const MIGRATION = [
  `create table if not exists web_sessions (
    token_hash text primary key,
    user_id text not null,
    username text not null,
    avatar text,
    member boolean not null,
    moderator boolean not null default false,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
  )`,
  `create index if not exists web_sessions_user_id_idx on web_sessions (user_id)`,
  `create index if not exists web_sessions_expires_at_idx on web_sessions (expires_at)`,
];

export async function migrate(sql: Sql): Promise<void> {
  for (const stmt of MIGRATION) await sql.unsafe(stmt);
  await migrateOAuthJourneys(sql);
}

function toRow(r: Record<string, unknown>): DbSessionRow {
  return {
    userId: String(r.user_id),
    username: String(r.username),
    avatar: r.avatar == null ? null : String(r.avatar),
    member: r.member === true,
    moderator: r.moderator === true,
  };
}

export function createPostgresSessionStore(sql: Sql): SessionStore {
  return {
    journeys: createPostgresOAuthJourneyStore(sql),
    async replace(oldTokenHash, replacement) {
      if (oldTokenHash === replacement.tokenHash) throw new Error("Session replacement must use a fresh token");
      // Both writes are one statement. An insert failure rolls back revocation;
      // unlike rotation, an unknown prior cookie does not veto fresh login.
      await sql`with revoked as (
          update web_sessions set revoked_at = now()
          where token_hash = ${oldTokenHash} and revoked_at is null returning 1
        )
        insert into web_sessions (token_hash, user_id, username, avatar, member, moderator, expires_at)
        values (${replacement.tokenHash}, ${replacement.userId}, ${replacement.username},
          ${replacement.avatar}, ${replacement.member}, ${replacement.moderator}, ${replacement.expiresAt})`;
    },
    async create(s) {
      await sql`
        insert into web_sessions (token_hash, user_id, username, avatar, member, moderator, expires_at)
        values (${s.tokenHash}, ${s.userId}, ${s.username}, ${s.avatar}, ${s.member}, ${s.moderator}, ${s.expiresAt})
        on conflict (token_hash) do update set
          user_id = excluded.user_id, username = excluded.username, avatar = excluded.avatar,
          member = excluded.member, moderator = excluded.moderator,
          expires_at = excluded.expires_at, revoked_at = null`;
    },
    async get(tokenHash) {
      const rows = await sql<Record<string, unknown>[]>`select user_id, username, avatar, member, moderator
        from web_sessions
        where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()`;
      const row = rows[0];
      return row ? toRow(row) : null;
    },
    async rotate(oldTokenHash, replacement) {
      // No-op rotation deletes nothing and inserts nothing: rotating an unknown
      // or already-rotated token must not mint an orphan row.
      if (oldTokenHash === replacement.tokenHash) {
        const rows = await sql<Record<string, unknown>[]>`select count(*)::int as n
          from web_sessions where token_hash = ${oldTokenHash}`;
        return Number(rows[0]?.n ?? 0) > 0;
      }
      const rows = await sql<Record<string, unknown>[]>`with deleted as (
          delete from web_sessions where token_hash = ${oldTokenHash} returning 1
        )
        insert into web_sessions (token_hash, user_id, username, avatar, member, moderator, expires_at)
        select ${replacement.tokenHash}, ${replacement.userId}, ${replacement.username},
          ${replacement.avatar}, ${replacement.member}, ${replacement.moderator}, ${replacement.expiresAt}
        where exists (select 1 from deleted)
        on conflict (token_hash) do update set
          user_id = excluded.user_id, username = excluded.username, avatar = excluded.avatar,
          member = excluded.member, moderator = excluded.moderator,
          expires_at = excluded.expires_at, revoked_at = null
        returning (select count(*)::int from deleted) as rotated`;
      return Number(rows[0]?.rotated ?? 0) > 0;
    },
    async revoke(tokenHash) {
      await sql`update web_sessions set revoked_at = now()
        where token_hash = ${tokenHash} and revoked_at is null`;
    },
    async sweepExpired(now) {
      // `<=`: reads require expires_at > now(), so a row expiring exactly at
      // `now` is already invisible. Idempotent: a second pass matches nothing.
      const rows = await sql<Record<string, unknown>[]>`delete from web_sessions
        where expires_at <= ${now} returning 1`;
      return rows.length;
    },
  };
}

/** Test/memory helper. Same contract, no I/O. */
export function createMemorySessionStore(clock: () => number = Date.now): SessionStore {
  const rows = new Map<string, DbSessionRow & { expiresAt: number }>();
  const live = (hash: string) => {
    const r = rows.get(hash);
    if (!r || r.expiresAt <= clock()) {
      rows.delete(hash);
      return null;
    }
    return r;
  };
  return {
    journeys: createMemoryOAuthJourneyStore(clock),
    async replace(oldHash, replacement) {
      if (oldHash === replacement.tokenHash || rows.has(replacement.tokenHash)) {
        throw new Error("Session replacement must use a fresh token");
      }
      rows.delete(oldHash);
      rows.set(replacement.tokenHash, { ...replacement, expiresAt: replacement.expiresAt.getTime() });
    },
    async create(s) {
      rows.set(s.tokenHash, { ...s, expiresAt: s.expiresAt.getTime() });
    },
    async get(hash) {
      const r = live(hash);
      return r ? { userId: r.userId, username: r.username, avatar: r.avatar, member: r.member, moderator: r.moderator } : null;
    },
    async rotate(oldHash, replacement) {
      if (!live(oldHash)) return false;
      rows.delete(oldHash);
      rows.set(replacement.tokenHash, { ...replacement, expiresAt: replacement.expiresAt.getTime() });
      return true;
    },
    async revoke(hash) {
      rows.delete(hash);
    },
    async sweepExpired(now) {
      const t = now.getTime();
      let n = 0;
      for (const [k, r] of rows) {
        if (r.expiresAt <= t) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}

/** SHA-256 hex of a session token. Tokens are compared by hash only. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `two_` + 32 random bytes, base64url. ~256 bits: unguessable, URL/cookie-safe. */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `two_${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
