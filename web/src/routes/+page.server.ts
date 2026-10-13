import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../src/admin/db";
import { readCounts } from "../../../src/counts";
import { discordEventsSource } from "../../../src/events/discord-transients-source";
import { loadHomeUpcomingMerged } from "../../../src/events/reads";
import { listVisibleFeatured } from "../../../src/featured";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  applyHomeFlashConsumption,
  resolveHomePageState,
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
  const session = locals.status === "authenticated" ? (locals.session ?? null) : null;
  // Framework-free decisions (src/home-copy.ts, mirroring Hono): an outage is
  // never reported as a logout — unknown renders the guest header with the
  // invite-link hero — ?n= validates to the six keys, and a failure notice
  // drops a stale success flash.
  const flash = locals.joinResult ?? null;
  const { sessionUnavailable, notice, joinResult } = resolveHomePageState({
    status: locals.status,
    noticeRaw: url.searchParams.get("n"),
    flash,
  });
  // One-shot flash consumption (Hono takeJoinResult parity, like the /join
  // Kit load's applyJoinPageResponsePolicy): the first GET that can render
  // the banner deletes it, even when a failure notice suppresses display —
  // otherwise the banner repeats on every reload until the cookie expires.
  // HEAD leaves it pending. While this entry is disabled the hook sends GET /
  // to Hono, which consumes it there; once enabled, this load is the consumer.
  applyHomeFlashConsumption({
    method: request.method,
    flash,
    cookieName: JOIN_RESULT_COOKIE,
    cookies,
  });
  // The counts read degrades to hidden when the bot DB is down — never a 500
  // on the funnel top (the legacy CountsReader never-throw contract).
  const counts = await readCounts(env);
  const [homeUpcoming, featured] = await Promise.all([
    loadHomeUpcomingMerged(
      () => dbFor({ env }),
      () => discordEventsSource(env),
    ),
    dbFor({ env })
      .then((db) => (db ? listVisibleFeatured(db) : []))
      .catch(() => []),
  ]);
  setHeaders({ "cache-control": "private, no-store" });
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
