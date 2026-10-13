import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../src/admin/db";
import { readCounts } from "../../../src/counts";
import { discordEventsSource } from "../../../src/events/discord-transients-source";
import { loadHomeUpcomingMerged } from "../../../src/events/reads";
import { listVisibleFeatured } from "../../../src/featured";
import { parseHomeNotice, resolveHomeFlash } from "../../../src/home-copy";
import { inviteDestination } from "../../../src/invite";

// Server-rendered only: the Hono homepage ships no page JavaScript (its
// islands are absent here), so the Kit page carries no hydration bundle that
// the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/index.tsx GET /):
// session-aware header from the read-only bridge locals, join notice from
// ?n=, read-only join flash (consumption stays Hono-side until enablement,
// so a Kit read can never double-spend it), bot-owned counts, merged
// upcoming events and visible featured rows. Every panel degrades
// independently — the shared readers never throw — and the response stays
// viewer-specific (private, no-store).
export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  const session = locals.status === "authenticated" ? (locals.session ?? null) : null;
  // An outage is never reported as a logout: unknown renders the guest
  // header with the invite-link hero, exactly like Hono's sessionUnavailable.
  const sessionUnavailable = locals.status === "unknown";
  const notice = parseHomeNotice(url.searchParams.get("n"));
  const joinResult = resolveHomeFlash(notice, locals.joinResult ?? null);
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
  };
};
