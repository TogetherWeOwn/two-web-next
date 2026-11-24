import { captureRefusal, captureResponse } from "../../src/render-clock";
import { type Handle, sequence } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { recordBoardView, recordQueuedBoardView } from "../../src/hotzones/board-log";
import { prepareKitHomePanels } from "../../src/kit-home-panels";
import { kitAccessSink } from "../../src/kit-access-sink";
import { preserveHonoDataResponse } from "../../src/kit-worker-facade";
import {
  kitAdminRenewalFor,
  kitAuthStatusCookieFor,
  kitDocumentRotationFor,
  kitEventsJourneyFor,
  kitEventsSessionFor,
  kitSessionBridge,
} from "../../src/kit-session";
import { dispatchHookRequest } from "../../src/route-ownership";
import { dispatchEventDetailRequest } from "../../src/events/kit-detail";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchHotzonesRequest } from "../../src/kit-hotzones";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { honoFetch, honoRecoveryFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration, the read-only session
// bridge and the archive/list/detail/hot-zone guard branches live in the tested core
// (src/route-ownership.ts owns the one loopback-fixture route choice; it
// dispatches deps.pastArchive for the archive route
// and deps.eventDetail for the detail route, pinned through
// dispatchHookRequest), so this file carries no route, owner
// or session logic to mutate — only env, honoFetch, resolve and the tested
// bridges. The events-list binding adds the list's read-only session peek and
// join-flash peek (no rotation, no consumption at the hook layer) for the
// dispatch's shared-cache eligibility. Renewal stays route-specific: the
// bridge never issues, rotates, revokes, or sets cookies, and the event
// detail, home and admin reads renew only through the post-release bindings below,
// after the member-read boundary releases a successful GET. Logout and OAuth stay
// Hono-owned, and a missing secret (the preview Worker sets none) resolves
// to "unknown" rather than a false logout.
const admitCapture: Handle = ({ event, resolve }) => {
  if (typeof __TWO_LOCAL_CAPTURE__ !== "undefined" && __TWO_LOCAL_CAPTURE__ === true) {
    const refusal = captureRefusal(event.request, env);
    if (refusal) return refusal;
  }
  return resolve(event);
};

const dispatchWithSecurity: Handle = async ({ event, resolve }) => {
  let honoOwned = false;
  const response = await dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    sessionSecret: env.SESSION_SECRET,
    kitRouteArchive: env.KIT_ROUTE_ARCHIVE,
    kitRouteStatic: env.KIT_ROUTE_STATIC,
    kitRouteEvents: env.KIT_ROUTE_EVENTS,
    kitRouteHome: env.KIT_ROUTE_HOME,
    kitRouteJoin: env.KIT_ROUTE_JOIN,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch: (request) => {
      honoOwned = true;
      return honoFetch(request);
    },
    // Forwards the core's resolve options untouched: content-leaf renders
    // pass transformPageChunk here (the zero-stylesheet strip), every other
    // route passes none. The hook carries no route logic of its own — the
    // core alone decides when the option is set.
    resolve: (hookEvent, opts) =>
      resolve(hookEvent as Parameters<typeof resolve>[0], opts as Parameters<typeof resolve>[1]),
    recoveryPage: honoRecoveryFetch,
    pastArchive: (request, render, requestId) =>
      dispatchPastArchiveRequest(request, env, render, undefined, undefined, requestId),
    eventsPage: (request, render, requestId) =>
      dispatchEventsRequest(request, env, render, {
        sessionFor: kitEventsSessionFor(env),
        journeyFor: kitEventsJourneyFor(env),
        requestId,
      }),
    eventDetail: (request, render, requestId) =>
      dispatchEventDetailRequest(request, env, render, undefined, requestId),
    hotzones: (request, render, requestId) =>
      dispatchHotzonesRequest(request, env, render, undefined, requestId),
    sessionFor: kitSessionBridge(env),
    authStatusCookieFor: kitAuthStatusCookieFor(env),
    homePanelsFor: (request) => prepareKitHomePanels(env, request),
    homeRenewalFor: kitDocumentRotationFor(env),
    eventDetailRotationFor: kitDocumentRotationFor(env),
    adminRenewalFor: kitAdminRenewalFor(env),
    accessSink: kitAccessSink(env),
    // Loopback Kit parity fixture flags only: the core turns these booleans
    // plus a loopback appUrl into the fixture route choice, so the member
    // board's and the live event detail's executed journeys run the Kit loads
    // on the fixture worker. Production now serves the board from Kit too, so
    // that flag is redundant for the entry; the detail entry stays on Hono in
    // the shipped list and the fixture alone turns it to Kit. Flipping either
    // entry back restores Hono.
    fixtureMemberBoard: env.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true",
    fixtureEventDetail: env.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true",
    fixtureJoin: env.KIT_PARITY_FIXTURE_JOIN === "true",
    fixtureAdminDashboard: env.KIT_PARITY_FIXTURE_ADMIN_DASHBOARD === "true",
    // The member board's anonymous view log, written only after the
    // member-read boundary released a 200 (no-op for every other route).
    afterMemberRead: (event, response) =>
      recordQueuedBoardView(event.locals, response.status, recordBoardView),
  });
  const result =
    typeof __TWO_LOCAL_CAPTURE__ !== "undefined" && __TWO_LOCAL_CAPTURE__ === true
      ? captureResponse(event.request, env, response)
      : response;
  return honoOwned && event.isDataRequest
    ? preserveHonoDataResponse(event.request, result)
    : result;
};

export const handle: Handle = sequence(admitCapture, dispatchWithSecurity);
