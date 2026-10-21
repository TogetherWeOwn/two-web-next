import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { RequestHandler } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { discordEventsSource } from "../../../../src/events/discord-transients";
import { loadEventsPage } from "../../../../src/kit-events";
import { renderEventsHtml } from "../../../../src/kit-events-html";
import {
  isRestoredBannerEligible,
  kitEventsJourneyFor,
  kitEventsSessionFor,
  readReturnJourney,
} from "../../../../src/kit-session";
import { JOIN_RESULT_COOKIE } from "../../../../src/return-journey";

// Endpoint rendering, not a Svelte page: the HTML comes from the Hono
// calendar screen through renderEventsHtml, so this route emits no client
// entries/node while the hook dispatch keeps the Hono guard/cache/422/503
// contract. Only GET is listed in the manifest (HEAD follows it); any other
// method never reaches here because decideRoute matches the entry GET-only
// and the hook hands the rest to Hono, so POST /events stays Hono-owned.
export const GET: RequestHandler = async ({ request, cookies, url, setHeaders }) => {
  const collected: Record<string, string> = {};
  let consumeJoinFlash = false;
  // The restored-write notice for the "you signed in again" banner: a
  // read-only, signature-verified peek through the same eligibility the hook
  // core consumes with, so render and consume can never disagree. Island
  // fragments never render it, like the join flash they keep pending.
  const restoredWrite = isRestoredBannerEligible(request)
    ? (await readReturnJourney(request, env.SESSION_SECRET)).restoredWrite
    : null;
  try {
    const data = await loadEventsPage({
      env,
      url,
      method: request.method,
      island: request.headers.get("x-two-island") === "events-calendar",
      request,
      setHeaders: (headers) => Object.assign(collected, headers),
      deleteJoinCookie: () => {
        consumeJoinFlash = true;
      },
      dbForFn: dbFor,
      sessionForFn: kitEventsSessionFor(env),
      journeyForFn: kitEventsJourneyFor(env),
      discordForFn: discordEventsSource,
    });
    // Error renders never carry the banner (Hono's middleware gates on
    // 200): the overlong-query notice rewrites to the Hono 422 downstream,
    // so it renders banner-free and the hook preserves the notice for the
    // next visible page.
    const rendered = await renderEventsHtml(data, collected, {
      restoredWrite: data.queryTooLong ? null : restoredWrite,
    });
    const response = new Response(rendered.body, {
      status: rendered.status,
      headers: rendered.headers,
    });
    // Kit also sends cookie changes on errors: consume only once the HTML and
    // response are ready, so a render failure leaves the banner for a retry.
    if (consumeJoinFlash) {
      cookies.delete(JOIN_RESULT_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      });
    }
    return response;
  } catch {
    // A render can fail after the load collected public success headers.
    // Every failure must be uncacheable, regardless of how far it got.
    setHeaders({ "cache-control": "private, no-store", vary: "Cookie, X-Two-Island" });
    error(503, "Events temporarily unavailable");
  }
};
