import { captureRefusal, captureResponse } from "../../src/render-clock";
import { redirect } from "@sveltejs/kit";
import { type Handle, sequence } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { recordBoardView, recordQueuedBoardView } from "../../src/hotzones/board-log";
import { prepareKitHomePanels } from "../../src/kit-home-panels";
import { KIT_SECURITY_TXT_ROUTE } from "../../src/kit-security-txt-route";
import { KIT_SEO_ROUTES } from "../../src/kit-seo-routes";
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
import { KIT_EVENT_CALENDAR_ROUTE } from "../../src/events/kit-event-calendar-route";
import { KIT_STATIC_FEED_ROUTES } from "../../src/events/kit-static-feed-routes";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchHotzonesRequest } from "../../src/kit-hotzones";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { KIT_PROFILE_WRITE_ROUTES } from "../../src/profiles/kit-write-route";
import { authOriginRefusal, KIT_AUTH_ROUTES } from "#lib/server/auth.ts";
import { honoFetch, honoRecoveryFetch } from "#lib/server/hono.ts";
import { resolveProfileWrite } from "#lib/server/profile-write.ts";

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
// after the member-read boundary releases a successful GET. Auth endpoints
// own their session effects behind a default-off family binding. A missing
// secret in the preview Worker resolves to "unknown".
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
    kitRouteEmberPages: env.KIT_ROUTE_EMBER_PAGES,
    // End Kit's action before it starts another layout or page load. The
    // dispatcher returns the controller's native HTTP response in its place.
    admin: { env, completeForm: () => redirect(303, "/admin") },
    apiFamilies: [
      {
        flag: env.KIT_ROUTE_AUTH,
        routes: KIT_AUTH_ROUTES,
        crossOriginRefusal: authOriginRefusal,
      },
      { flag: env.KIT_ROUTE_FEEDS, routes: [...KIT_STATIC_FEED_ROUTES, KIT_EVENT_CALENDAR_ROUTE] },
      { flag: env.KIT_ROUTE_SEO, routes: KIT_SEO_ROUTES },
      { flag: env.KIT_ROUTE_SECURITY_TXT, routes: [KIT_SECURITY_TXT_ROUTE] },
      {
        flag: env.KIT_ROUTE_PROFILE_WRITES,
        routes: KIT_PROFILE_WRITE_ROUTES,
        crossOriginRefusal: authOriginRefusal,
      },
    ],
    versionMetadata: env.CF_VERSION_METADATA,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch: (request) => {
      honoOwned = true;
      return honoFetch(request);
    },
    // Forwards the core's resolve options untouched: content-leaf renders
    // pass transformPageChunk here (the zero-stylesheet strip), every other
    // route passes none. The hook carries no route logic of its own — the
    // core alone decides when the option is set.
    resolve: (hookEvent, opts) => {
      const owned = hookEvent as Parameters<typeof resolve>[0];
      const render = () => resolve(owned, opts as Parameters<typeof resolve>[1]);
      return env.KIT_ROUTE_PROFILE_WRITES === "true"
        ? resolveProfileWrite(owned, render, env)
        : render();
    },
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
