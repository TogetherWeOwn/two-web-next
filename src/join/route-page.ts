// GET /join (structural split; zero behavior change).
//
// The journey page. Outage-proof leaf like /about: it must stay 200 when
// everything behind it is down (a 500 here loses the member). The one read
// is the homepage teaser's cached merged-upcoming list, which degrades to
// no card instead of failing the page.
import type { Hono } from "hono";
import { dbFor } from "../admin/db";
import { discordWidgetHealth } from "../discord-widget";
import type { Env } from "../env";
import { discordEventsSource } from "../events/discord-transients-source";
import { cachedHomeUpcoming } from "../home-cache";
import { inviteDestination } from "../invite";
import { safeNext, sanitizeSource } from "./service";
import { background, JOIN_START_FAILED_NOTICE, type JoinRender } from "./route-shared";

export function registerJoinPageRoutes(app: Hono<{ Bindings: Env }>, render: JoinRender) {
  app.get("/join", async (c) => {
    // The widget verdict is read, never awaited: a Discord outage or a hung
    // probe swaps the preview link for the static fallback without touching the
    // response path. Re-probes ride waitUntil, so they need an execution
    // context; without one (local requests) the last verdict stands.
    const widgetUrl = discordWidgetHealth.url(c.env.DISCORD_GUILD_ID, background(c));
    // The presence snapshot rides the same verdict: it answers from the last
    // background probe and never waits on Discord, so the response path stays
    // synchronous. Read after `url` so the stale verdict schedules its one
    // re-probe before this read.
    const widgetSnapshot = discordWidgetHealth.snapshot(c.env.DISCORD_GUILD_ID);
    // A safe `?next=` or `?source=` survives onto the one-click link; a hostile
    // one leaves no trace in the HTML (legacy ReturnToPageTest; safeNext and
    // sanitizeSource pin the guards). Source is what lets a store-failure
    // retry keep its attribution: the fallback 302 lands here, and the link
    // is the only way back into /join/discord.
    const next = safeNext(c.req.query("next"));
    const source = sanitizeSource(c.req.query("source"));
    // The store-down start bounce lands here with ?notice=start-failed so
    // the member sees why the start failed instead of a silent bounce (E1).
    // Exact-match allowlist: anything else renders the plain page, so a
    // hostile or mistyped value leaves no trace in the HTML.
    const notice =
      c.req.query("notice") === JOIN_START_FAILED_NOTICE ? JOIN_START_FAILED_NOTICE : null;
    // Sanitized like /discord and the join callback: a bad
    // DISCORD_INVITE_URL renders the hardcoded fallback, never a dead,
    // relative or hostile href.
    // The next-game-night card reuses the homepage teaser's merged read
    // (same helper, same cache entry, same deadline/degrade contract): one
    // list select plus its batched aggregates, never per-row reads. Only the
    // soonest row renders; an empty or unreadable schedule is null, which
    // renders the page exactly as before. The read never throws, so /join
    // stays 200 when the database or Discord is down.
    const homeUpcoming = await cachedHomeUpcoming(
      c.env,
      () => dbFor(c),
      () => discordEventsSource(c.env),
      new Date(),
    );
    return render.joinPage(c, {
      inviteUrl: inviteDestination(c.env.DISCORD_INVITE_URL),
      widgetUrl,
      widgetSnapshot,
      next,
      source,
      appUrl: c.env.APP_URL,
      notice,
      nextEvent: homeUpcoming.items[0] ?? null,
    });
  });
}
