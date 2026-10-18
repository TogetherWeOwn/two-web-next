// GET /join/callback (structural split; zero behavior change).
//
// Throttle, exchange, synchronous bot add, sign-in. The synchronous bot call
// (service.finishJoin) owns the live token for exactly one attempt — it is
// never stored, logged or queued.
//
// Failure posture mirrors legacy: anything recoverable (denied consent,
// expired code, bot unreachable, bot refusal) renders the recovery page with
// the retry URL and the invite fallback, never a bare redirect — after a round
// trip to Discord and back a banner is easy to miss. An expired approval
// (400 + invalid_grant, or a lost/replayed state) gets the immediate-retry
// sentence with status 200; a provider outage gets the discord-down sentence
// with 503 (legacy JoinCallbackFailureTest: status governs — a 5xx body can
// never reclassify as expired). Logs carry the exception class, the failure
// kind and the outcome — never a message, never a body.
import type { Hono } from "hono";
import { deleteCookie, getSignedCookie } from "hono/cookie";
import { DiscordError, exchangeCode, failureMeta, fetchUser } from "../discord";
import { hasOversizedOAuthParams } from "../oauth-code-state-length";
import type { Env } from "../env";
import { inviteDestination } from "../invite";
import { recordJoinResult } from "../return-journey";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { hashToken } from "../sessions";
import { safeRequestId } from "../request-log";
import { finishJoin, liveBotAdd, recordAttempt, safeNext } from "./service";
import {
  JOIN_NEXT_COOKIE,
  JOIN_SOURCE_COOKIE,
  JOIN_STATE_COOKIE,
  joinRedirectUri,
  joinStore,
  throttled,
  type EnvWithJoin,
  type JoinRender,
  type JoinSessionHooks,
} from "./route-shared";

