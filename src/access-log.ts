// `member-access-log` middleware (W7, ports RecordMemberDataAccess): a route
// that reads member data declares its subjects with `c.set("access", …)`; this
// middleware writes ONE row per request after the handler and before the
// response leaves. A read that cannot be recorded is not served: 503 under
// enforce (the default), degrade-with-a-loud-log when MEMBER_ACCESS_LOG_ENFORCE
// is "false". The admin guard (src/admin/guard.ts) carries the same contract
// inline for the panel; this is the reusable form for member-facing routes.

import type { Context, Next } from "hono";
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

export function enforceOn(env: Env): boolean {
  const raw = env.MEMBER_ACCESS_LOG_ENFORCE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

type Vars = { viewerId: string; access: AccessDecl };

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
      await write({
        viewerDiscordId: viewer,
        viewerUserId: viewer,
        resource: decl.resource,
        action: decl.action,
        subjectUserIds: decl.subjects,
        route: decl.route,
      });
    } catch (err) {
      // Class name only: an error message can carry the failed INSERT's bindings.
      console.error("Member data access could not be recorded; refusing to serve the read.", {
        route: decl.route,
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
      if (enforceOn(c.env)) {
        c.res = await databaseUnavailable(c);
        c.header("cache-control", "private, no-store");
      }
    }
  };
}
