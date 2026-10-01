// GET /join, /join/discord, /join/callback (W6).
//
// The legacy one-click journey's own URLs. The OAuth mechanics are the same
// identify+guilds.join round trip the /auth/discord flow already runs; these
// routes add the journey around it: a landing page, source attribution, a
// safe post-join return, the 10/min throttle, and one join_attempts row per
// terminal path. The synchronous bot call (service.finishJoin) owns the live
// token for exactly one attempt — it is never stored, logged or queued.
//
// Failure posture mirrors legacy: anything recoverable (denied consent,
// expired code, bot unreachable, bot refusal) renders the recovery page with
// the retry URL and the invite fallback, never a bare redirect — after a round
// trip to Discord and back a banner is easy to miss.
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { authorizeUrl, exchangeCode, fetchUser } from "../discord";
import { rateLimitExceeded } from "../errors";
import type { Env } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { inviteDestination } from "../invite";
import { recordJoinResult } from "../return-journey";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { hashToken, type SessionStore, type Sql } from "../sessions";
import {
  JOIN_THROTTLE_BUCKET,
  JOIN_THROTTLE_PER_MINUTE,
  checkJoinThrottle,
  finishJoin,
  liveBotAdd,
  migrateJoin,
  recordAttempt,
  safeNext,
  sanitizeSource,
  type BotAdd,
} from "./service";

export const JOIN_STATE_COOKIE = "__Host-two_join_state";
export const JOIN_SOURCE_COOKIE = "__Host-two_join_source";
export const JOIN_NEXT_COOKIE = "__Host-two_join_next";
const STATE_TTL_SECONDS = 600;
const JOURNEY_TTL_SECONDS = 600;

/** Injectable at the call site (`{...env, JOIN_STORE: …}`), like SESSION_STORE. */
export type JoinRouteDeps = {
  store?: () => Promise<Sql | null>;
  bot?: (botToken: string) => BotAdd;
  now?: () => number;
};
export type EnvWithJoin = Env & { JOIN_DEPS?: JoinRouteDeps };

type Ctx = Context<{ Bindings: Env }>;

// Postgres access for the journey. Same posture as sessions (`storeFor` in the
// app module): tests inject a client through JOIN_DEPS; runtime uses the
// explicit DATABASE_URL or the Hyperdrive DB binding. With neither, throttle
// and attempts degrade to no-ops so the DB-free funnel stays up.
const migratedJoinUrls = new Set<string>();

async function joinStore(c: Ctx): Promise<Sql | null> {
  const deps = (c.env as EnvWithJoin).JOIN_DEPS;
  if (deps?.store) return deps.store();
  const url = databaseUrl(c.env);
  if (!url) return null;
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  if (!migratedJoinUrls.has(url)) {
    await migrateJoin(sql);
    migratedJoinUrls.add(url);
  }
  return sql;
}

const joinRedirectUri = (env: Env) => `${env.APP_URL}/join/callback`;

function currentMinute(now: () => number): number {
  return Math.floor(now() / 60000);
}

async function throttled(c: Ctx): Promise<Response | null> {
  const deps = (c.env as EnvWithJoin).JOIN_DEPS;
  const verdict = await checkJoinThrottle(
    await joinStore(c),
    `${JOIN_THROTTLE_BUCKET}:${currentMinute(deps?.now ?? Date.now)}`,
    JOIN_THROTTLE_PER_MINUTE,
  );
  if (!verdict.limited) return null;
  return rateLimitExceeded(c, verdict.retryAfter);
}

// Session + issue helpers live in the main app module (the join router is
// mounted on it). They are passed in at mount time to keep this module free of
// the import cycle.
export type JoinSessionHooks = {
  storeFor: (c: Ctx) => Promise<SessionStore>;
  issueSession: (
    c: Ctx,
    store: SessionStore,
    row: { userId: string; username: string; avatar: string | null; member: boolean; moderator: boolean },
  ) => Promise<void>;
};

export type JoinPageProps = { inviteUrl: string; widgetUrl: string | null; next?: string | null; appUrl: string };
export type RecoveryProps = {
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
};