export function registerJoinCallbackRoutes(
  app: Hono<{ Bindings: Env }>,
  hooks: JoinSessionHooks,
  render: JoinRender,
) {
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
      // Mirror the set attributes (minus maxAge): flag-less clearing
      // Set-Cookies are flagged by scanners (ZAP 10010/10054).
      deleteCookie(c, JOIN_STATE_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      deleteCookie(c, JOIN_SOURCE_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      deleteCookie(c, JOIN_NEXT_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
    };
    // Sanitized like /discord: a bad DISCORD_INVITE_URL renders the
    // hardcoded fallback, never a hostile or relative href (legacy
    // JoinCallbackFailureTest "recovery uses static invite when none is configured").
    const invite = inviteDestination(c.env.DISCORD_INVITE_URL);
    // The callback clears the journey cookies, so the retry href is the only
    // place the return target survives: a safe next re-mints the start URL
    // (mirroring GET /join?next=), while a hostile or absent value keeps the
    // bare URL. `next` already passed safeNext above, so hostile stays dropped.
    const retryUrl = next ? `/join/discord?next=${encodeURIComponent(next)}` : "/join/discord";
    const recover = (title: string, message: string, status: 200 | 503 = 200) =>
      render.recovery(
        c,
        { title, message, retryUrl, retryLabel: "Try again", inviteUrl: invite },
        status,
      );

    const rawExpected = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_STATE_COOKIE);
    const expected = typeof rawExpected === "string" ? rawExpected : null;
    clearJourney();
    const code = c.req.query("code");
    const state = c.req.query("state");
    // Same inbound bound as the auth callback: refuse oversized code/state
    // before any journey consume, exchange, or session work. Refusals keep
    // today's path, so the error param is peeked first and oversized maps to
    // the existing expired-link recovery with its bounded log line.
    if (!c.req.query("error") && hasOversizedOAuthParams(code, state)) {
      console.warn("discord token exchange failed on the join journey", {
        exception: "InvalidState",
        source,
        outcome: "expired",
      });
      return recover(
        "Join link expired",
        "That join link expired. Approvals last ten minutes — try again below.",
      );
    }
    const store =
      state && expected && state === expected ? await hooks.storeFor(c).catch(() => null) : null;
    const admitted =
      store && (await store.journeys.consume(await hashToken(state!), "join").catch(() => false));

    // They pressed Cancel on the consent screen, or Discord answered the
    // approval with an error: nothing to exchange. Legacy renders the recovery
    // page (not a redirect) and never echoes Discord's error_description.
    if (c.req.query("error")) {
      const denied = c.req.query("error") === "access_denied";
      if (admitted)
        await recordAttempt(sql, {
          outcome: "denied",
          source,
          requestId: safeRequestId(c.get("requestId")) ?? null,
          discordId: null,
        });
      return recover(
        denied ? "Join cancelled" : "Join didn't complete",
        denied
          ? "You cancelled the Discord approval, so we couldn't add you to the server. Try again, or use the invite link below."
          : "Discord didn't complete the approval. Try again, or use the invite link below.",
      );
    }

    if (!admitted || !store || !code) {
      // Lost/replayed state is legacy InvalidStateException: expired, retryable
      // now. The warning is the bounded correlation line (class only, never a
      // message) and doubles as the replay signal for this route.
      console.warn("discord token exchange failed on the join journey", {
        exception: "InvalidState",
        source,
        outcome: "expired",
      });
      if (admitted)
        await recordAttempt(sql, {
          outcome: "error",
          source,
          requestId: safeRequestId(c.get("requestId")) ?? null,
          discordId: null,
        });
      return recover(
        "Join link expired",
        "That join link expired. Approvals last ten minutes — try again below.",
      );
    }

    // The exchange is the one place the live token exists. It is exchanged,
    // used once below, and dropped: never stored, never logged, never queued.
    let accessToken: string;
    let user;
    try {
      accessToken = await exchangeCode(
        code,
        c.env.DISCORD_CLIENT_ID,
        c.env.DISCORD_CLIENT_SECRET,
        joinRedirectUri(c.env),
      );
      user = await fetchUser(accessToken);
    } catch (err) {
      // Legacy log contract: exception class + sanitized source + outcome, one
      // line, never the exception message (which can quote the secret). An
      // expired grant recovers immediately; anything else is an outage (503).
      const meta = failureMeta(err);
      const outcome = meta.kind === "expired_grant" ? "expired" : "error";
      console.warn("discord token exchange failed on the join journey", {
        exception: meta.exception,
        kind: meta.kind,
        status: meta.status,
        source,
        outcome,
      });
      await recordAttempt(sql, {
        outcome: "error",
        source,
        requestId: safeRequestId(c.get("requestId")) ?? null,
        discordId: null,
      });
      if (outcome === "expired") {
        return recover(
          "Join approval expired",
          "That Discord approval expired. Try again or use the invite below.",
        );
      }
      const recovery = await recover(
        "Discord is unreachable",
        "We couldn't reach Discord to complete the join. Try again in a moment, or use the invite link below.",
        503,
      );
      // Header only: status and copy never change. A usable 429 backoff flows
      // into `Retry-After`; absent/unusable values and every non-429 path keep
      // today's headerless response.
      const retryAfter =
        err instanceof DiscordError && err.kind === "rate_limited" ? err.retryAfter : undefined;
      if (retryAfter !== undefined) recovery.headers.set("Retry-After", String(retryAfter));
      return recovery;
    }

    const deps = (c.env as EnvWithJoin).JOIN_DEPS;
    const bot = deps?.bot ? deps.bot(c.env.DISCORD_BOT_TOKEN) : liveBotAdd(c.env.DISCORD_BOT_TOKEN);
    const done = await finishJoin(bot, c.env.DISCORD_GUILD_ID, user.id, accessToken, next);
    // The live token's last use was inside finishJoin. From here on only the
    // four safe columns travel: outcome, source, request_id, discord_id.
    if (done.kind === "recoverable") {
      await recordAttempt(sql, {
        outcome: done.outcome,
        source,
        requestId: done.requestId,
        discordId: user.id,
      });
      const recovery = await recover(
        "We couldn't add you automatically",
        "You're nearly there — use the invite link below to join the server directly.",
      );
      // Header only: status and copy never change. A usable rate-limited bot-add
      // backoff flows into `Retry-After` (same admission as the exchange 429
      // branch); absent/unusable values and every non-rate-limited path keep
      // today's headerless response.
      if (done.outcome === "rate_limited" && done.retryAfter !== undefined)
        recovery.headers.set("Retry-After", String(done.retryAfter));
      return recovery;
    }

    await recordAttempt(sql, {
      outcome: done.outcome,
      source,
      requestId: done.requestId,
      discordId: done.discordId,
    });

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
