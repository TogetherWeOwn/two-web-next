// Admin guard (W11 M1 + M5). Ports three legacy behaviours:
// - Gate: no panel login page — guests fall into site Discord OAuth; a
//   signed-in non-moderator gets 403, never a login loop (TOG-54).
//   Moderator = the session row's `moderator` bit, recomputed from Discord
//   role snowflakes at every login (src/roles.ts) and read live per request,
//   so a mid-session revocation 403s on the next *login* — not the next
//   click. Per-click Discord lookups were deliberately not ported: main's
//   settled design recomputes at login, and an extra Discord round-trip on
//   every admin click would gate the panel on Discord availability.
// - Access log: every admin READ route declares its subjects before the
//   handler finishes; the guard writes one row per request (CISO condition
//   TOG-355). Fail-closed: a log write failure refuses the read (503 under
//   enforce, the default).
// - POSTs carry the same origin check as /logout (SameSite=Lax already
//   blocks cross-site cookie sends; this refuses a forged same-shape POST
//   anyway).
//
// Session seam: the cookie carries a random token; the row in the session
// store is the session (same contract as src/index.tsx: tests inject a
// SessionStore on the env as SESSION_STORE, local/dev builds a postgres
// store from DATABASE_URL, no binding fails closed to 503). The guard reads
// the row — it never rotates: rotation is the site's per-view concern, and
// an admin read must not invalidate the cookie the moderator's other tab
// holds. Never trust a role bit from the cookie: the moderator decision is
// the server-side row bit only.

import { getSignedCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import postgres from "postgres";
import type { Env } from "../env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  type SessionStore,
  type Sql,
} from "../sessions";
import { dbFor } from "./db";
import { recordAccess } from "./store";

export type Actor = { id: string; username: string };

type EnvWithStore = Env & { SESSION_STORE?: SessionStore };

// Mirrors src/index.tsx's storeFor (kept local: index does not export it,
// and the admin slice must not import the site's route module). One pooled
// connection max, idle sockets close themselves; no binding fails closed.
const migratedUrls = new Set<string>();

export async function sessionStoreFor(c: { env: Env }): Promise<SessionStore | null> {
  const injected = (c.env as EnvWithStore).SESSION_STORE;
  if (injected) return injected;
  const url = c.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 }) as unknown as Sql;
  if (!migratedUrls.has(url)) {
    await migrate(sql);
    migratedUrls.add(url);
  }
  return createPostgresSessionStore(sql);
}

/** No store at all (unit tests without the seam): sessions cannot resolve. */
export function memoryStoreForTests(): SessionStore {
  return createMemorySessionStore();
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

/**
 * Optional overrides (tests only — production resolves through the seams):
 * a SessionStore for session resolution, and a Db for the access log. The
 * two are independent: live route tests resolve sessions from the memory
 * store while reading/writing admin tables in Postgres.
 */
export type AdminOverrides = { sessionStore?: SessionStore; db?: import("../db/index").Db };

export function adminGuard(overrides?: AdminOverrides | SessionStore) {
  return async (
    c: Context<{ Bindings: Env; Variables: { adminActor: Actor; access: AccessDecl } }>,
    next: Next,
  ) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
    }

    const token = await getSignedCookie(c, c.env.SESSION_SECRET, "__Host-two_session");
    // Guest: into the site Discord OAuth flow, like everyone else. There is
    // no panel login page.
    if (!token) return c.redirect("/auth/discord", 302);

    // A bare SessionStore keeps working as the single override (guard pins).
    const isStore = (o: unknown): o is SessionStore =>
      typeof o === "object" && o !== null && "get" in o && "create" in o;
    const sessionOverride = isStore(overrides) ? overrides : overrides?.sessionStore;
    const dbOverride = isStore(overrides) ? undefined : overrides?.db;

    let actor: Actor | null = null;
    try {
      const resolved = sessionOverride ?? (await sessionStoreFor(c));
      if (!resolved) throw new Error("admin needs a session store; refusing to decide without one");
      const row = await resolved.get(await hashToken(token));
      // Signed in, not a moderator: 403, not a login loop (TOG-54).
      if (row?.moderator) actor = { id: row.userId, username: row.username };
    } catch (err) {
      console.error("admin guard could not resolve the session; refusing.", { error: String(err) });
      return c.text("Admin temporarily unavailable", 503);
    }
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
      const db = dbOverride ?? (sessionOverride ? null : await dbFor(c));
      if (!db && !sessionOverride && !dbOverride) throw new Error("admin needs a database for the access log");
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
        // The handler already finalized its response. Returning a new response
        // here is ignored by Hono's compose; replace it before it leaves.
        c.res = c.text("Member data is temporarily unavailable.", 503);
        c.header("cache-control", "private, no-store");
      }
    }
  };
}
