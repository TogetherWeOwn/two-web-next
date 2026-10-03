import type { RequestHandler } from "./$types";
import { honoFetch } from "#lib/server/hono.ts";

// Strangler catch-all: every path and method Kit has no route for (all of /api/*,
// the other pages, public/ static files) goes to the existing Hono app unchanged.
export const fallback: RequestHandler = ({ request }) => honoFetch(request);
