// GET /leaderboards/members: the member-gated, seasonal member leaderboard.
//
// Order on every layer: the shared member gate (guest → 302 /auth/discord,
// non-member → 403), then query validation (400 before any read), then the
// ranking read. Reads run inside the member-read boundary, so the access log
// records the members whose counts were read; the anonymous board-view log is written after
// the boundary releases the response and is fail-open. Same ranking read the
// Kit load calls, per web/src/routes/events/past/ precedent.
import { dbFor } from "../admin/db";
import { databaseUnavailable } from "../errors";
import { parseSeasonParam } from "../hotzones/season";
import { recordBoardView } from "../hotzones/board-log";
import { bufferedMemberHtml, memberReadBoundary } from "../member-reads";
import { memberGate } from "../profiles/routes-gate";
import type { Ctx, ProfileApp, ProfileDeps } from "../profiles/routes-shared";
import type { ProfileStores } from "../profiles/routes-stores";
import {
  boardRows,
  loadMemberRanking,
  parseActivityParam,
  parseScopeParam,
  type BoardRow,
} from "./members";
import { MemberBoardFilterErrorPage, MemberLeaderboardPage } from "./pages";

export const MEMBER_BOARD_PATH = "/leaderboards/members";
const BOARD_KEY = "members";

export function registerMemberLeaderboardRoutes(
  app: ProfileApp,
  deps: ProfileDeps,
  { sinkFor }: Pick<ProfileStores, "sinkFor">,
) {
  const render = async (c: Ctx) => {
    // The gate set the viewer with no database read; the refusal page needs
    // it for the signed-in header, still before any read or log write.
    const viewer = c.get("viewer");
    const session = { ...viewer, avatar: null };
    const refused = (problem: string) =>
      bufferedMemberHtml(
        c,
        <MemberBoardFilterErrorPage session={session} problem={problem} />,
        400,
      );
    const window = parseSeasonParam(c.req.query("season") ?? null);
    if (!window) return refused("Unknown season");
    const scope = parseScopeParam(c.req.query("scope") ?? null);
    if (!scope.ok) return refused(scope.message);
    const activity = parseActivityParam(c.req.query("activity") ?? null);
    if (!activity.ok) return refused(activity.message);
    const db = await dbFor(c);
    const ranked = await loadMemberRanking(db, window, activity.game, scope.scope, viewer.id);
    // The relative read already returns its SQL-numbered window (BoardRow):
    // only the overall ranking still needs numbering from the full list.
    const rows =
      scope.scope === "relative"
        ? (ranked as BoardRow[])
        : boardRows(ranked, scope.scope, viewer.id);
    const season = window.label;
    c.set("boardView", {
      db,
      boardKey: BOARD_KEY,
      scope: scope.scope,
      season,
      resultCount: rows.length,
    });
    return bufferedMemberHtml(
      c,
      <MemberLeaderboardPage
        appUrl={c.env.APP_URL}
        session={{ ...viewer, avatar: null }}
        query={{ season, scope: scope.scope, activity: activity.game }}
        rows={rows}
        available={db !== null}
      />,
    );
  };

  app.use(MEMBER_BOARD_PATH, memberGate(deps));
  app.use(MEMBER_BOARD_PATH, async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    await memberReadBoundary(
      c,
      {
        viewer: c.get("viewer").id,
        resource: "leaderboard",
        action: "list",
        route: "leaderboards.members",
      },
      async (entry) => {
        const sink = await sinkFor(c);
        if (!sink) throw new Error("no access-log sink");
        return sink(entry);
      },
      next,
      databaseUnavailable,
    );
    // After the boundary, outside its capture: the log insert is not a member
    // read and must neither run inside the capture nor be refused by it.
    const view = c.get("boardView");
    if (!view || c.res.status !== 200) return;
    const { db, ...entry } = view;
    await recordBoardView(db, entry).catch(() => {});
  });
  app.get(MEMBER_BOARD_PATH, render);
}
