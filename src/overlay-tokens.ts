// Per-member OBS overlay tokens: capability-URL lifecycle over overlay_tokens.
//
// The bearer (`two_ov_` + 32 random bytes, base64url) is shown once at
// creation; the store only ever sees its SHA-256 hex, same as session tokens
// (`src/sessions.ts`). One live token per member: the partial unique index
// enforces it at the row level, and rotation is a single statement that flips
// the predecessor to `rotated` before the successor insert lands. A rotated
// predecessor keeps resolving for exactly 10s (measured from `rotated_at`,
// strict `<`, DB wall clock) and only while a live successor exists, so the
// in-OBS browser source survives the cutover and revoke kills grace both
// directions. Lifecycle ops never delete rows; `pruneHistory` is the only
// deletion path (see the retention rule below).
//
// Telemetry retention rule: `last_used_at`/`use_count` live on the token row
// and die with it. Non-live rows older than OVERLAY_TELEMETRY_RETENTION_DAYS
// (aged by `created_at`) are pruned, except rotated rows whose 10s grace is
// still open. Live rows are never pruned, so an active token keeps its full
// "last loaded" history; a rotated/revoked row keeps its telemetry for the
// retention window so the member can see whether the old URL is still loaded
// somewhere, then disappears.

import type { Sql } from "./sessions";

/** Minted bearer prefix. `two_ov_` + 43 base64url chars (50 total). */
export const OVERLAY_TOKEN_PREFIX = "two_ov_";

/** Predecessor grace: a rotated token resolves for exactly 10s from rotation. */
export const OVERLAY_PREDECESSOR_GRACE_SECONDS = 10;

/** Telemetry retention: non-live token rows (with their use telemetry) are
 * pruned after 90 days, matching the repo's 90-day telemetry retention for
 * audit tables (`docs/db-migrations.md`, audit-immutability guard). */
export const OVERLAY_TELEMETRY_RETENTION_DAYS = 90;

export type OverlayTokenStatus = "live" | "rotated" | "revoked" | "expired";

export type OverlayTokenRow = {
  id: string;
  memberId: string;
  tokenHash: string;
  status: OverlayTokenStatus;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
};

export type OverlayTokenLookup = {
  memberId: string;
  tokenId: string;
};

export type OverlayTokenStore = {
  /** Mint a live token. Rejects while the member already has one live. */
  mint: (memberId: string, tokenHash: string) => Promise<{ id: string }>;
  /** Atomic rotate: old live row to `rotated`, new row to `live`. False
   * unless the old hash is live and owned by the member; creates nothing. */
  rotate: (memberId: string, oldTokenHash: string, newTokenHash: string) => Promise<boolean>;
  /** Immediate revoke of one token. Unknown hashes are a no-op. */
  revoke: (tokenHash: string) => Promise<void>;
  /** Revoke every live token for the member (leave/demotion path).
   * Returns the live rows revoked; grace dies with the last live row. */
  revokeMemberTokens: (memberId: string) => Promise<number>;
  /** Resolve a hash to its owner. Live rows and in-grace predecessors
   * resolve and bump their own telemetry; everything else is null. The
   * result carries ids only, never the hash or the plaintext. */
  lookupByHash: (tokenHash: string) => Promise<OverlayTokenLookup | null>;
  /** Full per-member history (live plus rotated/revoked), oldest first. Only
   * pruning deletes rows; lifecycle ops only flip status. */
  listMemberTokens: (memberId: string) => Promise<OverlayTokenRow[]>;
  /** Delete non-live rows older than the retention window (aged by
   * `created_at`), sparing rotated rows whose grace is still open and all
   * live rows. Returns the rows removed. */
  pruneHistory: (now: Date) => Promise<number>;
};

const OVERLAY_TOKEN_RE = /^two_ov_[A-Za-z0-9_-]{43}$/;

export function isValidOverlayToken(token: unknown): token is string {
  return typeof token === "string" && OVERLAY_TOKEN_RE.test(token);
}

