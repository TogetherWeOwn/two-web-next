import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { decideOwner, dispatchHookRequest } from "../../src/route-ownership";
import { isTrustedHost } from "../../src/trust-hosts";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: Kit decoration (renderer marker, security headers,
// charset fix, robots tag) lives in dispatchHookRequest so the root Vitest
// suite pins the production path without importing SvelteKit code.
export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    isTrustedHost,
    decideOwner,
    honoFetch,
    resolve: (hookEvent) => resolve(hookEvent as Parameters<typeof resolve>[0]),
  });
