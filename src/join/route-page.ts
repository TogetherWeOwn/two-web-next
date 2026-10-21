// GET /join (structural split; zero behavior change).
//
// The journey page. Database-free leaf like /about: it must stay 200 when
// everything behind it is down (a 500 here loses the member).
import type { Hono } from "hono";
import { discordWidgetHealth } from "../discord-widget";
import type { Env } from "../env";
import { safeNext, sanitizeSource } from "./service";
import { background, JOIN_START_FAILED_NOTICE, type JoinRender } from "./route-shared";

export function registerJoinPageRoutes(app: Hono<{ Bindings: Env }>, render: JoinRender) {
  app.get("/join", (c) => {
    // The widget verdict is read, never awaited: a Discord outage or a hung
    // probe swaps the preview link for the static fallback without touching the
    // response path. Re-probes ride waitUntil, so they need an execution
    // context; without one (local requests) the last verdict stands. No
    // binding is read here: /join stays a persistence-free leaf.
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
    return render.joinPage(c, {
      inviteUrl: c.env.DISCORD_INVITE_URL,
      widgetUrl,
      widgetSnapshot,
      next,
      source,
      appUrl: c.env.APP_URL,
      notice,
    });
  });
}
