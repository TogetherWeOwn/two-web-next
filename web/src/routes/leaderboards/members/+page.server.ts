import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../../src/admin/db";
import { alertRequestError } from "../../../../../src/alerts";
import { loadMembersBoardData, queueMembersBoardView } from "../../../../../src/kit-members";
import { JOURNEY_TTL_SECONDS } from "../../../../../src/return-journey";

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
export const load: PageServerLoad = async ({ url, locals, cookies, setHeaders }) => {
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
      url: url.href,
      requestId: locals.requestId,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : "";
    if (status === 302) {
      // Carry the deep link through sign-in: the helper's intendedCookie is
      // the full Hono-parity Set-Cookie serialization (live signed value, or
      // a clearing write when the destination was rejected). Re-emit it here
      // so the OAuth callback honors it exactly once; the redirect itself
      // stays the bare flow entry, like bounceToLogin.
      const intendedCookie = (err as { intendedCookie?: unknown })?.intendedCookie;
      if (typeof intendedCookie === "string" && intendedCookie !== "") {
        const pair = intendedCookie.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const encoded = pair.slice(eq + 1);
          if (encoded === "" || /max-age=0/i.test(intendedCookie)) {
            cookies.delete(name, {
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
            });
          } else {
            // The serialization is encoded; cookies.set re-encodes, so decode
            // once to avoid a double-encoding the callback cannot verify.
            let value = encoded;
            try {
              value = decodeURIComponent(encoded);
            } catch {
              // Keep the wire form rather than dropping the destination.
            }
            cookies.set(name, value, {
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
              maxAge: JOURNEY_TTL_SECONDS,
            });
          }
        }
      }
      setHeaders({ "cache-control": "no-store, private", vary: "Cookie" });
      redirect(302, "/auth/discord");
    }
    if (status === 403) error(403, "Forbidden");
    if (status === 400) error(400, message || "Unknown season");
    // The helper already alerted on unbranded read failures; alert here only
    // for failures the helper could not see, so a code bug never stays silent.
    if (typeof status !== "number")
      alertRequestError(err, {
        method: "GET",
        route: "/leaderboards/members",
        requestId: locals.requestId,
      });
    error(503, "Member data is temporarily unavailable.");
  }
};
