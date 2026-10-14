import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { RequestHandler } from "./$types";
import { dbFor } from "../../../../src/admin/db";
import { discordEventsSource } from "../../../../src/events/discord-transients";
import { loadEventsPage } from "../../../../src/kit-events";
import { renderEventsHtml } from "../../../../src/kit-events-html";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../../../../src/kit-session";
import { JOIN_RESULT_COOKIE } from "../../../../src/return-journey";

// Endpoint rendering, not a Svelte page: the HTML comes from the Hono
// calendar screen through renderEventsHtml, so this route emits no client
// entries/node while the hook dispatch keeps the Hono guard/cache/422/503
// contract. Only GET is listed in the manifest (HEAD follows it); any other
// method never reaches here because decideRoute matches the entry GET-only
// and the hook hands the rest to Hono, so POST /events stays Hono-owned.
export const GET: RequestHandler = async ({ request, cookies, url, setHeaders }) => {
  const collected: Record<string, string> = {};
  try {
    const data = await loadEventsPage({
      env,
      url,
      method: request.method,
      island: request.headers.get("x-two-island") === "events-calendar",
      request,
      setHeaders: (headers) => Object.assign(collected, headers),
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
    const rendered = await renderEventsHtml(data, collected);
    return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
  } catch {
    // loadEventsPage collects private, no-store + Vary before every 503
    // throw: re-apply them so the Kit error page keeps Hono's no-store
    // contract instead of a cacheable default.
    const cacheControl = collected["cache-control"];
    const vary = collected.vary;
    if (cacheControl || vary) {
      setHeaders({
        ...(cacheControl ? { "cache-control": cacheControl } : {}),
        ...(vary ? { vary } : {}),
      });
    }
    error(503, "Events temporarily unavailable");
  }
};
