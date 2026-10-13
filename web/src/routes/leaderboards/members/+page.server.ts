import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { parseSeasonParam } from "../../../../../src/hotzones/season";
import {
  boardRows,
  loadMemberRanking,
  parseActivityParam,
  parseScopeParam,
} from "../../../../../src/leaderboards/members";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Same gate order, grammar and reads as the Hono handler
// (src/leaderboards/routes.tsx): session, then the season/scope/activity
// grammar (400 before any read), then the ranking. Scope is overall (default)
// or relative; season is the shared window grammar; activity is one game.
export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  // An unreadable session is an outage, never a guest bounce or a board.
  if (locals.status === "unknown") error(503, "Member data is temporarily unavailable.");
  const session = locals.session;
  if (locals.status !== "authenticated" || !session) redirect(302, "/auth/discord");
  if (!session.member) error(403, "Forbidden");
  const season = parseSeasonParam(url.searchParams.get("season"));
  if (!season) error(400, "Unknown season");
  const scope = parseScopeParam(url.searchParams.get("scope"));
  if (!scope.ok) error(400, scope.message);
  const activity = parseActivityParam(url.searchParams.get("activity"));
  if (!activity.ok) error(400, activity.message);
  const db = await dbFor({ env });
  const ranked = await loadMemberRanking(db, season, activity.game);
  setHeaders({ "cache-control": "private, no-store" });
  return {
    season: season.label,
    scope: scope.scope,
    activity: activity.game,
    rows: boardRows(ranked, scope.scope, session.userId),
    viewerId: session.userId,
    available: db !== null,
    appUrl: env.APP_URL,
  };
};
