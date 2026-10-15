import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { recordBoardView, recordQueuedBoardView } from "../../src/hotzones/board-log";
import { kitAccessSink } from "../../src/kit-access-sink";
import { kitEventsJourneyFor, kitEventsSessionFor, kitSessionBridge } from "../../src/kit-session";
import { dispatchHookRequest, fixtureManifestFor } from "../../src/route-ownership";
import { dispatchEventDetailRequest } from "../../src/events/kit-detail";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration, the read-only session
// bridge and the archive/list/detail guard branches live in the tested core
// (fixtureManifestFor in src/route-ownership.ts is the one manifest choice,
// loopback-fixture-only; src/route-ownership.ts dispatches deps.pastArchive for the archive route
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
    // Shipped manifest everywhere except the loopback Kit parity fixture,
    // where the member board is fixture-enabled so its executed journey
    // runs the Kit load while production ownership stays on Hono.
    manifest: fixtureManifestFor(env),
    // The member board's anonymous view log, written only after the
    // member-read boundary released a 200 (no-op for every other route).
    afterMemberRead: (event, response) =>
      recordQueuedBoardView(event.locals, response.status, recordBoardView),
  });
