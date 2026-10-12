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
// see pruneBoardViewsOlderThan below and src/jobs/constants.ts.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { boardViewLogs } from "../db/admin-schema";
import { nonSensitiveRead } from "../member-reads";

/** Write deadline: logging must never hold the response (a locked table would wait forever). */
export const BOARD_LOG_WRITE_DEADLINE_MS = 500;
/** DB-side cap, shorter than the response deadline, so a blocked INSERT is cancelled server-side. */
export const BOARD_LOG_DB_TIMEOUT_MS = 400;

/** 90-day retention window for anonymous board_view_logs, pruned by occurred_at. */
export const BOARD_VIEW_LOG_RETENTION_DAYS = 90;

/** Never throws, never waits past the deadline. Logs the error class only. */
export async function recordBoardView(
  db: Db | null,
  opts: { boardKey: string; scope: string; season: string; resultCount: number },
  deadlineMs = BOARD_LOG_WRITE_DEADLINE_MS,
): Promise<void> {
  if (!db) return;
  const boardKey = opts.boardKey.slice(0, 128);
  const scope = opts.scope.slice(0, 64);
  const season = opts.season.slice(0, 32);
  if (boardKey === "") return;
  const warn = (exception: string) =>
    console.warn("Board view unavailable for logging; serving results without recording.", {
      exception,
    });
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
      select id from board_view_logs where occurred_at < ${cutoff}
      order by id limit 1000
    ) returning 1`,
  );
  return Array.isArray(rows) ? rows.length : 0;
}
