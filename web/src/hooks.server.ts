import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { recordBoardView, recordQueuedBoardView } from "../../src/hotzones/board-log";
import { kitAccessSink } from "../../src/kit-access-sink";
import {
  kitAuthStatusCookieFor,
  kitEventDetailRotationFor,
  kitEventsJourneyFor,
  kitEventsSessionFor,
  kitSessionBridge,
} from "../../src/kit-session";
import { dispatchHookRequest } from "../../src/route-ownership";
import { dispatchEventDetailRequest } from "../../src/events/kit-detail";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchHotzonesRequest } from "../../src/kit-hotzones";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration, the read-only session
// bridge and the archive/list/detail/hot-zone guard branches live in the tested core
// (src/route-ownership.ts owns the one loopback-fixture route choice; it
// dispatches deps.pastArchive for the archive route
// and deps.eventDetail for the detail route, pinned through
// dispatchHookRequest), so this file carries no route, owner
// or session logic to mutate — only env, honoFetch, resolve and the tested
// bridges. The events-list binding adds the list's read-only session peek and
// join-flash peek (no rotation, no consumption at the hook layer) for the
// dispatch's shared-cache eligibility. Rotation stays route-specific: the
// bridge never issues, rotates, revokes, or sets cookies, and the event
// detail renews only through the post-release rotation binding below, after
// the member-read boundary releases a successful GET. Logout and OAuth stay
// Hono-owned, and a missing secret (the preview Worker sets none) resolves
// to "unknown" rather than a false logout.
export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch,
    // Forwards the core's resolve options untouched: content-leaf renders
    // pass transformPageChunk here (the zero-stylesheet strip), every other
    // route passes none. The hook carries no route logic of its own — the
    // core alone decides when the option is set.
    resolve: (hookEvent, opts) =>
      resolve(hookEvent as Parameters<typeof resolve>[0], opts as Parameters<typeof resolve>[1]),
    pastArchive: (request, render) => dispatchPastArchiveRequest(request, env, render),
    eventsPage: (request, render) =>
      dispatchEventsRequest(request, env, render, {
        sessionFor: kitEventsSessionFor(env),
        journeyFor: kitEventsJourneyFor(env),
      }),
    eventDetail: (request, render) => dispatchEventDetailRequest(request, env, render),
    hotzones: (request, render) => dispatchHotzonesRequest(request, env, render),
    sessionFor: kitSessionBridge(env),
    authStatusCookieFor: kitAuthStatusCookieFor(env),
    eventDetailRotationFor: kitEventDetailRotationFor(env),
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
    // The member board's anonymous view log, written only after the
    // member-read boundary released a 200 (no-op for every other route).
    afterMemberRead: (event, response) =>
      recordQueuedBoardView(event.locals, response.status, recordBoardView),
  });
