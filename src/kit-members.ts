import type { Db } from "./db/index";
import type { Env } from "./env";
import { alertRequestError } from "./alerts";
import {
  queueBoardView,
  recordBoardView,
  recordQueuedBoardView,
  type BoardViewEntry,
  type QueueBoardView,
  type RecordBoardView,
} from "./hotzones/board-log";
import { parseSeasonParam, type SeasonWindow } from "./hotzones/season";
import {
  boardRows,
  loadMemberRanking,
  parseActivityParam,
  parseScopeParam,
  type BoardRow,
  type RankedMember,
} from "./leaderboards/members";

// Framework-free core of the Kit member-board load
// (web/src/routes/leaderboards/members/+page.server.ts). The SvelteKit module
// stays a thin binding over this helper so the root Vitest suite can pin every
// branch without transforming SvelteKit code, mirroring src/kit-hotzones.ts.
// Behaviour preserved from the Hono handler (src/leaderboards/routes.tsx):
// the member gate first (guest 302, non-member 403, unreadable session 503),
// then the season/scope/activity grammar (400 before any read), then the
// ranking read. Exactly one setHeaders call per served board: SvelteKit throws
// `header_already_set` on a double-set, so the binding must not set headers
// again on a throw.
//
// The board-view log is NOT written here. This load runs inside the Kit
// member-read capture (memberReadResponse via renderMemberRead), and the
// board_view_logs INSERT has no read permit there — writing it inside the
// capture refuses every served board (503). Like the Hono handler, which
// writes the view only after memberReadBoundary releases a 200, this helper
// only queues the anonymous entry (queueMembersBoardView into the request
// locals); the dispatch records it after the boundary releases a 200
// (recordQueuedMembersBoardView, run as memberReadResponse's post-release
// hook, outside the capture). Fail-open at both stages: a queue or write
// failure never blocks or breaks the board.

export type MembersBoardSession = {
  status: "authenticated" | "guest" | "unknown";
  userId: string | null;
  username?: string | null;
  member: boolean;
};

export type LoadRanking = (
  db: Db | null,
  window: SeasonWindow,
  game: string | null,
  scope?: "overall" | "relative",
  viewerId?: string,
) => Promise<RankedMember[]>;

export type { BoardViewEntry, QueueBoardView, RecordBoardView };

/** Queue the anonymous board view for the post-release record (src/hotzones/board-log.ts). */
export function queueMembersBoardView(locals: unknown, db: Db | null, entry: BoardViewEntry): void {
  queueBoardView(locals, db, entry);
}

/** Record the queued board view after a released 200 (src/hotzones/board-log.ts). */
export async function recordQueuedMembersBoardView(
  locals: unknown,
  status: number,
  recordFn: RecordBoardView = recordBoardView,
): Promise<void> {
  return recordQueuedBoardView(locals, status, recordFn);
}

export interface MembersBoardArgs {
  env: Env;
  session: MembersBoardSession;
  seasonParam: string | null;
  scopeParam: string | null;
  activityParam: string | null;
  setHeaders: (headers: Record<string, string>) => void;
  dbForFn: (c: { env: Env }) => Promise<Db | null>;
  loadRankingFn?: LoadRanking;
  queueBoardViewFn?: QueueBoardView;
}

function branded(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Guest: the binding maps this to the OAuth bounce, like memberGate. */
export function membersGuestBounce(): Error & { status: number } {
  return branded("Signed out", 302);
}

/** Signed-in non-member: the binding maps this to error(403). */
export function membersForbidden(): Error & { status: number } {
  return branded("Forbidden", 403);
}

/** Unreadable session: an outage, never a guest bounce or a board. */
export function membersSessionUnknown(): Error & { status: number } {
  return branded("Member data is temporarily unavailable.", 503);
}

/** Branded outage marker for a failed board read: the binding maps it to error(503). */
export function membersBoardUnavailable(): Error & { status: number } {
  return branded("Member data is temporarily unavailable.", 503);
}

// A code bug (no branded status) must never look like a downstream outage:
// emit the leak-free error.alert diagnostic before mapping to the branded
// 503, mirroring the Hono member-read boundary (src/member-reads.ts). Branded
// throws pass through untouched so the binding maps them once.
function reportBoardFailure(err: unknown, args: MembersBoardArgs): never {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") throw err;
  alertRequestError(err, { method: "GET", route: "/leaderboards/members" });
  args.setHeaders({ "cache-control": "private, no-store" });
  throw membersBoardUnavailable();
}

/**
 * Row as serialized to the page — and to `__data.json`, which SvelteKit
 * serves from the load's return value even with `csr = false`. Rank, display
 * name and count only, plus the server-side viewer mark: no Discord IDs ever
 * leave the load (src/leaderboards/members.ts: "Rows carry rank + display
 * name + count only").
 */
export type MembersBoardRow = Omit<BoardRow, "userId"> & { isViewer: boolean };

export async function loadMembersBoardData(args: MembersBoardArgs): Promise<{
  season: string;
  scope: "overall" | "relative";
  activity: string | null;
  rows: MembersBoardRow[];
  viewerUsername: string;
  available: boolean;
  appUrl: string;
}> {
  // Same gate order as the Hono handler: session gate before any grammar,
  // grammar before any read.
  if (args.session.status === "unknown") throw membersSessionUnknown();
  if (args.session.status !== "authenticated" || !args.session.userId) throw membersGuestBounce();
  if (!args.session.member) throw membersForbidden();
  const season = parseSeasonParam(args.seasonParam);
  if (!season) throw branded("Unknown season", 400);
  const scope = parseScopeParam(args.scopeParam);
  if (!scope.ok) throw branded(scope.message, 400);
  const activity = parseActivityParam(args.activityParam);
  if (!activity.ok) throw branded(activity.message, 400);
  let db: Db | null;
  let ranked: RankedMember[];
  try {
    db = await args.dbForFn({ env: args.env });
    ranked = await (args.loadRankingFn ?? loadMemberRanking)(
      db,
      season,
      activity.game,
      scope.scope,
      args.session.userId,
    );
  } catch (err) {
    reportBoardFailure(err, args);
  }
  // The relative read already returns its SQL-numbered window (BoardRow):
  // only the overall ranking still needs numbering from the full list.
  const windowed: BoardRow[] =
    scope.scope === "relative"
      ? (ranked as BoardRow[])
      : boardRows(ranked, scope.scope, args.session.userId);
  // Strip every Discord ID here: mark the viewer's own row server-side so
  // neither the HTML props nor the __data.json payload carry an ID.
  const rows: MembersBoardRow[] = windowed.map(({ userId, ...row }) => ({
    ...row,
    isViewer: userId === args.session.userId,
  }));
  // Queue only (see the header): the write itself runs after the member-read
  // boundary releases this board, outside its capture. Only a served (200)
  // board records a view, and queueing is fail-open like the Hono write.
  try {
    args.queueBoardViewFn?.(db, {
      boardKey: "members",
      scope: scope.scope,
      season: season.label,
      resultCount: rows.length,
    });
  } catch {
    // A logging failure never blocks or breaks the board.
  }
  args.setHeaders({ "cache-control": "private, no-store" });
  return {
    season: season.label,
    scope: scope.scope,
    activity: activity.game,
    rows,
    // The board only serves authenticated members (gate above), so the page
    // renders member chrome with this name, mirroring Hono's session header.
    viewerUsername: args.session.username ?? "",
    available: db !== null,
    appUrl: args.env.APP_URL,
  };
}
