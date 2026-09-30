// Frozen two-web CountsReader contract. Bot-owned views only; no migrations
// or writes here. Each read degrades independently so ranks can survive a
// missing collector snapshot (and live counts can survive a missing ladder).
import postgres from "postgres";
import { databaseOptions, databaseUrl } from "./db/connection";
import type { Env } from "./env";

export type Rank = {
  key: string;
  label: string;
  memberCount: number | null;
};

export type Counts = {
  memberCount: number | null;
  onlineCount: number | null;
  ranks: Rank[];
};

type LiveCounts = Pick<Counts, "memberCount" | "onlineCount">;
type Row = Record<string, unknown>;

export const UNAVAILABLE: Counts = { memberCount: null, onlineCount: null, ranks: [] };
export const COUNTS_CACHE_TTL_MS = 60_000;
export const COUNTS_FRESH_FOR_MS = 10 * 60_000;
export const COUNTS_READ_TIMEOUT_MS = 2_000;

function count(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function liveCounts(row: Row | undefined): LiveCounts {
  const raw = row?.counts_updated_at;
  const updatedAt = raw instanceof Date ? raw.getTime()
    : typeof raw === "string" && raw.trim() ? Date.parse(raw) : NaN;
  // Carbon's diff is absolute: far-future snapshots are stale too. Exactly
  // ten minutes is stale. Unlike legacy's "as of" display, this slice hides
  // stale numerals per the homepage acceptance criterion.
  if (!Number.isFinite(updatedAt) || Math.abs(Date.now() - updatedAt) >= COUNTS_FRESH_FOR_MS) {
    return { memberCount: null, onlineCount: null };
  }
  const memberCount = count(row?.human_member_count);
  return { memberCount, onlineCount: memberCount == null ? null : count(row?.online_count) };
}

// One settled entry per view bounds isolate memory and scopes cache reuse to
// the DB connection. Never share pending I/O: Workers can cancel it when the
// owning invocation ends, stranding later callers on an unresolved promise.
// Concurrent cold requests fill independently with their own read deadlines.
// Cache unavailable results too; there is no post-expiry stale fallback.
function cachedRead<T>(key: string, fallback: T, read: (sql: postgres.Sql) => Promise<T>) {
  let cache: { url: string; value: T; expiresAt: number } | undefined;
  let latestFill = 0;
  return async (url: string | undefined): Promise<T> => {
    if (!url) return fallback;
    if (cache?.url === url && Date.now() < cache.expiresAt) return cache.value;
    const fill = ++latestFill;
    const value = await (async () => {
      let sql: postgres.Sql | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        sql = postgres(url, { ...databaseOptions, connect_timeout: 2 });
        return await Promise.race([
          read(sql),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("CountsReadTimeout")), COUNTS_READ_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        // Explicit closure matters at the edge; Hyperdrive owns the upstream
        // pool. Force shutdown after a second if a query/connection is stuck.
        await sql?.end({ timeout: 1 });
      }
    })().catch(() => {
      // Never log the driver message/URL: either may contain credentials.
      console.warn("Counts read unavailable", { key });
      return fallback;
    });
    // An older slow fill must not replace a newer completed snapshot.
    if (fill === latestFill) cache = { url, value, expiresAt: Date.now() + COUNTS_CACHE_TTL_MS };
    return value;
  };
}

const readLive = cachedRead<LiveCounts>("counts.live", { memberCount: null, onlineCount: null }, async (sql) => {
  const rows = await sql<Row[]>`
    SELECT human_member_count, online_count, counts_updated_at
    FROM web_v1.live_counts LIMIT 1
  `;
  return liveCounts(rows[0]);
});

const readRanks = cachedRead<Rank[]>("counts.ranks", [], async (sql) => {
  const rows = await sql<Row[]>`
    SELECT rank_key, rank_label, member_count
    FROM web_v1.rank_counts ORDER BY rank_order
  `;
  return rows.map((row) => ({
    key: String(row.rank_key), label: String(row.rank_label), memberCount: count(row.member_count),
  }));
});

export async function readCounts(env: Env): Promise<Counts> {
  const url = databaseUrl(env); // Explicit local/dev URL, else Hyperdrive DB.
  const [live, ranks] = await Promise.all([readLive(url), readRanks(url)]);
  return { ...live, ranks };
}
