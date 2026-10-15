import type { Db } from "./db/index";
import type { Env } from "./env";
import { recordBoardView } from "./hotzones/board-log";
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
// ranking read, and every served board records its anonymous board view
// fail-open. Exactly one setHeaders call per served board: SvelteKit throws
// `header_already_set` on a double-set, so the binding must not set headers
// again on a throw.

export type MembersBoardSession = {
  status: "authenticated" | "guest" | "unknown";
  userId: string | null;
  member: boolean;
};

export type LoadRanking = (
  db: Db | null,
  window: SeasonWindow,
  game: string | null,
) => Promise<RankedMember[]>;
export type RecordBoardView = (
  db: Db | null,
  opts: { boardKey: string; scope: string; season: string; resultCount: number },
) => Promise<void>;

export interface MembersBoardArgs {
  env: Env;
  session: MembersBoardSession;
  seasonParam: string | null;
  scopeParam: string | null;
  activityParam: string | null;
  setHeaders: (headers: Record<string, string>) => void;
  dbForFn: (c: { env: Env }) => Promise<Db | null>;
  loadRankingFn?: LoadRanking;
  recordBoardViewFn?: RecordBoardView;
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

export async function loadMembersBoardData(args: MembersBoardArgs): Promise<{
  season: string;
  scope: "overall" | "relative";
  activity: string | null;
  rows: BoardRow[];
  viewerId: string;
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
  const db = await args.dbForFn({ env: args.env });
  const ranked = await (args.loadRankingFn ?? loadMemberRanking)(db, season, activity.game);
  const rows = boardRows(ranked, scope.scope, args.session.userId);
  // Fail-open, exactly as on the Hono handler: a logging failure never
  // blocks or breaks the board. Only a served (200) board records a view.
  await (args.recordBoardViewFn ?? recordBoardView)(db, {
    boardKey: "members",
    scope: scope.scope,
    season: season.label,
    resultCount: rows.length,
  }).catch(() => {});
  args.setHeaders({ "cache-control": "private, no-store" });
  return {
    season: season.label,
    scope: scope.scope,
    activity: activity.game,
    rows,
    viewerId: args.session.userId,
    available: db !== null,
    appUrl: args.env.APP_URL,
  };
}
