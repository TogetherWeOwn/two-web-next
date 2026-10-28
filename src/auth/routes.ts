// The Discord sign-in round trip plus the session-adjacent auth endpoints:
// GET /auth/status, GET /auth/recover, GET /auth/discord/redirect,
// GET /auth/discord, GET /auth/discord/callback, POST /logout and
// POST /auth/qa/:identity.
//
// Session + issue helpers live in the app module (it owns the Postgres store
// selection and the roster write). They are passed in at mount time to keep
// this module free of the import cycle — the same pattern as the join router's
// JoinSessionHooks.
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { exceptionClass } from "../alerts";
import { requestBodyLimit } from "../body-limit";
import { isDatabaseUnavailable } from "../db/errors";
import { hasOversizedOAuthParams } from "../oauth-code-state-length";
import { AUTH_STATUS_COOKIE, authStatus, clearAuthStatus } from "../auth-status";
import {
  addGuildMemberDetailed,
  authorizeUrl,
  exchangeCode,
  failureMeta,
  fetchUser,
  isProviderOutage,
} from "../discord";
import type { Env } from "../env";
import { STATE_TTL_SECONDS } from "../index";
import {
  databaseUnavailable,
  outageRepresentation,
  prefersHtmlError,
  varyAccept,
} from "../error-responses";
import { safeNext } from "../join/service";
import { safeRequestId } from "../request-log";
import { QA_HEADER, qaEnabled, qaIdentity, qaTokenMatches, type QaIdentity } from "../qa";
import {
  consumeLoginReturn,
  JOURNEY_TTL_SECONDS,
  LOGIN_INTENDED_COOKIE,
  rememberLoginNext,
} from "../return-journey";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { hashToken, isValidSessionToken, REVOKE_ALL_EXCEPT, type SessionStore } from "../sessions";
import {
  AUTH_THROTTLE_PER_MINUTE,
  WRITE_THROTTLE_PER_MINUTE,
  throttle,
  throttleGuard,
} from "../throttle";
import { publicReadGuard } from "../events/routes-shared";
import {
  consumeExpiredWrite,
  flashExpiredWrite,
  reflashPendingExpiredWrite,
  recoveryLanding,
} from "../write-recovery";
import { SESSION_COOKIE } from "../session-cookie";

export { SESSION_COOKIE };
const STATE_COOKIE = "__Host-two_oauth_state";

type Ctx = Context<{ Bindings: Env }>;

