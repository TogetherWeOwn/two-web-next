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
// Enablement blocker (docs/kit-parity-gates.md, GET /admin row): the Hono
// panel's moderator tab-sync probe (signed auth-status cookie plus the
// /islands/auth-status.js script, src/auth-status.ts) is not ported here.
// The guard stays read-only until the enablement slice lands the probe, so
// flipping the manifest entry must wait for it.
export const load: LayoutServerLoad = async ({ locals, url }) => {
  const decision = decideKitAdminGuard(
    { status: locals.status, session: locals.session },
    `${url.pathname}${url.search}`,
  );
  if (decision.kind === "guest") redirect(302, decision.location);
  if (decision.kind === "forbidden") error(403, "Forbidden");
  if (decision.kind === "unavailable") error(503, "Admin temporarily unavailable");
  return { actor: decision.actor };
};
