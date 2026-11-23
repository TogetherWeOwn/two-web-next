import { dbFor } from "./admin/db";
import { readCounts, readHomeCountsSnapshot } from "./counts";
import type { Env } from "./env";
import { discordEventsSource } from "./events/discord-transients-source";
import { cachedFeatured, cachedHomeUpcoming } from "./home-cache";

// Start only viewer-invariant reads here. A deadline can return a fallback
// while its optional DB query is still settling; neither can be part of the
// private RSVP audit capture. The loader projects the results per viewer.
export async function prepareKitHomePanels(env: Env, request: Request) {
  const now = new Date();
  const requestId = request.headers.get("cf-ray") ?? undefined;
  const openDb = () => dbFor({ env });
  const [counts, countsSnapshot, homeUpcoming, featured] = await Promise.all([
    readCounts(env),
    readHomeCountsSnapshot(env),
    cachedHomeUpcoming(env, openDb, () => discordEventsSource(env), now, undefined, requestId),
    cachedFeatured(env, openDb, now, undefined, requestId),
  ]);
  return { counts, countsSnapshot, homeUpcoming, featured };
}

export type KitHomePanels = Awaited<ReturnType<typeof prepareKitHomePanels>>;
