// Mostly database-free static leaves: `/discord`, `/login`, `/community`,
// `/about`, `/faq`, `/rules`.
//
// Disjoint from the OAuth/login extraction: no session, no cookie, no cache.
// `/discord`, `/login`, `/community` and `/rules` read no database at all and
// stay 200→302 when everything behind them is down. `/about` and `/faq` read
// only the bot-owned rank views for their ladder prose, and that read degrades
// to the static null-state copy — so they stay 200 during any database outage
// too. One register function behind the same barrel pattern as the event
// routes; `src/index.tsx` only calls it.
import type { Hono } from "hono";
import { readRanks } from "./counts";
import type { Env } from "./env";
import { inviteDestination } from "./invite";
import { safeNext } from "./join/service";
import { About, Faq, Rules } from "./pages";
import { rulesLastUpdated } from "./rules-last-updated";

export function registerStaticLeaves(app: Hono<{ Bindings: Env }>): void {
  // `/discord` — the front door, and the only web-to-Discord conversion path (ports two-web
  // routes/funnel.php + DiscordInviteController). Database-free floor by design: this handler reads
  // no session, no cookie, no cache, no database — it must stay 200→302 when everything behind it
  // is down. 302, not 301: the door gets retargeted, and a 301 is cached by browsers effectively
  // forever. `no-store` for the same reason at the edge.
  app.get("/discord", (c) => {
    c.header("cache-control", "no-store, private");
    return c.redirect(inviteDestination(c.env.DISCORD_INVITE_URL), 302);
  });

  // Vanity aliases (post-cutover): `/login` is the sign-in entry, `/community`
  // is the lobby front. Database-free by design like `/discord` — no session, no
  // cookie, no database — they stay 302 when everything behind them is down.
  // 302, not 301: the doors get retargeted, and a 301 is cached by browsers
  // effectively forever. `/login` keeps only a safe `next` under the same
  // `safeNext` policy as `/auth/discord/redirect`; it starts no OAuth state and
  // issues no cookie — `/auth/discord` remains responsible for fresh state.
  // `/community` drops every query.
  app.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    c.header("cache-control", "no-store");
    return c.redirect(
      next ? `/auth/discord?${new URLSearchParams({ next })}` : "/auth/discord",
      302,
    );
  });

  app.get("/community", (c) => {
    c.header("cache-control", "no-store, private");
    return c.redirect("/", 302);
  });

  // Funnel leaves (ports two-web routes/funnel.php's `/about` + `/faq`): no
  // controller, no session, no cookies — but the ladder prose reads the
  // bot-owned rank views, so the rungs name the live ladder instead of
  // hard-coded ranks. The read never throws: without ranks the screens render
  // their static null-state copy, and the leaves stay 200 during any database
  // outage. No cookies are read or set here on purpose, for the same reason.
  for (const path of ["/about", "/faq"] as const) {
    app.get(path, async (c) => {
      c.header("cache-control", "public, max-age=3600");
      const ranks = await readRanks(c.env);
      return c.html(
        path === "/about" ? (
          <About appUrl={c.env.APP_URL} ranks={ranks} />
        ) : (
          <Faq appUrl={c.env.APP_URL} ranks={ranks} />
        ),
      );
    });
  }

  // Static house rules (ports two-web `Route::view('/rules')`, TOG-5147): no database — renders
  // even when the bot's database is down. The last-updated stamp comes from config, and an empty
  // or unparseable value hides the stamp instead of 500ing (TOG-7323).
  app.get("/rules", (c) => {
    const stamp = rulesLastUpdated(c.env.RULES_LAST_UPDATED);
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Rules appUrl={c.env.APP_URL} lastUpdated={stamp} />);
  });
}
