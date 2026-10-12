import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { robotsTagFor, securityHeadersFor } from "../../src/headers";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  decideOwner,
  dispatchHookRequest,
} from "../../src/route-ownership";
import { isTrustedHost } from "../../src/trust-hosts";
import { honoFetch } from "#lib/server/hono.ts";

export const handle: Handle = async ({ event, resolve }) =>
  dispatchHookRequest(event, {
    appUrl: env.APP_URL,
    isTrustedHost,
    decideOwner,
    honoFetch,
    resolve: (hookEvent) => resolve(hookEvent as Parameters<typeof resolve>[0]),
    decorateKitResponse: (response, hookEvent) => {
      // Renderer marker: proves Kit answered, so the preview parity and worker
      // e2e fail when a Hono-owned path (or the catch-all) answers instead.
      response.headers.set(KIT_RENDERER_HEADER, KIT_RENDERER_VALUE);
      for (const [name, value] of securityHeadersFor(
        { path: hookEvent.url.pathname, method: hookEvent.request.method },
        env.FEATURED_IMAGE_HOSTS,
      )) {
        response.headers.set(name, value);
      }
      const contentType = response.headers.get("content-type") ?? "";
      // Kit sends a bare `text/html`; Hono's c.html() names the charset.
      if (contentType === "text/html")
        response.headers.set("Content-Type", "text/html; charset=UTF-8");
      if (contentType.includes("text/html")) {
        const tag = robotsTagFor(env.APP_URL, hookEvent.url.hostname);
        if (tag) response.headers.set("X-Robots-Tag", tag);
      }
    },
  });
