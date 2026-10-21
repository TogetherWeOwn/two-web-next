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

import { withPerRequestStatementBound } from "./db/connection";
import {
  createMemoryOAuthJourneyStore,
  createPostgresOAuthJourneyStore,
  migrateOAuthJourneys,
  type OAuthJourneyStore,
} from "./oauth-journeys";

/** Session lifetime: 120-minute sliding window (legacy parity, `docs/parity.md`).
 * Login, authenticated-page rotation and member/admin GET renewal re-stamp the
 * DB expiry and cookie Max-Age; the status probe cookie follows the same value. */
export const SESSION_TTL_SECONDS = 60 * 120;

/** Immediate-predecessor grace: 10s from winning rotation, bounded also by the
 * predecessor's original expiry. Exact deadline is guest. Lets two overlapping
 * tab requests both authenticate; logout and revoke kill it inside the window. */
export const SESSION_PREDECESSOR_GRACE_SECONDS = 10;

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
  replace: (
    oldTokenHash: string,
    replacement: DbSessionRow & { tokenHash: string; expiresAt: Date },
  ) => Promise<void>;
  get: (tokenHash: string) => Promise<DbSessionRow | null>;
  /** Extend a live row without rotating its bearer or changing identity/roles. */
  renew: (tokenHash: string, expiresAt: Date) => Promise<boolean>;
  /** Non-authenticating probe key, stable across rotation of a live session. */
  statusHash: (tokenHash: string) => Promise<string | null>;
  isActive: (statusHash: string) => Promise<boolean>;
  /** Rotation: atomically replace an unrevoked, unexpired source; otherwise return false. */
  rotate: (
    oldTokenHash: string,
    replacement: DbSessionRow & { tokenHash: string; expiresAt: Date },
  ) => Promise<boolean>;
  revoke: (tokenHash: string) => Promise<void>;
  /** Revoke every live token that shares a stable status/lineage hash. */
  revokeLineage: (statusHash: string) => Promise<void>;
  /** Fresh login (TOG-12284): revoke every live session for this user except
   * the freshly issued token, so a pre-login/pre-join token — and any older
   * concurrent login — cannot survive sign-in. Hash-only, like revoke. */
  revokeUserSessions: (userId: string, exceptTokenHash: string) => Promise<void>;
  /** Expiry GC: delete rows reads can no longer see. Returns rows removed.
   * The general store drains all eligible rows in one call. The scheduled
   * `model:prune` pass uses its own bounded adapter (`pgPruneStores` in
   * `src/jobs/postgres.ts`, drained via `drainPruneTable` in
   * `src/jobs/cron.ts`), so scheduler holds stay capped. */
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

// Fixture/backfill helper only (TOG-19721): the canonical DDL for these
// shapes lives in drizzle/1022_web-sessions-oauth-journeys.sql and
// drizzle/1030_session-predecessor-grace.sql and is applied by the migrate
// workflow. The request path must NOT call migrate(): the runtime role holds
// read/write only, no schema CREATE. Tests use this to build disposable
// schemas; its statements stay identical to the migrations.
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
  // Additive rollout: existing login cookies acquire a probe on their next page.
  `alter table web_sessions add column if not exists status_hash text`,
  `update web_sessions set status_hash = token_hash where status_hash is null`,
  `create index if not exists web_sessions_status_hash_idx on web_sessions (status_hash)`,
  `create index if not exists web_sessions_user_id_idx on web_sessions (user_id)`,
  `create index if not exists web_sessions_expires_at_idx on web_sessions (expires_at)`,
  `create table if not exists web_session_grace (
    predecessor_hash text primary key,
    successor_hash text not null,
    status_hash text not null,
    user_id text not null,
    username text not null,
    avatar text,
    member boolean not null,
    moderator boolean not null default false,
    expires_at timestamptz not null,
    grace_expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists web_session_grace_successor_hash_idx on web_session_grace (successor_hash)`,
  `create index if not exists web_session_grace_status_hash_idx on web_session_grace (status_hash)`,
  `create index if not exists web_session_grace_user_id_idx on web_session_grace (user_id)`,
  `create index if not exists web_session_grace_grace_expires_at_idx on web_session_grace (grace_expires_at)`,
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

