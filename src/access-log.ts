// `member-access-log` middleware (W7, ports RecordMemberDataAccess): a route
// that reads member data declares its subjects with `c.set("access", …)`; this
// middleware writes ONE row per request after the handler and before the
// response leaves. A read that cannot be recorded is not served: 503 under
// enforce (the default), degrade-with-a-loud-log plus one rate-limited page
// when MEMBER_ACCESS_LOG_ENFORCE is "false". The admin guard
// (src/admin/guard.ts) carries the same contract inline for the panel; this is
// the reusable form for member-facing routes.

import type { Context, Next } from "hono";
import { alertRequestError } from "./alerts";
import type { Env } from "./env";
import { databaseUnavailable } from "./errors";

export type AccessDecl = {
  resource: string;
  action: "view" | "list";
  route: string;
  subjects: string[];
};

export type AccessEntry = {
  viewerDiscordId: string;
  viewerUserId: string | null;
  resource: string;
  action: string;
  subjectUserIds: string[];
  route: string | null;
};

/** Returns true when a row was written (the viewer is never their own subject). */
export type AccessSink = (entry: AccessEntry) => Promise<boolean>;

/**
 * Audit-wait deadline (CISO decision): a member read is released only after
 * its audit row is written, and that wait is bounded by this finite timeout.
 * Rationale: a hung audit must not hang the read forever (liveness) and must
 * never release private contents (fail closed with the existing sanitized
 * 503/private-no-store outage response). 5 s outlasts the DB-side
 * statement/lock cap (2 s in src/admin/store-access.ts) plus connect/BEGIN on
 * the shared max:1 pool, while bounding a never-settling sink well below the
 * 60 s outer test bound and worker limits. Driven by setTimeout +
 * Promise.race so fake timers govern it deterministically.
 *
 * A response deadline does not cancel database work: a late INSERT may still
 * commit server-side after the response was refused. The sink is still called
 * exactly once (no retry/replay); late settlement is inert.
 */
export const MEMBER_ACCESS_AUDIT_TIMEOUT_MS = 5000;

export function enforceOn(env: Env): boolean {
  const raw = env.MEMBER_ACCESS_LOG_ENFORCE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

type Vars = { viewerId: string; access: AccessDecl };

/**
 * Bound an audit write by MEMBER_ACCESS_AUDIT_TIMEOUT_MS. Late settlement is
 * inert: the sink is awaited exactly once, a late rejection is consumed here
 * so it cannot surface as an unhandled rejection, and the caller decides the
 * timeout response (the race winner) without the late write altering it.
 */
export async function withAccessAuditDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Consume a late rejection after the deadline has won (house pattern: the
  // race below also observes it, this guarantees no unhandled rejection).
  pending.catch(() => {});
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("member access audit timed out")),
      MEMBER_ACCESS_AUDIT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function memberAccessLog(sink: (c: { env: Env }) => Promise<AccessSink | null>) {
  return async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
    await next();
    if (c.res.status >= 400) return;
    let decl: AccessDecl | undefined;
    try {
      decl = c.get("access");
    } catch {
      decl = undefined;
    }
    if (!decl) return;
    const viewer = c.get("viewerId");
    try {
      const write = await sink(c);
      if (!write) throw new Error("no access-log sink");
      await withAccessAuditDeadline(
        write({
          viewerDiscordId: viewer,
          viewerUserId: viewer,
          resource: decl.resource,
          action: decl.action,
          subjectUserIds: decl.subjects,
          route: decl.route,
        }),
      );
    } catch (err) {
      // Class name only: an error message can carry the failed INSERT's bindings.
      console.error("Member data access could not be recorded; refusing to serve the read.", {
        route: decl.route,
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
      if (enforceOn(c.env)) {
        c.res = await databaseUnavailable(c);
        c.header("cache-control", "private, no-store");
      } else {
        // Degraded serve-unaudited: the read goes out without its audit row,
        // so page once per class@route through the existing alert path. Class
        // only, route + request id; never bindings, messages, SQL or payloads.
        alertRequestError(err, {
          method: c.req.method,
          route: decl.route,
          requestId: c.get("requestId"),
        });
      }
    }
  };
}
