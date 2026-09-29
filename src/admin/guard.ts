// Admin guard (W11 M1 + M5). Ports three legacy behaviours:
// - Gate: no panel login page — guests fall into site Discord OAuth; a
//   signed-in non-moderator gets 403, never a login loop (TOG-54).
//   Moderator = users.is_moderator, recomputed from Discord role snowflakes
//   at every login (W5 writes it; this gate reads it live per request, so a
//   mid-session revocation 403s on the next click).
// - Access log: every admin READ route declares its subjects before the
//   handler finishes; the guard writes one row per request (CISO condition
//   TOG-355). Fail-closed: a log write failure refuses the read (503 under
//   enforce, the default).
// - POSTs carry the same origin check as /logout (SameSite=Lax already
//   blocks cross-site cookie sends; this refuses a forged same-shape POST
//   anyway).
//
// Session seam: the signed-cookie JSON session is read exactly like
// src/index.tsx reads it. W5 replaces both with DB-backed sessions + the
// moderator flag; readAdminSession is where that swap lands (keep the
// moderator decision server-side: never trust a role bit from the cookie).

import { getSignedCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { users } from "../db/schema";
import type { Env, Session } from "../env";
import { dbFor } from "./db";
import { recordAccess } from "./store";

export type Actor = { id: string; username: string };

/** Test seam: resolve a session to a moderator actor without a database. */
export type Lookup = (session: Session) => Promise<Actor | null>;

// Context is widened to Variables: any so route contexts carrying adminActor
// stay assignable (hono's Context is invariant over Variables).
export async function readAdminSession(
  c: Context<{ Bindings: Env; Variables: any }>,
): Promise<Session | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, "__Host-two_session");
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

/** Production lookup: the moderator bit lives on the users row. Null db throws so the gate fails closed. */
export async function lookupModerator(session: Session, db: Db): Promise<Actor | null> {
  const [row] = await db.select().from(users).where(eq(users.id, session.id));
  if (!row?.isModerator) return null;
  return { id: row.id, username: row.username };
}

export function enforceEnabled(env: Env): boolean {
  const raw = env.MEMBER_ACCESS_LOG_ENFORCE?.trim().toLowerCase();
  // Legacy default: enforced in every environment, including local. An
  // enforcement switch off by default is off in the one place it mattered.
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/**
 * The whole guard as one ordered middleware: origin check (POST) → guest
 * redirect → moderator 403 → handler → access-log flush → no-store.
 *
 * Read routes declare what member data they surfaced via `c.set("access",
 * {...})`; the guard writes the row after the handler. Writes do not log
 * here — they write the audit trail (M7) in the store instead.
 */
export type AccessDecl = {
  resource: string;
  action: "view" | "list";
  route: string;
  subjects: string[];
};

export function adminGuard(lookup?: Lookup) {
  return async (
    c: Context<{ Bindings: Env; Variables: { adminActor: Actor; access: AccessDecl } }>,
    next: Next,
  ) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
    }

    const session = await readAdminSession(c);
    // Guest: into the site Discord OAuth flow, like everyone else. There is
    // no panel login page.
    if (!session) return c.redirect("/auth/discord", 302);

    let actor: Actor | null;
    try {
      if (lookup) {
        actor = await lookup(session);
      } else {
        const db = await dbFor(c);
        if (!db) throw new Error("admin needs a database; refusing to decide without one");
        actor = await lookupModerator(session, db);
      }
    } catch (err) {
      console.error("admin guard could not resolve the session; refusing.", { error: String(err) });
      return c.text("Admin temporarily unavailable", 503);
    }
    // Signed in, not a moderator: 403, not a login loop (TOG-54).
    if (!actor) return c.text("Forbidden", 403);
    c.set("adminActor", actor);

    await next();

    // Never let the edge cache an authenticated panel response.
    c.header("cache-control", "private, no-store");

    if (c.res.status >= 400) return;
    // get() throws in hono when the key was never set — read defensively.
    let decl: AccessDecl | undefined;
    try {
      decl = c.get("access");
    } catch {
      decl = undefined;
    }
    if (!decl) return;
    try {
      const db = lookup ? null : await dbFor(c);
      if (!db && !lookup) throw new Error("admin needs a database for the access log");
      if (db) {
        await recordAccess(db, {
          viewerDiscordId: actor.id,
          viewerUserId: actor.id,
          resource: decl.resource,
          action: decl.action,
          subjectUserIds: decl.subjects,
          route: decl.route,
        });
      }
    } catch (err) {
      // Loud, and without the subjects in it: the app log has neither the
      // access log's retention window nor its handling rules.
      console.error("Member data access could not be recorded; refusing to serve the read.", {
        route: decl.route,
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
      if (enforceEnabled(c.env)) {
        return c.text("Member data is temporarily unavailable.", 503);
      }
    }
  };
}
