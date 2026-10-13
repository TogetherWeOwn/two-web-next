import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { kitEventDetailStore, resolveKitEventDetail } from "../../../../../src/events/kit-detail";

// Server-rendered only: the Hono page ships no Svelte hydration bundle (its
// interactivity is the existing /islands/*.js), so the Kit page carries none
// that the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono GET /e/:key handler
// (src/events/routes-detail.tsx): canonical redirect before any read,
// member-gated attendee disclosure, audited by the hook's member-read
// boundary before any bytes leave. The route stays disabled in the manifest
// until the RSVP companion passes, so Hono answers meanwhile; the branded
// Kit error shell owns the non-ok outcomes.
export const load: PageServerLoad = async ({ params, url, locals, setHeaders }) => {
  const outcome = await resolveKitEventDetail({
    key: params.key ?? "",
    search: url.search,
    path: url.pathname,
    env,
    session: { status: locals.status ?? "unknown", session: locals.session ?? null },
    joinResult: locals.joinResult ?? null,
    setHeaders,
    store: kitEventDetailStore(env),
  });
  // redirect()/error() never return: after these guards the outcome is ok.
  if (outcome.kind === "redirect") redirect(301, outcome.location);
  if (outcome.kind === "gone") error(410, "This event was cancelled.");
  if (outcome.kind === "missing") error(404, "Not found");
  if (outcome.kind === "forbidden") error(403, "Forbidden");
  if (outcome.kind === "unavailable") error(503, "Events temporarily unavailable");
  return { model: outcome.model };
};
