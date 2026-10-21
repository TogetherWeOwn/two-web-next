// Anonymous hot-zone board-view logging.
//
// Mirrors src/events/search-log.ts into the shared board_view_logs table:
// normalized_board_key (hotzones | hotzones/<signal>) + scope + season +
// result_count + occurred_at. No user id, session, IP, or raw input by design.
// Fail-open with write deadlines: a locked table degrades to an unrecorded
// view, never a broken board.
//
// Retention: board_view_logs rows older than BOARD_VIEW_LOG_RETENTION_DAYS
// (90 days, same as event_search_logs) are pruned by age on occurred_at;
// see pruneBoardViewsOlderThan below and src/jobs/constants.ts. The daily
// model:prune pass drains them via pgPruneStores().boardViews.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { boardViewLogs } from "../db/admin-schema";
import { nonSensitiveRead } from "../member-reads";
import { safeRequestId } from "../request-log";

// Single source of truth lives in src/jobs/constants.ts; re-exported here so
// existing imports keep working while the prune pass reads the same constant.
export { BOARD_VIEW_LOG_RETENTION_DAYS } from "../jobs/constants";

/** Write deadline: logging must never hold the response (a locked table would wait forever). */
export const BOARD_LOG_WRITE_DEADLINE_MS = 500;
/** DB-side cap, shorter than the response deadline, so a blocked INSERT is cancelled server-side. */
export const BOARD_LOG_DB_TIMEOUT_MS = 400;

/** Never throws, never waits past the deadline. Logs the error class only, plus the validated request_id so the line joins to `http.request`. */
export async function recordBoardView(
  db: Db | null,
  opts: { boardKey: string; scope: string; season: string; resultCount: number },
  deadlineMs = BOARD_LOG_WRITE_DEADLINE_MS,
  requestId?: unknown,
): Promise<void> {
  if (!db) return;
  const boardKey = opts.boardKey.slice(0, 128);
  const scope = opts.scope.slice(0, 64);
  const season = opts.season.slice(0, 32);
  if (boardKey === "") return;
  const warn = (exception: string) => {
    const validated = safeRequestId(requestId);
    console.warn("Board view unavailable for logging; serving results without recording.", {
      exception,
      ...(validated !== undefined ? { request_id: validated } : {}),
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (async () => {
    try {
      await db.transaction(async (tx) => {
        await nonSensitiveRead("timeouts", () =>
          tx.execute(
            sql`select set_config('lock_timeout', ${`${BOARD_LOG_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${BOARD_LOG_DB_TIMEOUT_MS}ms`}, true)`,
          ),
        );
        await tx.insert(boardViewLogs).values({
          normalizedBoardKey: boardKey,
          scope,
          season,
          resultCount: Math.max(0, opts.resultCount),
        });
      });
    } catch (err) {
      warn(err instanceof Error ? err.constructor.name : typeof err);
    }
  })();
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warn("LogWriteDeadline");
      resolve();
    }, deadlineMs);
  });
  try {
    await Promise.race([write, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Age prune for anonymous board views (90-day retention, MassPrunable shape):
 * strictly older than the cutoff goes (`occurred_at < cutoff`), cutoff-exact
 * rows survive. Batched by PRUNE_DELETE_BATCH_SIZE via the caller's loop.
 */
export async function pruneBoardViewsOlderThan(
  db: Pick<Db, "execute">,
  cutoff: Date,
): Promise<number> {
  const rows = await db.execute(
    sql`delete from board_view_logs where id in (
      select id from board_view_logs where occurred_at < ${cutoff.toISOString()}::timestamptz
      order by id limit 1000
    ) returning 1`,
  );
  return Array.isArray(rows) ? rows.length : 0;
}

export type BoardViewEntry = {
  boardKey: string;
  scope: string;
  season: string;
  resultCount: number;
};
export type QueueBoardView = (db: Db | null, entry: BoardViewEntry, requestId?: unknown) => void;
export type RecordBoardView = (
  db: Db | null,
  entry: BoardViewEntry,
  deadlineMs?: number,
  requestId?: unknown,
) => Promise<void>;

// Request-locals slot carrying a queued board view from a Kit member-board
// load to the member-read boundary's post-release hook (src/kit-members.ts
// header has the full story). The db handle travels with the entry (as the
// Hono handler's c.set("boardView", ...) carries it): it never enters page
// data, so nothing database-shaped is serialized to the client.
const BOARD_VIEW_LOCAL = "membersBoardView";

export function queueBoardView(
  locals: unknown,
  db: Db | null,
  entry: BoardViewEntry,
  requestId?: unknown,
): void {
  if (!locals || typeof locals !== "object") return;
  (locals as Record<string, unknown>)[BOARD_VIEW_LOCAL] = { db, entry, requestId };
}

/**
 * Post-release record: writes the queued anonymous board view only for a
 * released 200, consumes the queue either way (a refused response must not
 * leak its view into a later request sharing the locals object), and never
 * throws — the board is already served, so a logging failure is dropped.
 * A queued request id rides along to the record call, where it validates
 * like any caller-supplied id; nothing queued means nothing carried.
 */
export async function recordQueuedBoardView(
  locals: unknown,
  status: number,
  recordFn: RecordBoardView = recordBoardView,
): Promise<void> {
  if (!locals || typeof locals !== "object") return;
  const bag = locals as Record<string, unknown>;
  const queued = bag[BOARD_VIEW_LOCAL] as
    | { db: Db | null; entry: BoardViewEntry; requestId?: unknown }
    | undefined;
  delete bag[BOARD_VIEW_LOCAL];
  if (!queued || status !== 200) return;
  await recordFn(queued.db, queued.entry, undefined, queued.requestId).catch(() => {});
}