/** `two_ov_` + 32 random bytes, base64url. ~256 bits: unguessable, URL-safe. */
export function newOverlayToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return `${OVERLAY_TOKEN_PREFIX}${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** SHA-256 hex of an overlay bearer. Tokens are compared by hash only. */
export async function hashOverlayToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type MemoryRow = {
  id: string;
  memberId: string;
  status: OverlayTokenStatus;
  createdAtMs: number;
  rotatedAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
  useCount: number;
};

function toRow(hash: string, row: MemoryRow): OverlayTokenRow {
  return {
    id: row.id,
    memberId: row.memberId,
    tokenHash: hash,
    status: row.status,
    createdAt: new Date(row.createdAtMs),
    rotatedAt: row.rotatedAtMs === null ? null : new Date(row.rotatedAtMs),
    revokedAt: row.revokedAtMs === null ? null : new Date(row.revokedAtMs),
    lastUsedAt: row.lastUsedAtMs === null ? null : new Date(row.lastUsedAtMs),
    useCount: row.useCount,
  };
}

/** Test/memory helper. Same contract, no I/O. */
export function createMemoryOverlayTokenStore(clock: () => number = Date.now): OverlayTokenStore {
  const rows = new Map<string, MemoryRow>();
  const graceMs = OVERLAY_PREDECESSOR_GRACE_SECONDS * 1000;
  const retentionMs = OVERLAY_TELEMETRY_RETENTION_DAYS * 86_400_000;
  const hasLiveSuccessor = (memberId: string) => {
    for (const row of rows.values()) {
      if (row.memberId === memberId && row.status === "live") return true;
    }
    return false;
  };
  // Revoke kills grace permanently: a predecessor rotated at t0 must not
  // resolve again just because the member minted a fresh token later. Any
  // revocation of the member's chain at or after the rotation voids the
  // 10s window, so a killed URL stays dead past a re-mint.
  const chainRevokedSinceRotation = (memberId: string, rotatedAtMs: number) => {
    for (const row of rows.values()) {
      if (
        row.memberId === memberId &&
        row.status === "revoked" &&
        row.revokedAtMs !== null &&
        row.revokedAtMs >= rotatedAtMs
      )
        return true;
    }
    return false;
  };

  return {
    async mint(memberId, tokenHash) {
      if (hasLiveSuccessor(memberId)) throw new Error("member already has a live overlay token");
      const row: MemoryRow = {
        id: crypto.randomUUID(),
        memberId,
        status: "live",
        createdAtMs: clock(),
        rotatedAtMs: null,
        revokedAtMs: null,
        lastUsedAtMs: null,
        useCount: 0,
      };
      rows.set(tokenHash, row);
      return { id: row.id };
    },
    async rotate(memberId, oldTokenHash, newTokenHash) {
      if (oldTokenHash === newTokenHash) {
        // No-op rotation: report liveness without writing, like sessions.
        const existing = rows.get(oldTokenHash);
        if (!existing || existing.memberId !== memberId) return false;
        return existing.status === "live";
      }
      const old = rows.get(oldTokenHash);
      if (!old || old.memberId !== memberId || old.status !== "live") return false;
      old.status = "rotated";
      old.rotatedAtMs = clock();
      rows.set(newTokenHash, {
        id: crypto.randomUUID(),
        memberId,
        status: "live",
        createdAtMs: clock(),
        rotatedAtMs: null,
        revokedAtMs: null,
        lastUsedAtMs: null,
        useCount: 0,
      });
      return true;
    },
    async revoke(tokenHash) {
      const row = rows.get(tokenHash);
      if (row && row.status !== "revoked") {
        row.status = "revoked";
        row.revokedAtMs = clock();
      }
    },
    async revokeMemberTokens(memberId) {
      let revoked = 0;
      for (const row of rows.values()) {
        if (row.memberId === memberId && row.status === "live") {
          row.status = "revoked";
          row.revokedAtMs = clock();
          revoked += 1;
        }
      }
      return revoked;
    },
    async lookupByHash(tokenHash) {
      const row = rows.get(tokenHash);
      if (!row) return null;
      if (row.status === "live") {
        row.useCount += 1;
        row.lastUsedAtMs = clock();
        return { memberId: row.memberId, tokenId: row.id };
      }
      if (
        row.status === "rotated" &&
        row.rotatedAtMs !== null &&
        clock() - row.rotatedAtMs < graceMs &&
        hasLiveSuccessor(row.memberId) &&
        !chainRevokedSinceRotation(row.memberId, row.rotatedAtMs)
      ) {
        row.useCount += 1;
        row.lastUsedAtMs = clock();
        return { memberId: row.memberId, tokenId: row.id };
      }
      return null;
    },
    async listMemberTokens(memberId) {
      return [...rows.entries()]
        .filter(([, row]) => row.memberId === memberId)
        .sort(([, a], [, b]) => a.createdAtMs - b.createdAtMs)
        .map(([hash, row]) => toRow(hash, row));
    },
    async pruneHistory(now) {
      const nowMs = now.getTime();
      let pruned = 0;
      for (const [hash, row] of rows) {
        if (row.status === "live") continue;
        if (row.createdAtMs >= nowMs - retentionMs) continue;
        if (
          row.status === "rotated" &&
          row.rotatedAtMs !== null &&
          nowMs - row.rotatedAtMs < graceMs
        ) {
          continue;
        }
        rows.delete(hash);
        pruned += 1;
      }
      return pruned;
    },
  };
}

type OverlayTokenDbRow = {
  id: string;
  member_id: string;
  token_hash: string;
  status: OverlayTokenStatus;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_count: bigint;
};

function toDbRow(row: OverlayTokenDbRow): OverlayTokenRow {
  return {
    id: row.id,
    memberId: row.member_id,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    useCount: Number(row.use_count),
  };
}

export function createPostgresOverlayTokenStore(sql: Sql): OverlayTokenStore {
  return {
    async mint(memberId, tokenHash) {
      try {
        const rows = await sql<{ id: string }[]>`insert into overlay_tokens (member_id, token_hash)
          select ${memberId}, ${tokenHash}
          where not exists (
            select 1 from overlay_tokens where member_id = ${memberId} and status = 'live'
          )
          returning id`;
        const minted = rows[0];
        if (!minted) throw new Error("member already has a live overlay token");
        return { id: minted.id };
      } catch (error) {
        // Lost a concurrent mint (partial unique index) or hit a duplicate
        // hash: either way the mint is rejected at the store boundary.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw new Error("member already has a live overlay token");
        }
        throw error;
      }
    },
    async rotate(memberId, oldTokenHash, newTokenHash) {
      if (oldTokenHash === newTokenHash) {
        const rows = await sql<{ live: number }[]>`select 1 as live from overlay_tokens
          where token_hash = ${oldTokenHash} and member_id = ${memberId} and status = 'live'`;
        return rows.length > 0;
      }
      // One statement: the predecessor flips to `rotated` before the
      // successor insert, so the partial unique index never sees two live
      // rows and a failed rotate creates nothing. Wall clock, not now():
      // now() is pinned to transaction start and would backdate grace.
      const rows = await sql<{ id: string }[]>`with old as (
          update overlay_tokens set status = 'rotated', rotated_at = clock_timestamp()
          where token_hash = ${oldTokenHash} and member_id = ${memberId} and status = 'live'
          returning member_id
        )
        insert into overlay_tokens (member_id, token_hash)
        select member_id, ${newTokenHash} from old
        returning id`;
      return rows.length > 0;
    },
    async revoke(tokenHash) {
      // Revoking the predecessor kills its grace row directly. Revoking any
      // later row of the chain kills it permanently too: the lookup refuses
      // rotated rows with a revocation at or after rotated_at, so a later
      // re-mint cannot revive a killed URL.
      await sql`update overlay_tokens set status = 'revoked', revoked_at = clock_timestamp()
        where token_hash = ${tokenHash} and status <> 'revoked'`;
    },
    async revokeMemberTokens(memberId) {
      const rows = await sql<{ revoked: number }[]>`update overlay_tokens
        set status = 'revoked', revoked_at = clock_timestamp()
        where member_id = ${memberId} and status = 'live'
        returning 1 as revoked`;
      return rows.length;
    },
    async lookupByHash(tokenHash) {
      const live = await sql<
        { id: string; member_id: string }[]
      >`update overlay_tokens set use_count = use_count + 1, last_used_at = clock_timestamp()
        where token_hash = ${tokenHash} and status = 'live'
        returning id, member_id`;
      if (live[0]) return { memberId: live[0].member_id, tokenId: live[0].id };
      // Predecessor grace: strictly inside 10s from rotated_at, only while a
      // live successor exists, and never after the chain was revoked at or
      // after the rotation. Reads never extend the deadline.
      const grace = await sql<{ id: string; member_id: string }[]>`update overlay_tokens as o
        set use_count = o.use_count + 1, last_used_at = clock_timestamp()
        where o.token_hash = ${tokenHash} and o.status = 'rotated'
          and o.rotated_at > clock_timestamp() - make_interval(secs => ${OVERLAY_PREDECESSOR_GRACE_SECONDS})
          and exists (
            select 1 from overlay_tokens as s
            where s.member_id = o.member_id and s.status = 'live'
          )
          and not exists (
            select 1 from overlay_tokens as r
            where r.member_id = o.member_id and r.status = 'revoked'
              and r.revoked_at >= o.rotated_at
          )
        returning o.id as id, o.member_id as member_id`;
      if (grace[0]) return { memberId: grace[0].member_id, tokenId: grace[0].id };
      return null;
    },
    async listMemberTokens(memberId) {
      const rows = await sql<OverlayTokenDbRow[]>`select id, member_id, token_hash, status,
          created_at, rotated_at, revoked_at, last_used_at, use_count
        from overlay_tokens where member_id = ${memberId} order by created_at asc`;
      return rows.map(toDbRow);
    },
    async pruneHistory(now) {
      // Aged by created_at against the caller's clock; grace spares use the
      // same clock so a just-rotated row survives even with an old birth.
      const rows = await sql<{ pruned: number }[]>`delete from overlay_tokens
        where status <> 'live'
          and created_at < ${now} - make_interval(days => ${OVERLAY_TELEMETRY_RETENTION_DAYS})
          and not (
            status = 'rotated'
            and rotated_at > ${now} - make_interval(secs => ${OVERLAY_PREDECESSOR_GRACE_SECONDS})
          )
        returning 1 as pruned`;
      return rows.length;
    },
  };
}
