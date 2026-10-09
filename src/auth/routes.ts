// OAuth and login routes (R14).
//
// The Discord sign-in round trip plus the session-adjacent auth endpoints:
// GET /auth/status, GET /auth/recover, GET /auth/discord/redirect,
// GET /auth/discord, GET /auth/discord/callback, POST /logout and
// POST /auth/qa/:identity. Moved verbatim out of the app module so
// src/index.tsx only wires them; no behavior change.
//
// Session + issue helpers live in the app module (it owns the Postgres store
// selection and the roster write). They are passed in at mount time to keep
// this module free of the import cycle — the same pattern as the join router's
// JoinSessionHooks.
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { requestBodyLimit } from "../body-limit";
import { authStatus, clearAuthStatus } from "../auth-status";
import {
  addGuildMember,
  authorizeUrl,
  exchangeCode,
  failureMeta,
  fetchUser,
  isProviderOutage,
} from "../discord";
import type { Env } from "../env";
import { safeNext } from "../join/service";
import { QA_HEADER, qaEnabled, qaIdentity, qaTokenMatches } from "../qa";
import {
  consumeLoginReturn,
  JOURNEY_TTL_SECONDS,
  LOGIN_INTENDED_COOKIE,
  rememberLoginNext,
} from "../return-journey";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { hashToken, type SessionStore } from "../sessions";
import {
  AUTH_THROTTLE_PER_MINUTE,
  WRITE_THROTTLE_PER_MINUTE,
  throttle,
  throttleGuard,
} from "../throttle";
import { consumeExpiredWrite, flashExpiredWrite, recoveryLanding } from "../write-recovery";

const SESSION_COOKIE = "__Host-two_session";
const STATE_COOKIE = "__Host-two_oauth_state";
// Re-exported by src/index.tsx so existing `from "../src/index"` imports keep working.
export const STATE_TTL_SECONDS = 600;

type Ctx = Context<{ Bindings: Env }>;

const redirectUri = (env: Env) => `${env.APP_URL}/auth/discord/callback`;

export type AuthHooks = {
  storeFor: (c: Ctx) => Promise<SessionStore>;
  issueSession: (
    c: Ctx,
    store: SessionStore,
    row: {
      userId: string;
      username: string;
      avatar: string | null;
      member: boolean;
      moderator: boolean;
    },
  ) => Promise<void>;
};

