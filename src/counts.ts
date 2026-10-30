// Frozen two-web CountsReader contract. Bot-owned views only; no migrations
// or writes here. The views live in the bot database (BOT_DB/BOT_DATABASE_URL),
// never in the web database: without a bot source the reads degrade to hidden.
// Each read degrades independently so ranks can survive a
// missing collector snapshot (and live counts can survive a missing ladder).
import postgres from "postgres";
import { exceptionClass } from "./alerts";
import { botDatabaseUrl, databaseOptions } from "./db/connection";
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
  const updatedAt =
    raw instanceof Date
      ? raw.getTime()
      : typeof raw === "string" && raw.trim()
        ? Date.parse(raw)
        : NaN;
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
  let nextFill = 0;
  let publishedFill = 0;
  return async (url: string | undefined): Promise<T> => {
    if (!url) return fallback;
    if (cache?.url === url && Date.now() < cache.expiresAt) return cache.value;
    const fill = ++nextFill;
    const value = await (async () => {
      let sql: postgres.Sql | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        sql = postgres(url, { ...databaseOptions, connect_timeout: 2 });
        return await Promise.race([
          read(sql),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("CountsReadTimeout")),
              COUNTS_READ_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        // Explicit closure matters at the edge; Hyperdrive owns the upstream
        // pool. Force shutdown after a second if a query/connection is stuck.
        await sql?.end({ timeout: 1 });
      }
    })().catch((err: unknown) => {
      // Class only (`queueExceptionClass` style): never the driver
      // message/URL, either of which may contain credentials.
      console.warn("Counts read unavailable", { key, exception: exceptionClass(err) });
      return fallback;
    });
    // Pending/abandoned fills do not disqualify usable completions. Only an
    // already-published newer snapshot prevents an older fill replacing it.
    if (fill > publishedFill) {
      publishedFill = fill;
      cache = { url, value, expiresAt: Date.now() + COUNTS_CACHE_TTL_MS };
    }
    return value;
  };
}

const readLive = cachedRead<LiveCounts>(
  "counts.live",
  { memberCount: null, onlineCount: null },
  async (sql) => {
    const rows = await sql<Row[]>`
    SELECT human_member_count, online_count, counts_updated_at
    FROM web_v1.live_counts LIMIT 1
  `;
    return liveCounts(rows[0]);
  },
);

// The stored ladder is five rungs (docs/web-v1-contract.md); 20 rows and 64
// characters per key/label are generous pathological caps (4x/8x the normal
// ladder) that keep the single-copy community DTO under the 32 KiB
// promise. MCP additionally budgets the escaped, duplicated tool result
// in mcp/server.ts. Admission is judged in SQL before transfer:
// CASE nulls an over-cap key/label in the projection itself (the event
// egress precedent), so oversized stored text never crosses the driver, and
// the marker column says why. Length is PostgreSQL `length()` — characters,
// the unit the caps are stated in — so a multibyte value at the cap crosses
// byte-identical. One oversized, over-cap, or misshapen row refuses the
// WHOLE read through the `cachedRead` fallback below: never a partial
// ladder, never String()-coerced text. The driver-level checks stay as a
// second line for a driver that hands back non-text cells anyway.
export const RANK_TEXT_MAX_CHARS = 64;
export const RANK_ROW_CAP = 20;

const readRanks = cachedRead<Rank[]>("counts.ranks", [], async (sql) => {
  const rows = await sql<Row[]>`
    SELECT
      CASE WHEN rank_key IS NOT NULL AND length(rank_key) <= 64
            AND rank_label IS NOT NULL AND length(rank_label) <= 64
           THEN rank_key END AS rank_key,
      CASE WHEN rank_key IS NOT NULL AND length(rank_key) <= 64
            AND rank_label IS NOT NULL AND length(rank_label) <= 64
           THEN rank_label END AS rank_label,
      member_count,
      (rank_key IS NOT NULL AND length(rank_key) <= 64
       AND rank_label IS NOT NULL AND length(rank_label) <= 64) AS rank_text_fits
    FROM web_v1.rank_counts ORDER BY rank_order LIMIT 21
  `;
  if (rows.length > RANK_ROW_CAP) throw new Error("RankCountsOverCap");
  return rows.map((row) => {
    const key = row.rank_key;
    const label = row.rank_label;
    if (
      row.rank_text_fits === false ||
      typeof key !== "string" ||
      typeof label !== "string" ||
      [...key].length > RANK_TEXT_MAX_CHARS ||
      [...label].length > RANK_TEXT_MAX_CHARS
    ) {
      throw new Error("RankCountsOversized");
    }
    return { key, label, memberCount: count(row.member_count) };
  });
});

export async function readCounts(env: Env): Promise<Counts> {
  const url = botDatabaseUrl(env); // Explicit local/dev URL, else Hyperdrive BOT_DB.
  const [live, ranks] = await Promise.all([readLive(url), readRanks(url)]);
  return { ...live, ranks };
}
