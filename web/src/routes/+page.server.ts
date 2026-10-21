import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../src/admin/db";
import { readCounts } from "../../../src/counts";
import { discordEventsSource } from "../../../src/events/discord-transients-source";
import { cachedFeatured, cachedHomeUpcoming } from "../../../src/home-cache";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  applyHomeResponsePolicy,
} from "../../../src/home-copy";
import { inviteDestination } from "../../../src/invite";
import { JOIN_RESULT_COOKIE } from "../../../src/return-journey";

// Server-rendered only: the Hono homepage ships no page JavaScript (its
// islands are absent here), so the Kit page carries no hydration bundle that
// the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/index.tsx GET /):
// session-aware header from the bridge locals, join notice from ?n=,
// one-shot join flash, bot-owned counts, merged upcoming events and visible
// featured rows. Every panel degrades independently — the shared readers
// never throw — and the response stays viewer-specific (private, no-store).
export const load: PageServerLoad = async ({ url, request, locals, cookies, setHeaders }) => {
  // Framework-free decisions plus the viewer-specific response policy
  // (src/home-copy.ts applyHomeResponsePolicy, mirroring Hono): an outage is
  // never reported as a logout — unknown renders the guest header with the
  // invite-link hero — ?n= validates to the six keys, a failure notice drops a
  // stale success flash, the first GET that can render the banner deletes the
  // one-shot cookie even when the banner is suppressed, and every response
  // stays private, no-store. While this entry is disabled the hook sends GET /
  // to Hono, which consumes it there; once enabled, this load is the consumer.
  const { session, sessionUnavailable, notice, joinResult } = applyHomeResponsePolicy({
    locals,
    noticeRaw: url.searchParams.get("n"),
    method: request.method,
    cookieName: JOIN_RESULT_COOKIE,
    cookies,
    setHeaders,
  });
  // The counts read degrades to hidden when the bot DB is down — never a 500
  // on the funnel top (the legacy CountsReader never-throw contract).
  const counts = await readCounts(env);
  // Guest-invariant panels ride the shared isolate-local guest cache (the same
  // module the Hono handler uses): same TTL, in-flight-retire guard and
  // never-store rules, retired by the committed featured/event mutations.
  // Each read opens its own web-DB client, like the Hono cached path.
  const [homeUpcoming, featured] = await Promise.all([
    cachedHomeUpcoming(
      env,
      () => dbFor({ env }),
      () => discordEventsSource(env),
      new Date(),
      undefined,
      // Same correlation source as the Hono request log: the validated
      // cf-ray (safeRequestId inside the reader drops anything else).
      request.headers.get("cf-ray") ?? undefined,
    ),
    cachedFeatured(env, () => dbFor({ env }), new Date()),
  ]);
  return {
    session,
    sessionUnavailable,
    notice,
    joinResult,
    inviteUrl: inviteDestination(env.DISCORD_INVITE_URL),
    appUrl: env.APP_URL,
    counts,
    upcomingEvents: homeUpcoming.items,
    eventsUnavailable: homeUpcoming.unavailable,
    featured,
    imageHosts: env.FEATURED_IMAGE_HOSTS,
    // SSR-only copy stays on the server, not in an unused shared client chunk.
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
  };
};
