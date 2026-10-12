import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { dispatchHookRequest } from "../../src/route-ownership";
import { honoFetch } from "#lib/server/hono.ts";

// Pure env binding: trust and ownership live in dispatchHookRequest (which
// imports them), so this file carries no owner logic to mutate. Kit
// decoration (renderer marker, security headers, charset fix, robots tag)
// also lives in the core so the root Vitest suite pins the production path
// without importing SvelteKit code.
export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    featuredImageHosts: env.FEATURED_IMAGE_HOSTS,
    honoFetch,
    resolve: (hookEvent) => resolve(hookEvent as Parameters<typeof resolve>[0]),
  });