export function createPostgresSessionStore(client: Sql): SessionStore {
  // Per-request statement bound (SET LOCAL in a short transaction per
  // statement): a stuck session lookup cancels into the existing outage
  // handling instead of wedging the request. Journeys share the adapter, so
  // the OAuth consume path is bounded the same way.
  const sql = withPerRequestStatementBound(client);
  return {
    journeys: createPostgresOAuthJourneyStore(sql),
    async replace(oldTokenHash, replacement) {
      if (oldTokenHash === replacement.tokenHash)
        throw new Error("Session replacement must use a fresh token");
      // Both writes are one statement. An insert failure rolls back revocation;
      // unlike rotation, an unknown prior cookie does not veto fresh login.
      // Fresh login mints a new lineage: drop any grace the prior token carried
      // as predecessor or successor so a shared-terminal prior cannot linger.
      await sql`with revoked as (
          update web_sessions set revoked_at = now()
          where token_hash = ${oldTokenHash} and revoked_at is null returning 1
        ), pruned as (
          delete from web_session_grace
          where predecessor_hash = ${oldTokenHash} or successor_hash = ${oldTokenHash}
          returning 1
        )
        insert into web_sessions (token_hash, user_id, username, avatar, member, moderator, expires_at)
        values (${replacement.tokenHash}, ${replacement.userId}, ${replacement.username},
          ${replacement.avatar}, ${replacement.member}, ${replacement.moderator}, ${replacement.expiresAt})`;
    },
    async create(s) {
      // A reused hash stops being a grace predecessor once it is live again:
      // live reads win, so drop the shadowed grace row in the same statement.
      await sql`with pruned as (
          delete from web_session_grace where predecessor_hash = ${s.tokenHash} returning 1
        )
        insert into web_sessions (token_hash, status_hash, user_id, username, avatar, member, moderator, expires_at)
        values (${s.tokenHash}, ${s.tokenHash}, ${s.userId}, ${s.username}, ${s.avatar}, ${s.member}, ${s.moderator}, ${s.expiresAt})
        on conflict (token_hash) do update set
          status_hash = excluded.status_hash,
          user_id = excluded.user_id, username = excluded.username, avatar = excluded.avatar,
          member = excluded.member, moderator = excluded.moderator,
          expires_at = excluded.expires_at, revoked_at = null`;
    },
    async get(tokenHash) {
      const rows = await sql<
        Record<string, unknown>[]
      >`select user_id, username, avatar, member, moderator
        from web_sessions
        where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()`;
      const row = rows[0];
      if (row) return toRow(row);
      // Immediate-predecessor grace: same member and lineage, only while the
      // successor is live, unexpired and unrevoked. Fixed 10s deadline from the
      // winning rotation plus the predecessor's own expiry; exact deadline is
      // guest (`>` throughout). No status-key fallback and no history walk.
      const grace = await sql<
        Record<string, unknown>[]
      >`select g.user_id, g.username, g.avatar, g.member, g.moderator
        from web_session_grace g
        where g.predecessor_hash = ${tokenHash}
          and g.grace_expires_at > clock_timestamp()
          and g.expires_at > clock_timestamp()
          and exists (
            select 1 from web_sessions s
            where s.token_hash = g.successor_hash
              and s.revoked_at is null and s.expires_at > clock_timestamp()
              and s.user_id = g.user_id
              and coalesce(s.status_hash, s.token_hash) = g.status_hash
          )`;
      const g = grace[0];
      return g ? toRow(g) : null;
    },
    async renew(tokenHash, expiresAt) {
      // Check wall-clock liveness after the lock wait, just like rotation. Never
      // recreate a revoked/expired row or let an older request shorten renewal.
      const rows = await sql<{ renewed: number }[]>`with locked as materialized (
          select token_hash, revoked_at, expires_at from web_sessions
          where token_hash = ${tokenHash} for update
        )
        update web_sessions set expires_at = greatest(web_sessions.expires_at, ${expiresAt})
        from locked where web_sessions.token_hash = locked.token_hash
          and locked.revoked_at is null and locked.expires_at > clock_timestamp()
        returning 1 as renewed`;
      return rows.length > 0;
    },
    async statusHash(tokenHash) {
      const rows = await sql<
        { status_hash: string }[]
      >`select coalesce(status_hash, token_hash) as status_hash
        from web_sessions where token_hash = ${tokenHash}
          and revoked_at is null and expires_at > clock_timestamp()`;
      return rows[0]?.status_hash ?? null;
    },
    async isActive(statusHash) {
      const rows = await sql<{ active: boolean }[]>`select exists (
        select 1 from web_sessions where coalesce(status_hash, token_hash) = ${statusHash}
          and revoked_at is null and expires_at > clock_timestamp()
      ) as active`;
      return rows[0]?.active === true;
    },
    async rotate(oldTokenHash, replacement) {
      // Lock before checking eligibility, including no-op rotation. Materializing
      // the locked row keeps the wall-clock check after any lock wait; now() is
      // pinned to transaction start and could renew an expired session.
      if (oldTokenHash === replacement.tokenHash) {
        const rows = await sql<Record<string, unknown>[]>`with locked as materialized (
            select token_hash, revoked_at, expires_at from web_sessions
            where token_hash = ${oldTokenHash} for update
          )
          select count(*)::int as n from locked
          where revoked_at is null and expires_at > clock_timestamp()`;
        return Number(rows[0]?.n ?? 0) > 0;
      }
      // One winner: only the deleter inserts the successor and its grace row.
      // Grace keeps the predecessor's own member row for 10s from this commit,
      // bounded by its original expiry; a grandparent grace (successor = old)
      // is pruned so only the immediate predecessor stays valid. Reads never
      // extend the deadline and never mint siblings: get() only follows the
      // stored successor while it is live.
      const rows = await sql<Record<string, unknown>[]>`with locked as materialized (
          select token_hash, revoked_at, expires_at, user_id, username, avatar, member, moderator,
            coalesce(status_hash, token_hash) as status_hash
          from web_sessions where token_hash = ${oldTokenHash} for update
        ), deleted as (
          delete from web_sessions using locked
          where web_sessions.token_hash = locked.token_hash
            and locked.revoked_at is null and locked.expires_at > clock_timestamp()
          returning web_sessions.token_hash as old_hash,
            coalesce(web_sessions.status_hash, web_sessions.token_hash) as status_hash,
            web_sessions.user_id, web_sessions.username, web_sessions.avatar,
            web_sessions.member, web_sessions.moderator, web_sessions.expires_at
        ), pruned as (
          delete from web_session_grace using deleted
          where web_session_grace.successor_hash = deleted.old_hash
          returning 1
        ), inserted as (
          insert into web_sessions (token_hash, status_hash, user_id, username, avatar, member, moderator, expires_at)
          select ${replacement.tokenHash}, deleted.status_hash, ${replacement.userId}, ${replacement.username},
            ${replacement.avatar}, ${replacement.member}, ${replacement.moderator}, ${replacement.expiresAt}
          from deleted
          on conflict (token_hash) do update set
            status_hash = excluded.status_hash,
            user_id = excluded.user_id, username = excluded.username, avatar = excluded.avatar,
            member = excluded.member, moderator = excluded.moderator,
            expires_at = excluded.expires_at, revoked_at = null
          returning 1
        ), grace as (
          insert into web_session_grace
            (predecessor_hash, successor_hash, status_hash, user_id, username, avatar, member, moderator, expires_at, grace_expires_at)
          select deleted.old_hash, ${replacement.tokenHash}, deleted.status_hash,
            deleted.user_id, deleted.username, deleted.avatar,
            deleted.member, deleted.moderator, deleted.expires_at,
            clock_timestamp() + make_interval(secs => ${SESSION_PREDECESSOR_GRACE_SECONDS})
          from deleted
          on conflict (predecessor_hash) do update set
            successor_hash = excluded.successor_hash, status_hash = excluded.status_hash,
            user_id = excluded.user_id, username = excluded.username, avatar = excluded.avatar,
            member = excluded.member, moderator = excluded.moderator,
            expires_at = excluded.expires_at, grace_expires_at = excluded.grace_expires_at
          returning 1
        )
        select (select count(*)::int from deleted) as rotated`;
      return Number(rows[0]?.rotated ?? 0) > 0;
    },
    async revoke(tokenHash) {
      // Single-token revoke also drops any grace the token carries as
      // predecessor or successor, so a revoked successor grants nothing
      // through its predecessor and a revoked predecessor stays dead.
      await sql`with revoked as (
          update web_sessions set revoked_at = now()
          where token_hash = ${tokenHash} and revoked_at is null returning 1
        ), pruned as (
          delete from web_session_grace
          where predecessor_hash = ${tokenHash} or successor_hash = ${tokenHash}
          returning 1
        )
        select 1`;
    },
    async revokeLineage(statusHash) {
      // Lineage revoke drops the lineage's grace rows alongside its live rows;
      // unrelated lineages keep theirs.
      await sql`with revoked as (
          update web_sessions set revoked_at = now()
          where coalesce(status_hash, token_hash) = ${statusHash}
            and revoked_at is null and expires_at > clock_timestamp() returning 1
        ), pruned as (
          delete from web_session_grace where status_hash = ${statusHash} returning 1
        )
        select 1`;
    },
    async revokeUserSessions(userId, exceptTokenHash) {
      // Fresh-login sweep: drop the user's grace rows except any that involve
      // the freshly issued token (fresh tokens carry no grace yet).
      await sql`with revoked as (
          update web_sessions set revoked_at = now()
          where user_id = ${userId} and token_hash != ${exceptTokenHash}
            and revoked_at is null and expires_at > clock_timestamp() returning 1
        ), pruned as (
          delete from web_session_grace
          where user_id = ${userId}
            and predecessor_hash != ${exceptTokenHash} and successor_hash != ${exceptTokenHash}
          returning 1
        )
        select 1`;
    },
    async sweepExpired(now) {
      // `<=`: reads require expires_at > now(), so a row expiring exactly at
      // `now` is already invisible. Idempotent: a second pass matches nothing.
      // General-store full drain; the scheduled pass uses the bounded adapter
      // in `src/jobs/postgres.ts` instead, so daily holds stay capped.
      // Grace drains when either its fixed 10s deadline or the predecessor's
      // own expiry passes.
      const rows = await sql<Record<string, unknown>[]>`delete from web_sessions
        where expires_at <= ${now} returning 1`;
      const grace = await sql<Record<string, unknown>[]>`delete from web_session_grace
        where grace_expires_at <= ${now} or expires_at <= ${now} returning 1`;
      return rows.length + grace.length;
    },
  };
}

