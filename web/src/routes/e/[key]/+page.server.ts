import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import {
  eventDetailConsumesFlash,
  eventDetailErrorPayload,
  kitEventDetailStore,
  resolveKitEventDetail,
} from "../../../../../src/events/kit-detail";
import { JOIN_RESULT_COOKIE } from "../../../../../src/return-journey";

// Server-rendered only: the Hono page ships no Svelte hydration bundle (its
// interactivity is the existing /islands/*.js), so the Kit page carries none
// that the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono GET /e/:key handler
// (src/events/routes-detail.tsx): canonical redirect before any read,
// member-gated attendee disclosure, audited by the hook's member-read
// boundary before any bytes leave. The route stays disabled in the manifest
// until the RSVP companion passes, so Hono answers meanwhile. Gone and
// missing outcomes throw their branded #838 state models to the route-level
// error page with the served statuses, never the generic shell; the one-shot
// join flash is deleted on the 200 GET that renders the banner, exactly as
// the served handler consumes it only after its boundary allows a response.
export const load: PageServerLoad = async ({
  params,
  url,
  request,
  locals,
  cookies,
  setHeaders,
}) => {
  const outcome = await resolveKitEventDetail({
    key: params.key ?? "",
    search: url.search,
    path: url.pathname,
    env,
    session: { status: locals.status ?? "unknown", session: locals.session ?? null },
    joinResult: locals.joinResult ?? null,
    setHeaders,
    store: kitEventDetailStore(env),
    // Same correlation source as the Hono request log: the validated
    // cf-ray (safeRequestId inside the alert drops anything else).
    requestId: request.headers.get("cf-ray") ?? undefined,
  });
  // redirect()/error() never return: after these guards the outcome is ok.
  if (outcome.kind === "redirect") redirect(301, outcome.location);
  if (outcome.kind === "gone" || outcome.kind === "missing") {
    const { status, body } = eventDetailErrorPayload(outcome);
    error(status, body);
  }
  if (outcome.kind === "forbidden") error(403, "Forbidden");
  if (outcome.kind === "unavailable") error(503, "Events temporarily unavailable");
  if (eventDetailConsumesFlash(outcome, request.method)) {
    cookies.delete(JOIN_RESULT_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  return { model: outcome.model };
};