export function registerAuthRoutes(app: Hono<{ Bindings: Env }>, hooks: AuthHooks) {
  app.get("/auth/status", (c) => authStatus(c, () => hooks.storeFor(c)));
  app.get("/auth/recover", recoveryLanding);

  // Legacy login links: retain only the existing guarded-next value, never OAuth input.
  app.get("/auth/discord/redirect", (c) => {
    const next = safeNext(c.req.query("next"));
    c.header("cache-control", "no-store");
    return c.redirect(
      next ? `/auth/discord?${new URLSearchParams({ next })}` : "/auth/discord",
      302,
    );
  });

  app.get("/auth/discord", async (c) => {
    // Mints the OAuth state and sets its cookie: never cacheable, whatever sits at the edge.
    c.header("cache-control", "no-store, private");
    // throttle:10,1 like the other three OAuth routes (TOG-6788 envelope; W15b
    // TOG-12088 ports OAuthReplayAndThrottleTest's all-four-routes guard). The
    // guard degrades to allow without a store, so DB-free leaves stay up.
    const limited = await throttleGuard(c, "login-redirect", AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    const state = crypto.randomUUID();
    const store = await hooks.storeFor(c).catch(() => null);
    if (!store) return c.redirect("/?n=signin_failed", 302);
    // No-DDL storeFor connects lazily, so an unreachable database surfaces on
    // first use instead of in storeFor: fail the login the same way, never a 500.
    // Both journey writes sit inside the guard: a transient failure in issue()
    // redirects to signin_failed just like one in sweepExpired().
    try {
      await store.journeys.sweepExpired();
      if (!(await store.journeys.issue(await hashToken(state), "auth")))
        return c.redirect("/?n=signin_failed", 302);
    } catch {
      return c.redirect("/?n=signin_failed", 302);
    }
    // Return journey (TOG-10356, legacy login_next): a safe ?next= rides the
    // OAuth round trip in a signed cookie; a hostile value leaves no trace.
    await rememberLoginNext(c, c.req.query("next"));
    await setSignedCookie(c, STATE_COOKIE, state, c.env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: STATE_TTL_SECONDS,
    });
    return c.redirect(authorizeUrl(c.env.DISCORD_CLIENT_ID, redirectUri(c.env), state), 302);
  });

  app.get("/auth/discord/callback", async (c) => {
    // Clears the state cookie and issues the session on success: every outcome is
    // per-visitor, so a shared cache must never keep one.
    c.header("cache-control", "no-store, private");
    const limited = await throttleGuard(c, "login-callback", AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    const expected = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    // Consume the return journey on every terminal path — success, denial and
    // failure all clear it (legacy forget on login_next + url.intended).
    const returnTo = await consumeLoginReturn(c);
    const expiredWrite = await consumeExpiredWrite(c);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const store =
      state && typeof expected === "string" && state === expected
        ? await hooks.storeFor(c).catch(() => null)
        : null;
    const admitted =
      store && (await store.journeys.consume(await hashToken(state!), "auth").catch(() => false));
    // A consent-screen refusal arrives as an `error` param before any code
    // exists. Denied gets its own sentence (the member chose this); any other
    // OAuth error keeps the generic one. Legacy DiscordLoginTest: the
    // error_description is never echoed — we render only our own copy.
    const oauthError = c.req.query("error");
    if (oauthError) {
      return c.redirect(
        oauthError === "access_denied" ? "/?n=signin_denied" : "/?n=signin_failed",
        302,
      );
    }

    if (!admitted || !store || !code) return c.redirect("/?n=signin_failed", 302);

    let accessToken: string;
    let user;
    try {
      accessToken = await exchangeCode(
        code,
        c.env.DISCORD_CLIENT_ID,
        c.env.DISCORD_CLIENT_SECRET,
        redirectUri(c.env),
      );
      user = await fetchUser(accessToken);
    } catch (err) {
      // Bounded like the join route: exception class + kind + status, never the
      // message (the token-exchange error body can quote the client secret).
      const meta = failureMeta(err);
      console.warn("discord sign-in failed", {
        exception: meta.exception,
        kind: meta.kind,
        status: meta.status,
      });
      return c.redirect(
        isProviderOutage(meta.kind) ? "/?n=signin_unavailable" : "/?n=signin_failed",
        302,
      );
    }

    // Auto-join: a guild join failure never blocks sign-in. The access token is used once here and
    // never stored.
    const botBlank = c.env.DISCORD_BOT_TOKEN.trim() === "";
    const join = botBlank
      ? "failed"
      : await addGuildMember(
          c.env.DISCORD_GUILD_ID,
          user.id,
          accessToken,
          c.env.DISCORD_BOT_TOKEN,
        ).catch(() => "failed" as const);
    if (join === "failed") console.warn("guild auto-join failed", { user: user.id });

    // Moderator recompute: roles re-read with the bot token against snowflake IDs
    // (never names). A failed lookup fails closed on the flag, never on sign-in.
    const moderator = botBlank
      ? false
      : await recomputeModerator({
          guildId: c.env.DISCORD_GUILD_ID,
          userId: user.id,
          botToken: c.env.DISCORD_BOT_TOKEN,
          moderatorRoleIds: parseModeratorRoleIds(c.env.DISCORD_MODERATOR_ROLE_IDS),
        });

    await hooks.issueSession(c, store, {
      userId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar,
      member: join !== "failed",
      moderator,
    });
    await flashExpiredWrite(c, expiredWrite);
    // A failed auto-join keeps the recovery landing even when a destination
    // was remembered: the session is a non-member one, so a member-only gate
    // (/profile, /members/*) would answer bare 403 and swallow the failure
    // explanation plus the invite fallback. The intended destination is
    // re-recorded for the retry instead of being lost. Successful joins keep
    // the legacy precedence: explicit next, then intended page, then notice.
    if (join === "failed") {
      if (returnTo) {
        await setSignedCookie(c, LOGIN_INTENDED_COOKIE, returnTo, c.env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          maxAge: JOURNEY_TTL_SECONDS,
        });
      }
      return c.redirect("/?n=join_failed", 302);
    }
    return c.redirect(returnTo ?? `/?n=${join}`, 302);
  });

  app.post(
    "/logout",
    throttle("logout", WRITE_THROTTLE_PER_MINUTE),
    requestBodyLimit("action"),
    async (c) => {
      // The route-scoped same-origin guard runs before throttling or session storage.
      const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
      // No bearer: nothing to revoke — clear cookies and leave without touching
      // session storage (stays 303 when the store is down; main #239 pins the
      // authoritative 503 only for a presented token whose revocation fails).
      if (token) {
        try {
          const store = await hooks.storeFor(c);
          await store.revoke(await hashToken(token));
        } catch {
          // Authoritative, not best-effort: a failed revocation must not clear
          // this browser's cookie as if the server row were gone.
          return c.text("Sign-out temporarily unavailable", 503);
        }
      }
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
      clearAuthStatus(c);
      await consumeExpiredWrite(c);
      return c.redirect("/", 303);
    },
  );

  // Staging-only QA seam. 404 everywhere that is not the staging host with
  // QA_AUTH_TOKEN set. Unknown identity and bad token are byte-identical 404s.
  app.post(
    "/auth/qa/:identity",
    async (c, next) => {
      if (!qaEnabled(c.env.APP_URL, c.env.QA_AUTH_TOKEN)) return c.notFound();
      await next();
    },
    throttle("qa-login", AUTH_THROTTLE_PER_MINUTE),
    requestBodyLimit("action"),
    async (c) => {
      const presented = c.req.header(QA_HEADER) ?? "";
      const ok = await qaTokenMatches(c.env.QA_AUTH_TOKEN, presented);
      const fixture = qaIdentity(c.req.param("identity") ?? "");
      if (!ok || !fixture) return c.notFound();
      const store = await hooks.storeFor(c);
      await hooks.issueSession(c, store, {
        userId: fixture.discordId,
        username: fixture.username,
        avatar: null,
        member: true,
        moderator: fixture.moderator,
      });
      return c.body(null, 204);
    },
  );
}
