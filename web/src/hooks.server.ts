import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { recordBoardView, recordQueuedBoardView } from "../../src/hotzones/board-log";
import { kitAccessSink } from "../../src/kit-access-sink";
import { kitEventsJourneyFor, kitEventsSessionFor, kitSessionBridge } from "../../src/kit-session";
import { dispatchHookRequest } from "../../src/route-ownership";
import { dispatchEventDetailRequest } from "../../src/events/kit-detail";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration, the read-only session
// bridge and the archive/list/detail guard branches live in the tested core
// (src/route-ownership.ts owns the one loopback-fixture route choice; it
// dispatches deps.pastArchive for the archive route
// and deps.eventDetail for the detail route, pinned through
// dispatchHookRequest), so this file carries no route, owner
// or session logic to mutate — only env, honoFetch, resolve and the tested
// bridges. The events-list binding adds the list's read-only session peek and
// join-flash peek (no rotation, no consumption at the hook layer) for the
// dispatch's shared-cache eligibility. Rotation, logout
// and OAuth stay Hono-owned: the bridge never issues, rotates, revokes, or
// sets cookies, and a missing secret (the preview Worker sets none) resolves
// to "unknown" rather than a false logout.
export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch,
    resolve: (hookEvent) => resolve(hookEvent as Parameters<typeof resolve>[0]),
    pastArchive: (request, render) => dispatchPastArchiveRequest(request, env, render),
    eventsPage: (request, render) =>
      dispatchEventsRequest(request, env, render, {
        sessionFor: kitEventsSessionFor(env),
        journeyFor: kitEventsJourneyFor(env),
      }),
    eventDetail: (request, render) => dispatchEventDetailRequest(request, env, render),
    sessionFor: kitSessionBridge(env),
    accessSink: kitAccessSink(env),
    // Loopback Kit parity fixture flag only: the core turns this boolean
    // plus a loopback appUrl into the fixture route choice, so the member
    // board's executed journey runs the Kit load on the fixture worker.
    // Production now serves the board from Kit too, so this flag is
    // redundant for the entry; flipping the entry back restores Hono.
    fixtureMemberBoard: env.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true",
    // The member board's anonymous view log, written only after the
    // member-read boundary released a 200 (no-op for every other route).
    afterMemberRead: (event, response) =>
      recordQueuedBoardView(event.locals, response.status, recordBoardView),
  });
