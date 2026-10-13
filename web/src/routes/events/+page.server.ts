import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { discordEventsSource } from "../../../../src/events/discord-transients";
import { loadEventsPage } from "../../../../src/kit-events";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../../../../src/kit-session";
import { JOIN_RESULT_COOKIE } from "../../../../src/return-journey";

// Server-rendered only: no hydration bundle, so no inline bootstrap script that
// the CSP (script-src 'self') would block. The calendar island stays the
// existing /islands/events-calendar.js, exactly as on the Hono page.
export const csr = false;

// Thin binding over the tested helper (src/kit-events.ts): the helper owns the
// query-state contract and the one-setHeaders-per-path cache policy (SvelteKit
// throws `header_already_set` on a double-set; a throw below already set
// private, no-store). This binding owns the status mapping and the helper
// args, each pinned by source tests in test/kit-events.test.ts — only
// error(503) proves what Kit sends, since SvelteKit ignores the helper's
// status:503 Error property. Overlong searches pass through as data (the
// dispatch rewrites the status to the Hono 422); the page renders the notice.
export const load: PageServerLoad = async ({ url, request, cookies, setHeaders }) => {
  try {
    return await loadEventsPage({
      env,
      url,
      method: request.method,
      island: request.headers.get("x-two-island") === "events-calendar",
      request,
      setHeaders,
      deleteJoinCookie: () =>
        cookies.delete(JOIN_RESULT_COOKIE, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        }),
      dbForFn: dbFor,
      sessionForFn: kitEventsSessionFor(env),
      journeyForFn: kitEventsJourneyFor(env),
      discordForFn: discordEventsSource,
    });
  } catch {
    error(503, "Events temporarily unavailable");
  }
};
