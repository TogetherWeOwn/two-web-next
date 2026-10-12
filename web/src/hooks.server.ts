import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { kitAccessSink } from "../../src/kit-access-sink";
import { kitSessionBridge } from "../../src/kit-session";
import { dispatchHookRequest } from "../../src/route-ownership";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust, ownership, decoration and the read-only session
// bridge live in the tested core (src/route-ownership.ts, src/kit-session.ts),
// so this file carries no owner or session logic to mutate — only env,
// honoFetch, resolve and the tested bridge. Rotation, logout
// and OAuth stay Hono-owned: the bridge never issues, rotates, revokes, or
// sets cookies, and a missing secret (the preview Worker sets none) resolves
// to "unknown" rather than a false logout.
export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch,
    resolve: (hookEvent) => resolve(hookEvent as Parameters<typeof resolve>[0]),
    sessionFor: kitSessionBridge(env),
    accessSink: kitAccessSink(env),
  });