declare module "hono" {
  interface ContextVariableMap {
    /** QA fixture admitted by the /auth/qa/:identity gate (stashed pre-throttle). */
    qaFixture: QaIdentity;
  }
}

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
  // Session-adjacent reads share the one public-read budget with every other
  // read: the guard runs before any session, cookie or store work, in the same
  // in-handler form as the event pages. Admitted responses are unchanged; a
  // limiter outage degrades to allow inside the guard.
  app.get("/auth/status", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    return authStatus(c, () => hooks.storeFor(c));
  });
  app.get("/auth/recover", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    return recoveryLanding(c);
  });

  // Legacy login links: retain only the existing guarded-next value, never OAuth input.
  app.get("/auth/discord/redirect", (c) => {
    const next = safeNext(c.req.query("next"));
    c.header("cache-control", "no-store, private");
    return c.redirect(
      next ? `/auth/discord?${new URLSearchParams({ next })}` : "/auth/discord",
      302,
    );
  });

  app.get("/auth/discord", async (c) => {
    // Mints the OAuth state and sets its cookie: never cacheable, whatever sits at the edge.
    c.header("cache-control", "no-store, private");
    // throttle:10,1 like the other three OAuth routes (the all-four-routes guard
    // of the legacy OAuth throttle test). The guard degrades to allow without a
    // store, so DB-free leaves stay up.
    const limited = await throttleGuard(c, "login-redirect", AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    const state = crypto.randomUUID();
    const store = await hooks.storeFor(c).catch((err: unknown) => {
      // The store never materialized, so no journey exists to sweep: one
      // class-only warn joins the signin_failed redirect for triage.
      console.warn("auth login-start store unavailable", {
        exception: exceptionClass(err),
        request_id: safeRequestId(c.get("requestId")),
      });
      return null;
    });
    if (!store) return c.redirect("/?n=signin_failed", 302);
    // No-DDL storeFor connects lazily, so an unreachable database surfaces on
    // first use instead of in storeFor: fail the login the same way, never a 500.
    // Both journey writes sit inside the guard: a transient failure in issue()
    // redirects to signin_failed just like one in sweepExpired().
    try {
      await store.journeys.sweepExpired();
      if (!(await store.journeys.issue(await hashToken(state), "auth")))
        return c.redirect("/?n=signin_failed", 302);
    } catch (err) {
      // A throwing sweep/issue is a store failure, not a refused issue (a
      // false return stays silent above): one class-only warn for triage.
      console.warn("auth login-start journey failed", {
        exception: exceptionClass(err),
        request_id: safeRequestId(c.get("requestId")),
      });
      return c.redirect("/?n=signin_failed", 302);
    }
    // Return journey (legacy login_next): a safe ?next= rides the
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
    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    // Inbound length bound: refuse oversized code/state before throttle spend
    // or any journey consume, exchange, or session work. Refusals keep today's
    // path, so the error param is peeked first and oversized maps to the
    // generic failure. Like every other stray below, an oversized hit leaves
    // the state, next and intended cookies intact for the next real hit.
    if (!oauthError && hasOversizedOAuthParams(code, state)) {
      console.warn("discord sign-in failed", {
        exception: "OversizedOAuthParams",
        request_id: safeRequestId(c.get("requestId")),
      });
      return c.redirect("/?n=signin_failed", 302);
    }
    const limited = await throttleGuard(c, "login-callback", AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    const expected = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
    const store =
      state && typeof expected === "string" && state === expected
        ? await hooks.storeFor(c).catch(() => null)
        : null;
    const admitted =
      store &&
      (await store.journeys.consume(await hashToken(state!), "auth").catch((err: unknown) => {
        // A classified store outage is not a stray callback. Preserve the
        // shared outage boundary and the unclassified-failure fallback.
        if (isDatabaseUnavailable(err)) throw err;
        return false;
      }));
    if (!admitted || !store) {
      // Stray hit (bad state, bare hit, OAuth error without a matching
      // state, replay after the journey was spent): not the real hit, so
      // consume nothing — the state, next and intended cookies plus the
      // expired-write notice all survive for the next real hit. The visible
      // answer stays the generic failure (an unadmitted denial is a failed
      // sign-in, not the cancelled-consent copy) with zero exchange calls.
      // The one exception is the denied copy, which keys off presentation
      // (a matching state cookie with an acquirable store), not journey
      // admission: a replayed denial keeps the cancelled-consent copy,
      // while a denial that never presented state keeps the generic one.
      if (oauthError === "access_denied" && store) return c.redirect("/?n=signin_denied", 302);
      return c.redirect("/?n=signin_failed", 302);
    }
    // Admitted terminal path: consume the return journey exactly once —
    // success, denial and failure all clear it (legacy forget on login_next
    // + url.intended). The failed auto-join re-record below re-sets the
    // intended cookie after this clear.
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    const returnTo = await consumeLoginReturn(c);
    const expiredWrite = await consumeExpiredWrite(c);
    // A consent-screen refusal arrives as an `error` param before any code
    // exists. Denied gets its own sentence (the member chose this); any other
    // OAuth error keeps the generic one. Legacy DiscordLoginTest: the
    // error_description is never echoed — we render only our own copy.
    // The denied copy requires a presented state (a matching state cookie
    // with an acquirable store): a denial that never presented state is
    // handled as a stray above with the generic redirect, while a replayed
    // denial keeps the denied copy in the stray branch for the same reason.
    // The journey itself is consumed exactly once above.
    if (oauthError) {
      return c.redirect(
        oauthError === "access_denied" ? "/?n=signin_denied" : "/?n=signin_failed",
        302,
      );
    }

    if (!code) return c.redirect("/?n=signin_failed", 302);

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
        request_id: safeRequestId(c.get("requestId")),
      });
      return c.redirect(
        isProviderOutage(meta.kind) ? "/?n=signin_unavailable" : "/?n=signin_failed",
        302,
      );
    }

    // Auto-join: a guild join failure never blocks sign-in. The access token is used once here and
    // never stored. An unset binding reads back as undefined (not ""), so a
    // missing token takes the same fail-closed invite-fallback path as a blank one.
    const botBlank = (c.env.DISCORD_BOT_TOKEN ?? "").trim() === "";
    const add = botBlank
      ? { result: "failed" as const }
      : await addGuildMemberDetailed(
          c.env.DISCORD_GUILD_ID,
          user.id,
          accessToken,
          c.env.DISCORD_BOT_TOKEN,
        ).catch(() => ({ result: "transport_failure" as const }));
    const join = add.result;
    // A usable 429 backoff rides to the same redirect as a header; every other
    // path stays headerless even when the provider sent one.
    const joinRetryAfter = add.result === "rate_limited" ? add.retryAfter : undefined;
    if (join !== "joined" && join !== "already_member")
      console.warn("guild auto-join failed", {
        request_id: c.get("requestId"),
        guild_id: c.env.DISCORD_GUILD_ID,
        kind: join,
      });

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
      member: join === "joined" || join === "already_member",
      moderator,
    });
    // A failed auto-join keeps the recovery landing even when a destination
    // was remembered: the session is a non-member one, so a member-only gate
    // (/profile, /members/*) would answer 403 and swallow the failure
    // explanation (the branded page keeps the invite fallback, but not the
    // reason this join failed). The intended destination is
    // re-recorded for the retry instead of being lost. The consumed
    // expired-write notice is re-set as pending (not restored) alongside it:
    // a pending notice is neither rendered nor consumed by the intermediate
    // join_failed page, so the retry-to-success callback can still consume
    // it and flash the resubmit banner. Successful joins keep the legacy
    // precedence: explicit next, then intended page, then notice.
    if (join !== "joined" && join !== "already_member") {
      if (returnTo) {
        await setSignedCookie(c, LOGIN_INTENDED_COOKIE, returnTo, c.env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          maxAge: JOURNEY_TTL_SECONDS,
        });
      }
      await reflashPendingExpiredWrite(c, expiredWrite);
      const failed = c.redirect("/?n=join_failed", 302);
      if (joinRetryAfter !== undefined) failed.headers.set("Retry-After", String(joinRetryAfter));
      return failed;
    }
    await flashExpiredWrite(c, expiredWrite);
    return c.redirect(returnTo ?? `/?n=${join}`, 302);
  });

  app.post(
    "/logout",
    // Body cap before the throttle: oversized probes 413 with zero
    // `logout`-bucket spend, even on a spent budget.
    requestBodyLimit("action"),
    throttle("logout", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      // The app-wide same-origin guard runs before throttling or session storage.
      const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
      // No bearer, or a correctly-signed but malformed bearer: nothing to
      // revoke — clear cookies and leave without touching session storage
      // (stays 303 when the store is down; main #239 pins the authoritative
      // 503 only for a well-formed presented token whose revocation fails).
      // A malformed hash could never match a live row, so revoking it is
      // useless work that would 503 a sign-out that must always clear.
      if (isValidSessionToken(token)) {
        try {
          const store = await hooks.storeFor(c);
          await store.revoke(await hashToken(token));
          const statusHash = await getSignedCookie(c, c.env.SESSION_SECRET, AUTH_STATUS_COOKIE);
          if (typeof statusHash === "string" && /^[a-f0-9]{64}$/.test(statusHash)) {
            await store.revokeLineage(statusHash);
          }
        } catch (err) {
          // Authoritative, not best-effort: a failed revocation must not clear
          // this browser's cookie as if the server row were gone. The failure
          // logs bounded facts only — the class, never the message, which can
          // quote connection details. Explicit JSON callers get the correlated
          // envelope; absent/wildcard callers keep the legacy text bytes and
          // browsers the branded page (explicit-HTML opt-in).
          console.error("logout revocation failed", {
            exception: exceptionClass(err),
            request_id: safeRequestId(c.get("requestId")),
          });
          c.header("cache-control", "no-store, private");
          varyAccept(c);
          if (prefersHtmlError(c)) return databaseUnavailable(c);
          if (outageRepresentation(c) === "application/json") {
            return databaseUnavailable(c, true);
          }
          return c.text("Sign-out temporarily unavailable", 503);
        }
      }
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
      clearAuthStatus(c);
      await consumeExpiredWrite(c);
      return c.redirect("/", 303);
    },
  );

  // Sign out everywhere: revokes every live session for the acting member,
  // including the presented one, through the existing hash-only
  // SessionStore.revokeUserSessions sweep. Same admission as POST /logout
  // (global same-origin guard, action cap before the throttle, shared
  // `logout` 30/min bucket so switching paths cannot multiply the budget),
  // same 303-to-/ landing with both __Host- cookies cleared. The shared
  // bucket is deliberate: one budget for the logout class, so a flood on
  // one path cannot buy headroom on the other; the trade-off is that a
  // spent budget 429s this emergency control too until the window rolls.
  app.post(
    "/logout/everywhere",
    // Body cap before the throttle: oversized probes 413 with zero
    // `logout`-bucket spend, even on a spent budget.
    requestBodyLimit("action"),
    throttle("logout", WRITE_THROTTLE_PER_MINUTE),
    async (c) => {
      // Sign-out responses are per-visitor: never cacheable, whatever sits
      // at the edge.
      c.header("cache-control", "no-store, private");
      // The app-wide same-origin guard runs before throttling or session storage.
      const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
      // No bearer, or a correctly-signed but malformed bearer: nothing to
      // resolve — clear cookies and leave without touching session storage
      // (stays 303 when the store is down, like POST /logout).
      if (!isValidSessionToken(token)) {
        deleteCookie(c, SESSION_COOKIE, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        });
        clearAuthStatus(c);
        await consumeExpiredWrite(c);
        return c.redirect("/", 303);
      }
      try {
        const store = await hooks.storeFor(c);
        const hash = await hashToken(token);
        const session = await store.get(hash);
        // Dead bearer (expired, unknown, revoked, past the absolute cap):
        // the acting member cannot be resolved from it, so no sweep runs —
        // clear cookies and land signed-out (idempotent 303, never 503).
        // This intentionally differs from POST /logout, which still kills
        // the presented status lineage on a dead bearer: a partial lineage
        // kill behind a 303 would misreport "everywhere" while leaving
        // other lineages live, so the dead-bearer path revokes nothing.
        if (session) {
          // REVOKE_ALL_EXCEPT matches no SHA-256 hex row, so the sweep
          // takes the presented session with the siblings (see the
          // revokeUserSessions contract in src/sessions.ts). One atomic
          // sweep: a throwing store leaves everything intact for the
          // retry, which could not re-resolve the member after a partial
          // presented-first revoke. Sweep-time semantics: sessions that
          // commit between the resolve above and the sweep below survive;
          // the window is one handler, and the next sign-in sweep (or a
          // retry) takes them. Other members are untouched (user_id scope).
          await store.revokeUserSessions(session.userId, REVOKE_ALL_EXCEPT);
        }
      } catch (err) {
        // Authoritative, not best-effort: like POST /logout, a failed
        // revocation must not clear this browser's cookies as if the
        // server rows were gone. Bounded facts only — the class, never
        // the message. Explicit JSON callers get the correlated envelope;
        // absent/wildcard callers keep the legacy text bytes and browsers
        // the branded page (explicit-HTML opt-in).
        console.error("logout everywhere revocation failed", {
          exception: exceptionClass(err),
          request_id: safeRequestId(c.get("requestId")),
        });
        c.header("cache-control", "no-store, private");
        varyAccept(c);
        if (prefersHtmlError(c)) return databaseUnavailable(c);
        if (outageRepresentation(c) === "application/json") {
          return databaseUnavailable(c, true);
        }
        return c.text("Sign-out temporarily unavailable", 503);
      }
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
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
    // Identity/token gate BEFORE the throttle (S4): unauthenticated probes 404
    // here without consuming the shared qa-login counter, so a probe flood can
    // never lock out legitimate QA logins. Same shape as /__probe/alert
    // (src/alert-probe.ts): only gated requests reach the throttle below. The
    // gate stashes the admitted fixture for the handler, so the handler issues
    // the session with no re-check to cover (a handler re-check would be an
    // uncoverable branch: the gate already admits only valid pairs).
    async (c, next) => {
      const fixture = qaIdentity(c.req.param("identity") ?? "");
      if (!fixture) return c.notFound();
      const ok = await qaTokenMatches(c.env.QA_AUTH_TOKEN, c.req.header(QA_HEADER) ?? "");
      if (!ok) return c.notFound();
      c.set("qaFixture", fixture);
      await next();
    },
    // Body cap before the throttle (but after the identity/token gate
    // above): oversized probes from admitted QA callers 413 with zero
    // `qa-login`-bucket spend, even on a spent budget.
    requestBodyLimit("action"),
    throttle("qa-login", AUTH_THROTTLE_PER_MINUTE),
    async (c) => {
      const fixture = c.get("qaFixture");
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
