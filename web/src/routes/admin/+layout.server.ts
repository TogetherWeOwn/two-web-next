import { error, redirect } from "@sveltejs/kit";
import { decideKitAdminGuard } from "../../../../src/admin/kit-guard";
import type { LayoutServerLoad } from "./$types";

// Server-rendered only: the Hono panel ships no JavaScript, so the Kit admin
// carries no hydration bundle that the CSP (script-src 'self') would block.
export const csr = false;

// The one moderator guard every Kit admin route shares. It decides from the
// read-only session the Kit hook bridged into locals — no rotation, no cookie
// writes, no database, no audit of its own. SvelteKit converts the thrown
// redirect/error into the response inside resolve(), before the member-read
// boundary releases it, so the guest bounce and the 403/503 stay exact.
// Children read the actor via parent(): they never re-decide the session.
//
// The hook attaches the shared signed auth-status probe only to successful
// moderator admin documents; this read-only guard never writes session cookies.
export const load: LayoutServerLoad = async ({ locals, url, setHeaders }) => {
  const decision = decideKitAdminGuard(
    { status: locals.status, session: locals.session },
    `${url.pathname}${url.search}`,
  );
  if (decision.kind === "guest") {
    setHeaders({ "cache-control": "no-store, private", vary: "Cookie" });
    redirect(302, decision.location);
  }
  if (decision.kind === "forbidden") error(403, "Forbidden");
  if (decision.kind === "unavailable") error(503, "Admin temporarily unavailable");
  return { actor: decision.actor };
};
