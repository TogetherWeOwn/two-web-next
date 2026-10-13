// Kit moderator guard decision. The one guard contract every
// Kit admin route shares through web/src/routes/admin/+layout.server.ts:
// guest OAuth bounce with a safe return, signed non-moderator 403, session
// outage 503 — the same four outcomes as src/admin/guard.ts, minus Hono.
//
// Framework-free and read-only by construction: it decides from the session
// the Kit hook already bridged into locals, so it performs zero store reads,
// never rotates, never sets cookies, and never writes an audit row. The
// member-read boundary around resolve() owns classification and the audit;
// the layout load only throws SvelteKit's redirect()/error(), which resolve()
// converts to responses before the boundary releases them.
import { safeNext } from "../join/service";
import type { KitLocals } from "../kit-session";

export type KitAdminActor = { id: string; username: string };

export type KitAdminGuardDecision =
  | { kind: "pass"; actor: KitAdminActor }
  | { kind: "guest"; location: string }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** Only the bridged session fields the decision reads. */
export type KitAdminGuardLocals = {
  status: KitLocals["status"] | undefined;
  session: KitLocals["session"] | null | undefined;
};

/**
 * Decide the admin request from the bridged session. A guest (missing,
 * tampered or expired bearer) bounces into the site Discord OAuth flow with
 * the requested page as a safe `next` — there is no panel login page. A
 * signed-in non-moderator is forbidden, never bounced into a login loop. An
 * indeterminate session (store failure, unbridged locals, authenticated
 * without a row) refuses to decide rather than guessing.
 */
export function decideKitAdminGuard(
  locals: KitAdminGuardLocals | undefined,
  currentPath: string,
): KitAdminGuardDecision {
  if (!locals || locals.status === undefined || locals.status === "unknown") {
    return { kind: "unavailable" };
  }
  if (locals.status === "guest") {
    const next = safeNext(currentPath) ?? "/admin";
    return { kind: "guest", location: `/auth/discord?next=${encodeURIComponent(next)}` };
  }
  if (!locals.session) return { kind: "unavailable" };
  if (!locals.session.moderator) return { kind: "forbidden" };
  return {
    kind: "pass",
    actor: { id: locals.session.userId, username: locals.session.username },
  };
}
