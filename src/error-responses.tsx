import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { alertRequestError } from "./alerts";
import { isDatabaseUnavailable } from "./db/errors";
import {
  InternalErrorPage,
  MaintenancePage,
  NotFoundPage,
  PayloadTooLargePage,
  RateLimitedPage,
} from "./error-pages";
import type { SuggestedEvent } from "./events/suggestions";
import { inviteDestination } from "./invite";
import { bufferedMemberHtml, bufferedMemberText, memberReadActive } from "./member-reads";
import { cachedNotFoundSuggestions } from "./not-found-suggestions";
import { requestRoute } from "./request-log";

// Host refusals use only this shell, never the optional DB lookup.
export function notFoundResponse(
  c: Context,
  suggestions: SuggestedEvent[] = [],
): Response | Promise<Response> {
  if (memberReadActive()) {
    // Only this known shell classifies a missing route; arbitrary 404 responses
    // and prior queries still must satisfy the ordinary read boundary.
    if (c.get("adminActor"))
      c.set("access", { resource: "not-found", action: "view", route: "admin.not-found" });
    return bufferedMemberHtml(c, <NotFoundPage suggestions={suggestions} />, 404);
  }
  c.header("cache-control", "no-store, private");
  c.status(404);
  return c.html(<NotFoundPage suggestions={suggestions} />);
}

export async function notFoundHandler(c: Context): Promise<Response> {
  return notFoundResponse(c, await cachedNotFoundSuggestions(c.env, c.req.path));
}

export function internalErrorHandler(err: unknown, c: Context): Response | Promise<Response> {
  if (memberReadActive()) {
    // Sanitize before the ordinary logger/alert sees SQL, bindings or causes.
    console.error("Member request failed; refusing contents.", {
      exception: err instanceof Error ? err.constructor.name : "unknown",
    });
    return bufferedMemberText(c, "Member data is temporarily unavailable.", 503);
  }
  alertRequestError(err, {
    method: c.req.method,
    route: requestRoute(c),
    requestId: c.get("requestId"),
  });
  if (isDatabaseUnavailable(err)) return databaseUnavailable(c);
  c.header("cache-control", "no-store, private");
  c.status(500);
  return c.html(<InternalErrorPage inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)} />);
}

// Merge Accept into Vary (preserving any existing dimensions such as Origin
// or Cookie) rather than overwriting the header.
function varyAccept(c: Context) {
  const current = c.res.headers.get("Vary");
  if (current) {
    const dims = current.split(",").map((d) => d.trim().toLowerCase());
    if (!dims.includes("accept")) {
      c.header("Vary", `${current}, Accept`);
    }
  } else {
    c.header("Vary", "Accept");
  }
}

// One 429 shape for every throttle (ports ThrottleEnvelope::render): JSON
// callers get the {reason, message, retry_after} envelope, browsers get the
// branded page — both with the Retry-After header. Default 60 s, min 1 s.
// Wired by the RSVP writes (src/events/routes.tsx, W9). Uses the same
// quality/specificity/q=0 selector as outageRepresentation so that explicit
// JSON q=0, mixed-case, wildcard, and machine-only contracts behave
// consistently; always emits private no-store + Vary: Accept.
export function rateLimitExceeded(c: Context, retryAfter = 60): Response | Promise<Response> {
  const parsed = Math.floor(retryAfter);
  const n = Number.isFinite(parsed) ? Math.max(1, parsed) : 60;
  c.header("Retry-After", String(n));
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(429);
  if (jsonOnlyEventRequest(c) || outageRepresentation(c) === "application/json") {
    return c.json({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${n} seconds.`,
      retry_after: n,
    });
  }
  return c.html(<RateLimitedPage inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)} />);
}

// Match the JSON-only event contracts before a handler can run (e.g. session
// lookup failure). GET /events and admin/profile browser forms still negotiate.
function jsonOnlyEventRequest(c: Context): boolean {
  const { method, path } = c.req;
  if (method === "GET" || method === "HEAD") return path === "/events.json";
  if (method === "POST") {
    return (
      path === "/events" || /^\/events\/[^/]+\/(publish|cancel|rsvp-pause|rsvp-reopen)$/.test(path)
    );
  }
  if (method === "PATCH") return /^\/events\/[^/]+$/.test(path);
  if (method === "PUT" || method === "DELETE") return /^\/events\/[^/]+\/rsvp$/.test(path);
  return false;
}

function outageRepresentation(c: Context): string {
  return accepts(c, {
    header: "Accept",
    supports: ["text/html", "application/json"],
    default: "text/html",
    match: (ranges, config) => {
      // The most specific range determines each representation's quality,
      // including q=0 exclusions; only then compare the supported responses.
      const candidates = config.supports.map((type) => {
        let specificity = -1;
        let q = 0;
        let order = ranges.length;
        ranges.forEach((range, index) => {
          const media = range.type.toLowerCase();
          const rank =
            media === type ? 2 : media === `${type.split("/")[0]}/*` ? 1 : media === "*/*" ? 0 : -1;
          if (rank > specificity) {
            specificity = rank;
            q = range.q;
            order = index;
          }
        });
        return { type, q, specificity, order };
      });
      candidates.sort((a, b) => b.q - a.q || b.specificity - a.specificity || a.order - b.order);
      const preferred = candidates[0]!;
      return preferred.q > 0 ? preferred.type : config.default;
    },
  });
}

// Shared outage envelope: no session/data reads, no driver details. Explicit
// JSON endpoints may opt in even without an Accept header.
export function databaseUnavailable(c: Context, jsonOnly = false): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(503);
  if (jsonOnly || jsonOnlyEventRequest(c) || outageRepresentation(c) === "application/json") {
    return c.json({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
    });
  }
  return c.html(<MaintenancePage inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)} />);
}

// Like the shared 429 response: one static envelope for API/JSON callers,
// a branded page for browsers, and no request body, field names or stack traces.
// The /api/ prefix is the fixed machine-only contract (returns JSON even if
// Accept prefers HTML); otherwise delegates to the quality selector so that
// q=0, specificity, case and wildcards match the outage contract. Always sets
// private no-store + Vary: Accept (merged).
export function payloadTooLarge(c: Context): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(413);
  if (c.req.path.startsWith("/api/") || outageRepresentation(c) === "application/json") {
    return c.json({
      reason: "payload_too_large",
      message: "Reduce the size of your request and try again.",
    });
  }
  return c.html(<PayloadTooLargePage />);
}

export function maintenanceHandler(
  inviteUrl: string,
): (c: Context) => Response | Promise<Response> {
  return (c) => {
    c.header("cache-control", "no-store, private");
    c.status(503);
    return c.html(<MaintenancePage inviteUrl={inviteUrl} />);
  };
}
