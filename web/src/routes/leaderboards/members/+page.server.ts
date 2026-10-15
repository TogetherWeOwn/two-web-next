import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { loadMembersBoardData, queueMembersBoardView } from "../../../../../src/kit-members";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block.
export const csr = false;

// Thin binding over the tested helper (src/kit-members.ts): the helper owns
// the gate order, grammar and ranking read; this binding owns the branded
// status mapping (302 OAuth bounce, 403 non-member, 400 grammar, 503
// unreadable session), mirroring web/src/routes/hotzones/+page.server.ts.
// Same behaviour as the Hono handler (src/leaderboards/routes.tsx): scope is
// overall (default) or relative; season is the shared window grammar;
// activity is one normalized game. The board-view log is only queued here
// (into locals): this load runs inside the member-read capture, where the
// INSERT would refuse the board, so the hook records the queued view after
// the boundary releases a 200 (src/kit-members.ts header).
export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  try {
    return await loadMembersBoardData({
      env,
      session: {
        // No bridge decision merged into locals reads as an outage, never a
        // guest: the helper answers its branded 503 for "unknown".
        status: locals.status ?? "unknown",
        userId: locals.session?.userId ?? null,
        username: locals.session?.username ?? null,
        member: locals.session?.member ?? false,
      },
      seasonParam: url.searchParams.get("season"),
      scopeParam: url.searchParams.get("scope"),
      activityParam: url.searchParams.get("activity"),
      setHeaders,
      dbForFn: dbFor,
      queueBoardViewFn: (db, entry) => queueMembersBoardView(locals, db, entry),
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : "";
    if (status === 302) redirect(302, "/auth/discord");
    if (status === 403) error(403, "Forbidden");
    if (status === 400) error(400, message || "Unknown season");
    error(503, "Member data is temporarily unavailable.");
  }
};
