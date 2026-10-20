// GET /join/discord (structural split; zero behavior change).
//
// Throttle, then 302 to Discord with identify+guilds.join. Issues the journey
// (ten-minute state + optional source/next cookies) before redirecting.
import type { Hono } from "hono";
import { deleteCookie, setSignedCookie } from "hono/cookie";
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
    // The fallback target is the only place the retry intent survives: safe
    // next/source values ride back onto /join. The query encoding matches the
    // callback retry href; the path is the journey page, which puts both
    // values back on the one-click link. Hostile or absent values keep the
    // bare target. Both already passed their sanitizers above.
    const fallback =
      next && source
        ? `/join?next=${encodeURIComponent(next)}&source=${encodeURIComponent(source)}`
        : next
          ? `/join?next=${encodeURIComponent(next)}`
          : source
            ? `/join?source=${encodeURIComponent(source)}`
            : "/join";
    const state = crypto.randomUUID();
    const store = await hooks.storeFor(c);
    // A transient journey-store failure degrades to /join, never a 500 —
    // the same posture as GET /auth/discord. No state cookie is minted.
    try {
      await store.journeys.sweepExpired();
      if (!(await store.journeys.issue(await hashToken(state), "join"))) {
        c.header("cache-control", "no-store");
        return c.redirect(fallback, 302);
      }
    } catch {
      c.header("cache-control", "no-store");
      return c.redirect(fallback, 302);
    }
    // Each admitted journey owns its optional intent: a missing or rejected
    // value expires a stale cookie from an abandoned earlier start (same
    // shape as the callback's clearing), so the new state can never inherit
    // another journey's return target or attribution. Mirrors
    // rememberLoginNext for the auth flow.
    if (source) {
      await setSignedCookie(c, JOIN_SOURCE_COOKIE, source, c.env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: JOURNEY_TTL_SECONDS,
      });
    } else {
      deleteCookie(c, JOIN_SOURCE_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
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
    } else {
      deleteCookie(c, JOIN_NEXT_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
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
