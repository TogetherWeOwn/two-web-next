// GET /join/callback.
// Journey cookies are cleared only after one-use admission. A stale, stray,
// or unadmitted callback leaves the current journey cookies in place.
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
import { isDatabaseUnavailable } from "../db/errors";
import { hasOversizedOAuthParams } from "../oauth-code-state-length";
import type { Env } from "../env";
import { inviteDestination } from "../invite";
import { recordJoinResult } from "../return-journey";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { hashToken } from "../sessions";
import { safeRequestId } from "../request-log";
import { finishJoin, liveBotAdd, recordAttempt, safeNext, sanitizeSource } from "./service";
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
    // Inbound length bound, decided before the shared join throttle spend:
    // the query is synchronously readable (no async body read), so the gate
    // costs no throttle INSERT of its own. A non-error oversized hit still
    // renders the expired-link recovery in the existing branch below —
    // recovery copy and the log line are unchanged — but
    // it spends zero budget, so a non-error oversized probe cannot burn the
    // funnel's budget and the refusal survives an exhausted budget. `error`
    // callbacks keep today's path (they spend throttle), and the
    // normal-exhausted 429 is unchanged.
    const gateCode = c.req.query("code");
    const gateState = c.req.query("state");
    const gateError = c.req.query("error");
    const oversizedParams = !gateError && hasOversizedOAuthParams(gateCode, gateState);
    const limited = oversizedParams ? null : await throttled(c);
    if (limited) return limited;
    const sql = await joinStore(c);
    if (oversizedParams && sql) {
      // postgres clients connect lazily. Preserve the throttle's classified
      // outage 503 without counting, locking, inserting or pruning any hits.
      // Like throttled(), an unclassified query failure does not refuse.
      await sql`SELECT 1`.catch((err: unknown) => {
        if (isDatabaseUnavailable(err)) throw err;
      });
    }
    // getSignedCookie answers false on a bad signature: not a string, not a source.
    // Sanitized like GET /join/discord: a correctly-signed but hostile value
    // leaves no trace in the retry href, the attempt row, or the log line.
    const rawSource = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_SOURCE_COOKIE);
    const source = sanitizeSource(typeof rawSource === "string" ? rawSource : null);
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
    // An admitted callback clears the journey cookies, so its retry href is
    // where the return target and attribution survive: safe next/source values
    // re-mint the start URL (mirroring GET /join/discord?next=&source=), while
    // hostile or absent values keep the bare URL. Both already passed their
    // sanitizers above, so hostile stays dropped.
    const retryUrl =
      next && source
        ? `/join/discord?next=${encodeURIComponent(next)}&source=${encodeURIComponent(source)}`
        : next
          ? `/join/discord?next=${encodeURIComponent(next)}`
          : source
            ? `/join/discord?source=${encodeURIComponent(source)}`
            : "/join/discord";
    const recover = (title: string, message: string, status: 200 | 503 = 200) =>
      render.recovery(
        c,
        { title, message, retryUrl, retryLabel: "Try again", inviteUrl: invite },
        status,
      );

    const rawExpected = await getSignedCookie(c, c.env.SESSION_SECRET, JOIN_STATE_COOKIE);
    const expected = typeof rawExpected === "string" ? rawExpected : null;
    // The values the gate read above the throttle spend. `c.req.query()` is
    // a first-wins projection of the immutable request URL, and nothing
    // awaited between the gate and here rewrites that URL (the throttle
    // spends shared budget and prunes hits but never touches the request,
    // joinStore reads the env, getSignedCookie reads the Cookie header) — so
    // reusing the gate reads equals re-reading without further scans, and the
    // gate and the branches below can never see different values.
    const code = gateCode;
    const state = gateState;
    const oauthError = gateError;
    // Same inbound bound as the auth callback: refuse oversized code/state
    // before any journey consume, exchange, or session work. `oversizedParams`
    // was already decided above the throttle spend from these same values, so
    // this branch keeps the existing expired-link recovery with its bounded
    // log line under its own class (replay keeps InvalidState).
    if (oversizedParams) {
      console.warn("discord token exchange failed on the join journey", {
        exception: "OversizedOAuthParams",
        source,
        outcome: "expired",
        request_id: safeRequestId(c.get("requestId")),
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

    // Only an admitted callback owns the jar's journey. A stale tab or stray
    // hit must leave the newer tab's state and return intent intact.
    if (admitted) clearJourney();

    // They pressed Cancel on the consent screen, or Discord answered the
    // admitted approval with an error: nothing to exchange. Unadmitted errors
    // use the generic expired recovery below, never provider details.
    if (admitted && oauthError) {
      const denied = oauthError === "access_denied";
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
        request_id: safeRequestId(c.get("requestId")),
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
        request_id: safeRequestId(c.get("requestId")),
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
