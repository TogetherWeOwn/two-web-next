// Session gate, member-access-log boundary and failure handler for the profile
// routes. Split out of src/profiles/routes.tsx; the posture they enforce is
// recorded in that file's header. registerGate must run before any profile
// route is registered: the middleware only covers routes added after it.
import type { Next } from "hono";
import { getSignedCookie } from "hono/cookie";
import { sessionStoreFor } from "../admin/guard";
import { enableAuthStatus } from "../auth-status";
import { alertRequestError } from "../alerts";
import { isDatabaseUnavailable } from "../db/errors";
import { databaseUnavailable } from "../errors";
import { bufferedMemberText, memberReadBoundary } from "../member-reads";
import { bounceToLogin, takeJoinResult } from "../return-journey";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken } from "../sessions";
import { requestRoute, safeRequestId } from "../request-log";
import type { Ctx, ProfileApp, ProfileDeps, Viewer } from "./routes-shared";
import type { ProfileStores } from "./routes-stores";

export function profileError(error: Error, c: Ctx) {
  alertRequestError(error, {
    method: c.req.method,
    route: requestRoute(c),
    requestId: c.get("requestId"),
  });
  console.error("Profile request failed; refusing contents.", {
    exception: error.constructor.name,
    request_id: safeRequestId(c.get("requestId")),
  });
  // Writes have no read boundary: a classified outage gets the shared
  // envelope here. Reads are replaced by the boundary either way.
  if (isDatabaseUnavailable(error)) return databaseUnavailable(c);
  return bufferedMemberText(c, "Member data is temporarily unavailable.", 503);
}

/** Write bypass: PATCH/POST /members/:user enforce the body cap before any
 * session work. The global gate skips them here; the write routes run the same
 * gate explicitly after their body limiter. Reads keep the global gate. */
export function isProfileWriteRequest(c: Pick<Ctx, "req">): boolean {
  const method = c.req.method;
  if (method !== "PATCH" && method !== "POST") return false;
  return c.req.path.startsWith("/members/");
}

/** Gate: guest → OAuth, non-member → 403, store failure → 503 (fail closed). */
export function memberGate(deps: ProfileDeps) {
  return async (c: Ctx, next: Next) => {
    c.header("cache-control", "private, no-store");
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    // Guest: record where they were headed (legacy url.intended), then into
    // the site OAuth flow — the callback returns them here after sign-in.
    // Malformed bearers are guests too, with zero store reads (shape-checked
    // before any hash/store call).
    if (!isValidSessionToken(token)) return bounceToLogin(c);
    let viewer: Viewer | null = null;
    try {
      const sessions = deps.sessionStore ?? (await sessionStoreFor(c));
      if (!sessions) throw new Error("no session store");
      const row = await sessions.get(await hashToken(token));
      if (row) {
        viewer = {
          id: row.userId,
          username: row.username,
          member: row.member,
          moderator: row.moderator,
        };
        if (row.member && c.req.method === "GET")
          await enableAuthStatus(c, sessions, await hashToken(token));
      }
    } catch (err) {
      // Bounded like every other session-failure log: class name only — driver
      // messages can carry DSN fragments (TOG-10355).
      console.error("profiles could not resolve the session; refusing.", {
        exception: err instanceof Error ? err.constructor.name : "unknown",
      });
      // Same private cache policy as every other response from this slice.
      c.res = await databaseUnavailable(c);
      c.header("cache-control", "private, no-store");
      return c.res;
    }
    // A cookie whose row is gone (revoked/expired/rotated) is a guest — same
    // intended-page bounce so the round trip lands them back here.
    if (!viewer) return bounceToLogin(c);
    if (!viewer.member) return c.text("Forbidden", 403);
    c.set("viewerId", viewer.id);
    c.set("viewer", viewer);
    await next();
    c.header("cache-control", "private, no-store");
  };
}

export function registerGate(app: ProfileApp, deps: ProfileDeps, { sinkFor }: ProfileStores) {
  const gate = memberGate(deps);

  // Bare /members is retired (URL freeze), not a member index: answer the
  // frozen 404 before the gate below. Registered first so the "/members/*"
  // middleware never bounces it to OAuth; members get the same 404, with no
  // session read, no cookie and no access-log row. Hono also serves HEAD here.
  // Strict routing distinguishes the trailing slash; retire that form too.
  // https://hono.dev/docs/api/hono#strict-mode
  app.get("/members", (c) => c.notFound());
  app.get("/members/", (c) => c.notFound());

  // Scoped to this slice's paths: the app is mounted at "/", so a "*" here
  // would gate every route in the worker. Profile writes bypass the global
  // gate so their body cap runs first; registerWriteRoutes runs this same
  // gate explicitly after its limiter.
  for (const path of ["/profile", "/members/*"]) {
    app.use(path, async (c, next) => {
      if (isProfileWriteRequest(c)) return next();
      return gate(c, next);
    });
    app.use(path, async (c, next) => {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
      await memberReadBoundary(
        c,
        {
          viewer: c.get("viewer").id,
          resource: "profile",
          action: "view",
          route: path === "/profile" ? "profile" : "profiles.show",
        },
        async (entry) => {
          const sink = await sinkFor(c);
          if (!sink) throw new Error("no access-log sink");
          return sink(entry);
        },
        next,
        databaseUnavailable,
      );
      // Refused contents must leave the one-shot confirmation pending.
      if (c.res.status === 200) await takeJoinResult(c);
    });
  }
}