// Rendering lives with the app module (it owns the JSX runtime); this module
// owns the journey flow. Both callbacks receive the request context so they
// can answer with the right status.
export type JoinRender = {
  joinPage: (c: Ctx, props: JoinPageProps) => Response | Promise<Response>;
  recovery: (c: Ctx, props: RecoveryProps, status?: 200 | 503) => Response | Promise<Response>;
};

export function registerJoinRoutes(app: Hono<{ Bindings: Env }>, hooks: JoinSessionHooks, render: JoinRender) {
  // `/join` — the journey page. Database-free leaf like /about: it must stay
  // 200 when everything behind it is down (a 500 here loses the member).
  app.get("/join", (c) => {
    const guildId = c.env.DISCORD_GUILD_ID;
    const widgetUrl =
      typeof guildId === "string" && /^\d{10,25}$/.test(guildId)
        ? `https://discord.com/widget?id=${guildId}&theme=dark`
        : null;
    // A safe `?next=` survives onto the one-click link; a hostile one leaves
    // no trace in the HTML (legacy ReturnToPageTest; safeNext pins the guard).
    const next = safeNext(c.req.query("next"));
    return render.joinPage(c, { inviteUrl: c.env.DISCORD_INVITE_URL, widgetUrl, next, appUrl: c.env.APP_URL });
  });

  app.get("/join/discord", async (c) => {
    // An unconfigured bot cannot accept a handoff. Do not send the browser to
    // Discord or mint a journey that could later produce a member session.
    if (c.env.DISCORD_BOT_TOKEN.trim() === "") return c.redirect("/join", 302);
    const limited = await throttled(c);
    if (limited) return limited;
    const source = sanitizeSource(c.req.query("source"));
    const next = safeNext(c.req.query("next"));
    const state = crypto.randomUUID();
    const store = await hooks.storeFor(c);
    await store.journeys.sweepExpired();
    if (!await store.journeys.issue(await hashToken(state), "join")) return c.redirect("/join", 302);
    if (source) {
      await setSignedCookie(c, JOIN_SOURCE_COOKIE, source, c.env.SESSION_SECRET, {
        path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: JOURNEY_TTL_SECONDS,
      });
    }
    if (next) {
      await setSignedCookie(c, JOIN_NEXT_COOKIE, next, c.env.SESSION_SECRET, {
        path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: JOURNEY_TTL_SECONDS,
      });
    }
    await setSignedCookie(c, JOIN_STATE_COOKIE, state, c.env.SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: STATE_TTL_SECONDS,
    });
    c.header("cache-control", "no-store, private");
    return c.redirect(authorizeUrl(c.env.DISCORD_CLIENT_ID, joinRedirectUri(c.env), state), 302);
  });

  app.get("/join/callback", async (c) => {
    const limited = await throttled(c);
    if (limited) return limited;
    const sql = await joinStore(c);
    // getSignedCookie answers false on a bad signature: not a string, not a source.
    const rawSource = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_SOURCE_COOKIE);
    const source = typeof rawSource === "string" ? rawSource : null;
    const rawNext = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_NEXT_COOKIE);
    const next = safeNext(typeof rawNext === "string" ? rawNext : null);
    const clearJourney = () => {
      deleteCookie(c, JOIN_STATE_COOKIE, { path: "/", secure: true });
      deleteCookie(c, JOIN_SOURCE_COOKIE, { path: "/", secure: true });
      deleteCookie(c, JOIN_NEXT_COOKIE, { path: "/", secure: true });
    };
    // Sanitized like /discord: a bad DISCORD_INVITE_URL renders the
    // hardcoded fallback, never a hostile or relative href (legacy
    // JoinCallbackFailureTest "recovery uses static invite when none is configured").
    const invite = inviteDestination(c.env.DISCORD_INVITE_URL);
    const recover = (title: string, message: string, status: 200 | 503 = 200) =>
      render.recovery(c, { title, message, retryUrl: "/join/discord", retryLabel: "Try again", inviteUrl: invite }, status);

    const rawExpected = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_STATE_COOKIE);
    const expected = typeof rawExpected === "string" ? rawExpected : null;
    clearJourney();
    const code = c.req.query("code");
    const state = c.req.query("state");
    const store = state && expected && state === expected ? await hooks.storeFor(c).catch(() => null) : null;
    const admitted = store && await store.journeys.consume(await hashToken(state!), "join").catch(() => false);

    // They pressed Cancel on the consent screen, or Discord answered the
    // approval with an error: nothing to exchange. Legacy renders the recovery
    // page (not a redirect) and never echoes Discord's error_description.
    if (c.req.query("error")) {
      const denied = c.req.query("error") === "access_denied";
      if (admitted) await recordAttempt(sql, { outcome: "denied", source, requestId: null, discordId: null });
      return recover(
        denied ? "Join cancelled" : "Join didn't complete",
        denied
          ? "You cancelled the Discord approval, so we couldn't add you to the server. Try again, or use the invite link below."
          : "Discord didn't complete the approval. Try again, or use the invite link below.",
      );
    }

    if (!admitted || !store || !code) {
      if (admitted) await recordAttempt(sql, { outcome: "error", source, requestId: null, discordId: null });
      return recover("Join link expired", "That join link expired. Approvals last ten minutes — try again below.");
    }
    if (c.env.DISCORD_BOT_TOKEN.trim() === "") {
      await recordAttempt(sql, { outcome: "degraded", source, requestId: null, discordId: null });
      return recover("Automatic join is unavailable", "Use the invite link below to join the server directly.");
    }

    // The exchange is the one place the live token exists. It is exchanged,
    // used once below, and dropped: never stored, never logged, never queued.
    let accessToken: string;
    let user;
    try {
      accessToken = await exchangeCode(
        code, c.env.DISCORD_CLIENT_ID, c.env.DISCORD_CLIENT_SECRET, joinRedirectUri(c.env),
      );
      user = await fetchUser(accessToken);
    } catch {
      await recordAttempt(sql, { outcome: "error", source, requestId: null, discordId: null });
      return recover(
        "Discord is unreachable",
        "We couldn't reach Discord to complete the join. Try again in a moment, or use the invite link below.",
        503,
      );
    }

    const deps = (c.env as EnvWithJoin).JOIN_DEPS;
    const bot = deps?.bot ? deps.bot(c.env.DISCORD_BOT_TOKEN) : liveBotAdd(c.env.DISCORD_BOT_TOKEN);
    const done = await finishJoin(bot, c.env.DISCORD_GUILD_ID, user.id, accessToken, next);
    // The live token's last use was inside finishJoin. From here on only the
    // four safe columns travel: outcome, source, request_id, discord_id.
    if (done.kind === "recoverable") {
      await recordAttempt(sql, { outcome: done.outcome, source, requestId: done.requestId, discordId: user.id });
      return recover(
        "We couldn't add you automatically",
        "You're nearly there — use the invite link below to join the server directly.",
      );
    }

    await recordAttempt(sql, { outcome: done.outcome, source, requestId: done.requestId, discordId: done.discordId });

    // Join never writes `is_moderator`: only login recomputes it from Discord
    // roles, and join's scopes cannot read roles. Here the bot-token recompute
    // already runs (same call as /auth/discord), so the flag is fresh —
    // recompute, fail closed, sign in.
    const moderator = await recomputeModerator({
      guildId: c.env.DISCORD_GUILD_ID,
      userId: user.id,
      botToken: c.env.DISCORD_BOT_TOKEN,
      moderatorRoleIds: parseModeratorRoleIds(c.env.DISCORD_MODERATOR_ROLE_IDS),
    });
    await hooks.issueSession(c, store, {
      userId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar,
      member: true,
      moderator,
    });
    // One-shot confirmation (legacy join_result flash): the first of /, /join
    // or /profile renders the added/already-member banner and consumes it.
    if (done.outcome === "added" || done.outcome === "already_member") {
      await recordJoinResult(c, done.outcome);
    }
    return c.redirect(done.redirect, 302);
  });
}

