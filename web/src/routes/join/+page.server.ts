import { env, waitUntil } from "cloudflare:workers";
import { dbFor } from "../../../../src/admin/db";
import { discordWidgetHealth, toPublicWidgetSnapshot } from "../../../../src/discord-widget";
import { discordEventsSource } from "../../../../src/events/discord-transients-source";
import { cachedHomeUpcoming } from "../../../../src/home-cache";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../../../../src/home-copy";
import { inviteDestination } from "../../../../src/invite";
import { applyJoinPageResponsePolicy } from "../../../../src/join/kit-page";
import { safeNext, sanitizeSource } from "../../../../src/join/service";
import type { PageServerLoad } from "./$types";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block. The widget island stays the
// existing /islands/join-widget.js plain script tag, exactly as on the Hono
// page, so the no-JS contract (one-click link, invite fallback, presence or
// fallback copy in the raw fetch body) holds byte-for-byte.

// Same reads and cache policy as the Hono handler (src/index.tsx joinPage
// render with src/join/route-page.ts inputs): outage-proof leaf, safe next,
// one-use join-result flash, background widget-health refresh, invite
// fallback. /join/discord and /join/callback stay Hono-owned.
export const csr = false;

export const load: PageServerLoad = async ({ url, request, cookies, setHeaders }) => {
  // The widget verdict is read, never awaited: a Discord outage or a hung
  // probe swaps the preview link for the static fallback without touching the
  // response path. Re-probes ride waitUntil (the same cloudflare:workers
  // request-scoped primitive web/src/lib/server/hono.ts rebuilds the Hono
  // execution context from); the verdict singleton is the isolate-shared one
  // from src/discord-widget.ts, so Hono and Kit traffic warm the same cache.
  const widgetUrl = discordWidgetHealth.url(env.DISCORD_GUILD_ID, (work) => waitUntil(work));
  // The presence snapshot rides the same verdict: it answers from the last
  // background probe and never waits on Discord, so the response path stays
  // synchronous. Read after `url` so the stale verdict schedules its one
  // re-probe before this read.
  const widgetSnapshot = discordWidgetHealth.snapshot(env.DISCORD_GUILD_ID);
  // A safe `?next=` or `?source=` survives onto the one-click link; a hostile
  // one leaves no trace in the HTML (legacy ReturnToPageTest; safeNext and
  // sanitizeSource pin the guards). Same inputs as the Hono handler.
  const next = safeNext(url.searchParams.get("next"));
  const source = sanitizeSource(url.searchParams.get("source"));
  // One-shot join confirmation (legacy join_result flash): the read-only
  // bridge verifies the signed cookie but never consumes it, so a Kit read
  // can never double-spend a flash. This landing is itself a consumer (like
  // Hono's takeJoinResult): the first GET that renders the banner deletes
  // the cookie with the same attributes Hono's deleteOpts sets (path /,
  // Secure, HttpOnly, SameSite Lax), otherwise the flash would render again
  // on the next visit. HEAD/POST reads leave it pending, matching Hono's
  // GET-only readJoinResult (the bridge already gates on GET).
  const { joinResult } = await applyJoinPageResponsePolicy({
    request,
    sessionSecret: env.SESSION_SECRET,
    snapshot: widgetSnapshot,
    cookies,
    setHeaders,
  });
  // The next-game-night card reuses the homepage teaser's merged read (the
  // same cachedHomeUpcoming the Hono handler and the Kit home load use):
  // one list select plus its batched aggregates, never per-row reads. Only
  // the soonest row rides the load data; an empty or unreadable schedule is
  // null, which renders the page exactly as before. The read never throws,
  // so /join stays 200 when the database or Discord is down. Public fields
  // only (eventKey/title/startsAt/timezone/location/counts), so the row is
  // safe to serialize into __data.json on this logged-out page.
  const homeUpcoming = await cachedHomeUpcoming(
    env,
    () => dbFor({ env }),
    () => discordEventsSource(env),
    new Date(),
    undefined,
    // Same validated cf-ray correlation as the Kit home load (safeRequestId
    // inside the reader drops anything else).
    request.headers.get("cf-ray") ?? undefined,
  );
  // Sanitized like the Hono data source: a bad DISCORD_INVITE_URL renders
  // the hardcoded fallback, never a dead, relative or hostile href. The
  // banner and intro copy ride as load data (the Kit home homeCopy channel),
  // so the page renders the shared bytes without importing the Hono screen.
  // Projected before returning: Kit serializes load data into __data.json
  // for anonymous clients even with csr=false, so member usernames and
  // statuses never ride the snapshot (privacy policy v2). The page only
  // reads the four aggregate fields, so the view is unchanged.
  return {
    inviteUrl: inviteDestination(env.DISCORD_INVITE_URL),
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    widgetUrl,
    widgetSnapshot: toPublicWidgetSnapshot(widgetSnapshot),
    oneClickHref:
      next && source
        ? `/join/discord?next=${encodeURIComponent(next)}&source=${encodeURIComponent(source)}`
        : next
          ? `/join/discord?next=${encodeURIComponent(next)}`
          : source
            ? `/join/discord?source=${encodeURIComponent(source)}`
            : "/join/discord",
    appUrl: env.APP_URL,
    joinResult,
    nextEvent: homeUpcoming.items[0] ?? null,
  };
};
