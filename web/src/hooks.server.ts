import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { kitAccessSink } from "../../src/kit-access-sink";
import { kitEventsJourneyFor, kitEventsSessionFor, kitSessionBridge } from "../../src/kit-session";
import { dispatchHookRequest } from "../../src/route-ownership";
import { dispatchEventsRequest } from "../../src/kit-events";
import { dispatchPastArchiveRequest } from "../../src/kit-past-events";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration, the read-only session
// bridge and the archive guard/cache branch live in the tested core
// (src/route-ownership.ts dispatches deps.pastArchive for the archive route,
// pinned through dispatchHookRequest), so this file carries no route, owner
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
    sessionFor: kitSessionBridge(env),
    accessSink: kitAccessSink(env),
  });