/** Test/memory helper. Same contract, no I/O. */
export function createMemorySessionStore(clock: () => number = Date.now): SessionStore {
  const rows = new Map<string, DbSessionRow & { expiresAt: number; statusHash: string }>();
  const grace = new Map<
    string,
    DbSessionRow & {
      successorHash: string;
      statusHash: string;
      expiresAt: number;
      graceExpiresAt: number;
    }
  >();
  const live = (hash: string) => {
    const r = rows.get(hash);
    if (!r || r.expiresAt <= clock()) {
      rows.delete(hash);
      return null;
    }
    return r;
  };
  const dropGraceForToken = (hash: string) => {
    grace.delete(hash);
    for (const [pre, g] of grace) {
      if (g.successorHash === hash) grace.delete(pre);
    }
  };
  return {
    journeys: createMemoryOAuthJourneyStore(clock),
    async replace(oldHash, replacement) {
      if (oldHash === replacement.tokenHash || rows.has(replacement.tokenHash)) {
        throw new Error("Session replacement must use a fresh token");
      }
      rows.delete(oldHash);
      dropGraceForToken(oldHash);
      rows.set(replacement.tokenHash, {
        ...replacement,
        expiresAt: replacement.expiresAt.getTime(),
        statusHash: replacement.tokenHash,
      });
    },
    async create(s) {
      grace.delete(s.tokenHash);
      rows.set(s.tokenHash, { ...s, expiresAt: s.expiresAt.getTime(), statusHash: s.tokenHash });
    },
    async get(hash) {
      const r = live(hash);
      if (r) {
        return {
          userId: r.userId,
          username: r.username,
          avatar: r.avatar,
          member: r.member,
          moderator: r.moderator,
        };
      }
      const g = grace.get(hash);
      if (!g) return null;
      if (g.graceExpiresAt <= clock() || g.expiresAt <= clock()) {
        grace.delete(hash);
        return null;
      }
      const successor = live(g.successorHash);
      if (!successor || successor.userId !== g.userId || successor.statusHash !== g.statusHash) {
        return null;
      }
      return {
        userId: g.userId,
        username: g.username,
        avatar: g.avatar,
        member: g.member,
        moderator: g.moderator,
      };
    },
    async renew(hash, expiresAt) {
      const r = live(hash);
      if (!r) return false;
      r.expiresAt = Math.max(r.expiresAt, expiresAt.getTime());
      return true;
    },
    async statusHash(hash) {
      return live(hash)?.statusHash ?? null;
    },
    async isActive(statusHash) {
      for (const hash of rows.keys()) {
        if (live(hash)?.statusHash === statusHash) return true;
      }
      return false;
    },
    async rotate(oldHash, replacement) {
      const source = live(oldHash);
      if (!source) return false;
      if (oldHash === replacement.tokenHash) return true;
      for (const [pre, g] of grace) {
        if (g.successorHash === oldHash) grace.delete(pre);
      }
      grace.set(oldHash, {
        userId: source.userId,
        username: source.username,
        avatar: source.avatar,
        member: source.member,
        moderator: source.moderator,
        successorHash: replacement.tokenHash,
        statusHash: source.statusHash,
        expiresAt: source.expiresAt,
        graceExpiresAt: clock() + SESSION_PREDECESSOR_GRACE_SECONDS * 1000,
      });
      rows.delete(oldHash);
      rows.set(replacement.tokenHash, {
        ...replacement,
        expiresAt: replacement.expiresAt.getTime(),
        statusHash: source.statusHash,
      });
      return true;
    },
    async revoke(hash) {
      rows.delete(hash);
      dropGraceForToken(hash);
    },
    async revokeLineage(statusHash) {
      for (const [hash, r] of rows) {
        if (r.statusHash === statusHash) rows.delete(hash);
      }
      for (const [pre, g] of grace) {
        if (g.statusHash === statusHash) grace.delete(pre);
      }
    },
    async revokeUserSessions(userId, exceptTokenHash) {
      for (const [hash, r] of rows) {
        if (hash !== exceptTokenHash && r.userId === userId && r.expiresAt > clock())
          rows.delete(hash);
      }
      for (const [pre, g] of grace) {
        if (g.userId === userId && pre !== exceptTokenHash && g.successorHash !== exceptTokenHash) {
          grace.delete(pre);
        }
      }
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
      for (const [pre, g] of grace) {
        if (g.graceExpiresAt <= t || g.expiresAt <= t) {
          grace.delete(pre);
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

/** Exact minted bearer shape: `two_` + 43 base64url chars (47 total).
 * Check this on the verified cookie value before hashing or any store call:
 * malformed input is guest/no-op with zero store reads. Never a substitute
 * for signature verification — always verify first, then shape-check. */
const SESSION_TOKEN_RE = /^two_[A-Za-z0-9_-]{43}$/;

export function isValidSessionToken(token: unknown): token is string {
  return typeof token === "string" && SESSION_TOKEN_RE.test(token);
}

/** `two_` + 32 random bytes, base64url. ~256 bits: unguessable, URL/cookie-safe. */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `two_${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
