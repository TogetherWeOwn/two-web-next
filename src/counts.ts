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
  // The Discord role id from web_v1.rank_ladder, present only when the rank
  // has a ladder row with a non-null role. A rank without a ladder row still
  // renders (completeness comes from rank_counts) with the field omitted, so
  // renders and toEqual pins treat it as absent rather than null.
  roleId?: string;
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

function mapRank(row: Row): Rank {
  const rank: Rank = {
    key: String(row.rank_key),
    label: String(row.rank_label),
    memberCount: count(row.member_count),
  };
  // A rank without a ladder row (or with a null role) carries no role: the
  // field stays omitted so renders skip the attribute and shape pins still
  // match the role-less rows.
  if (typeof row.role_id === "string" && row.role_id) rank.roleId = row.role_id;
  return rank;
}

// The ladder side of the join is optional: a bot schema without rank_ladder
// (42P01), without a grant on it (42501), without its role column (42703),
// or with its own rank_order column (42702) still renders role-less ranks
// from the counts alone. A code here only costs a counts-only retry: when the
// counts side itself is broken the retry fails too and takes the usual
// single-warn fallback path, exactly as before.
const LADDER_UNAVAILABLE_CODES = new Set(["42P01", "42501", "42703", "42702"]);

function isLadderUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    LADDER_UNAVAILABLE_CODES.has((error as { code?: unknown }).code as string)
  );
}

const readRanksView = cachedRead<Rank[]>("counts.ranks", [], async (sql) => {
  try {
    const rows = await sql<Row[]>`
      SELECT c.rank_key, c.rank_label, c.member_count, l.role_id
      FROM web_v1.rank_counts c LEFT JOIN web_v1.rank_ladder l ON l.rank_key = c.rank_key
      ORDER BY c.rank_order
    `;
    return rows.map(mapRank);
  } catch (error) {
    // The ladder table is optional: a bot schema that cannot serve the join
    // still renders role-less ranks from the counts alone. Any other error —
    // or a ranks-only failure too — takes the usual single-warn fallback path.
    if (!isLadderUnavailable(error)) throw error;
    const rows = await sql<Row[]>`
      SELECT rank_key, rank_label, member_count
      FROM web_v1.rank_counts ORDER BY rank_order
    `;
    return rows.map(mapRank);
  }
});

export async function readCounts(env: Env): Promise<Counts> {
  const url = botDatabaseUrl(env); // Explicit local/dev URL, else Hyperdrive BOT_DB.
  const [live, ranks] = await Promise.all([readLive(url), readRanksView(url)]);
  return { ...live, ranks };
}

// The ladder alone, for leaves that need ranks but no live numerals (/about,
// /faq on both stacks): the same cached ranks read, minus the live leg. Never
// throws: without a bot source (or with the views down) it resolves [] and
// the caller renders its static null-state.
export async function readRanks(env: Env): Promise<Rank[]> {
  return readRanksView(botDatabaseUrl(env));
}
