import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { RequestHandler } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { discordEventsSource } from "../../../../src/events/discord-transients";
import { loadEventsPage } from "../../../../src/kit-events";
import { renderEventsHtml } from "../../lib/server/render-events-html";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../../../../src/kit-session";
import { JOIN_RESULT_COOKIE } from "../../../../src/return-journey";
import { serveEventWrite } from "#lib/server/event-write.ts";

export const trailingSlash = "ignore";
export const POST = serveEventWrite;

// Server-rendered Svelte inside the shared document shell: this endpoint has
// no client entry while the hook dispatch keeps the Hono guard/cache/422/503
// contract. HEAD follows the GET manifest entry. The write family separately
// admits POST, which stays Hono-owned when that family is off.
export const GET: RequestHandler = async ({ request, cookies, url, locals, setHeaders }) => {
  const collected: Record<string, string> = {};
  const island = request.headers.has("x-two-island");
  let consumeJoinFlash = false;
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
      // The dispatch's served request id: the 503 page and x-request-id
      // carry this same value, so the alert must name it too
      // (safeRequestId inside the alert drops anything unvalidated).
      requestId: locals.requestId,
    });
    const rendered = await renderEventsHtml(
      data,
      collected,
      locals.restoredWrite === true && !island,
      request.headers.get("x-two-island") === "events-calendar",
    );
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
