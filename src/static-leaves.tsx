// Database-free static leaves: `/discord`, `/login`, `/community`, `/about`,
// `/faq`, `/rules`.
//
// Disjoint from the OAuth/login extraction: no session, no cookie, no cache,
// no database — these handlers stay 200→302 when everything behind them is
// down. One register function behind the same barrel pattern as the event
// routes; `src/index.tsx` only calls it.
import type { Hono } from "hono";
import type { Env } from "./env";
import { About, Faq, Rules } from "./pages";
import { faqLastReviewed } from "./faq-last-reviewed";
import { rulesLastUpdated } from "./rules-last-updated";
import { vanityRedirects } from "./static-public";

export function registerStaticLeaves(app: Hono<{ Bindings: Env }>): void {
  app.get("/discord", vanityRedirects["/discord"]);
  app.get("/login", vanityRedirects["/login"]);
  app.get("/community", vanityRedirects["/community"]);

  // Static funnel leaf (ports two-web routes/funnel.php's `/about`): dependency-free,
  // no controller, no session, no database — it stays 200 during an app-DB outage. No cookies are
  // read or set here on purpose, for the same reason.
  app.get("/about", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(<About appUrl={c.env.APP_URL} />);
  });

  // Static FAQ (ports two-web routes/funnel.php's `/faq`): dependency-free like
  // `/about`, plus the config-driven "Last reviewed" stamp. An empty or
  // unparseable value hides the stamp instead of 500ing, mirroring /rules.
  app.get("/faq", (c) => {
    const stamp = faqLastReviewed(c.env.FAQ_LAST_REVIEWED);
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Faq appUrl={c.env.APP_URL} lastReviewed={stamp} />);
  });

  // Static house rules (ports two-web `Route::view('/rules')`, TOG-5147): no database — renders
  // even when the bot's database is down. The last-updated stamp comes from config, and an empty
  // or unparseable value hides the stamp instead of 500ing (TOG-7323).
  app.get("/rules", (c) => {
    const stamp = rulesLastUpdated(c.env.RULES_LAST_UPDATED);
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Rules appUrl={c.env.APP_URL} lastUpdated={stamp} />);
  });
}
