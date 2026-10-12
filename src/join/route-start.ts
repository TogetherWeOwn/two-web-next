// GET /join/discord (structural split; zero behavior change).
//
// Throttle, then 302 to Discord with identify+guilds.join. Issues the journey
// (ten-minute state + optional source/next cookies) before redirecting.
import type { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { authorizeUrl } from "../discord";
import type { Env } from "../env";
import { hashToken } from "../sessions";
import { safeNext, sanitizeSource } from "./service";
import {
  JOIN_NEXT_COOKIE,
  JOIN_SOURCE_COOKIE,
  JOIN_STATE_COOKIE,
  JOURNEY_TTL_SECONDS,
  joinRedirectUri,
  STATE_TTL_SECONDS,
  throttled,
  type JoinSessionHooks,
} from "./route-shared";

export function registerJoinStartRoutes(app: Hono<{ Bindings: Env }>, hooks: JoinSessionHooks) {
  app.get("/join/discord", async (c) => {
    const limited = await throttled(c);
    if (limited) return limited;
    const source = sanitizeSource(c.req.query("source"));
    const next = safeNext(c.req.query("next"));
    const state = crypto.randomUUID();
    const store = await hooks.storeFor(c);
    await store.journeys.sweepExpired();
    if (!(await store.journeys.issue(await hashToken(state), "join")))
      return c.redirect("/join", 302);
    if (source) {
      await setSignedCookie(c, JOIN_SOURCE_COOKIE, source, c.env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: JOURNEY_TTL_SECONDS,
      });
    }
    if (next) {
      await setSignedCookie(c, JOIN_NEXT_COOKIE, next, c.env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: JOURNEY_TTL_SECONDS,
      });
    }
    await setSignedCookie(c, JOIN_STATE_COOKIE, state, c.env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: STATE_TTL_SECONDS,
    });
    c.header("cache-control", "no-store, private");
    return c.redirect(authorizeUrl(c.env.DISCORD_CLIENT_ID, joinRedirectUri(c.env), state), 302);
  });
}
