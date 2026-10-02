import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { robotsTagFor, securityHeadersFor } from "../../src/headers";
import { isTrustedHost } from "../../src/trust-hosts";
import { honoFetch } from "#lib/server/hono.ts";

// The catch-all route hands the request to the Hono app, which applies its own
// host guard and headers; this hook only covers the pages Kit renders itself.
const HONO_ROUTE = "/[...path]";

export const handle: Handle = async ({ event, resolve }) => {
  // Untrusted Host: Hono's trustHosts() refuses it with the branded 404, so the
  // refusal stays byte-identical whichever framework owns the path.
  if (!isTrustedHost(env.APP_URL, [event.request.headers.get("host"), event.url.host])) {
    return honoFetch(event.request);
  }
  const response = await resolve(event);
  if (event.route.id === HONO_ROUTE) return response;

  for (const [name, value] of securityHeadersFor({ path: event.url.pathname, method: event.request.method }, env.FEATURED_IMAGE_HOSTS)) {
    response.headers.set(name, value);
  }
  const contentType = response.headers.get("content-type") ?? "";
  // Kit sends a bare `text/html`; Hono's c.html() names the charset.
  if (contentType === "text/html") response.headers.set("Content-Type", "text/html; charset=UTF-8");
  if (contentType.includes("text/html")) {
    const tag = robotsTagFor(env.APP_URL, event.url.hostname);
    if (tag) response.headers.set("X-Robots-Tag", tag);
  }
  return response;
};
