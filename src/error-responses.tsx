import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { alertRequestError } from "./alerts";
import { isDatabaseUnavailable } from "./db/errors";
import {
  ForbiddenPage,
  GonePage,
  InternalErrorPage,
  MaintenancePage,
  NotFoundPage,
  PayloadTooLargePage,
  RateLimitedPage,
} from "./error-pages";
import type { SuggestedEvent } from "./events/suggestions";
import { inviteDestination } from "./invite";
import {
  bufferedMemberHtml,
  bufferedMemberJson,
  bufferedMemberText,
  memberReadActive,
} from "./member-reads";
import { cachedNotFoundSuggestions } from "./not-found-suggestions";
import { requestRoute, safeRequestId } from "./request-log";

function supportReference(c: Context): string | undefined {
  return safeRequestId(c.get("requestId"));
}

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
  alertRequestError(err, {
    method: c.req.method,
    route: requestRoute(c),
    requestId: c.get("requestId"),
  });
  if (memberReadActive()) {
    // Keep the log class-only; the alert above has the same privacy boundary.
    console.error("Member request failed; refusing contents.", {
      exception: err instanceof Error ? err.constructor.name : "unknown",
      request_id: safeRequestId(c.get("requestId")),
    });
    return bufferedMemberText(c, "Member data is temporarily unavailable.", 503);
  }
  if (isDatabaseUnavailable(err)) return databaseUnavailable(c);
  c.header("cache-control", "no-store, private");
  c.status(500);
  return c.html(
    <InternalErrorPage
      inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)}
      supportReference={supportReference(c)}
    />,
  );
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
// consistently; always emits private no-store + Vary: Accept. Feed paths
// keep their non-HTML contract (same branch as 403/410): a throttled feed
// reader's parser gets plain text, never the branded page or the envelope.
export function rateLimitExceeded(c: Context, retryAfter = 60): Response | Promise<Response> {
  const parsed = Math.floor(retryAfter);
  const n = Number.isFinite(parsed) ? Math.max(1, parsed) : 60;
  c.header("Retry-After", String(n));
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(429);
  if (isFeedErrorPath(c.req.path)) {
    return c.text("Too many requests", 429);
  }
  if (jsonOnlyEventRequest(c) || outageRepresentation(c) === "application/json") {
    const requestId = supportReference(c);
    return c.json({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${n} seconds.`,
      retry_after: n,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    });
  }
  return c.html(
    <RateLimitedPage
      inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)}
      supportReference={supportReference(c)}
    />,
  );
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
    const requestId = supportReference(c);
    return c.json({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
      ...(requestId === undefined ? {} : { request_id: requestId }),
    });
  }
  return c.html(
    <MaintenancePage
      inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)}
      supportReference={supportReference(c)}
    />,
  );
}

// Like the shared 429 response: one static envelope for API/JSON callers,
// a branded page for browsers, and no request body, field names or stack traces.
// The /api/ prefix and the JSON-only event write methods are the fixed
// machine-only contracts (return JSON even if Accept prefers HTML or is
// absent); otherwise delegates to the quality selector so that q=0,
// specificity, case and wildcards match the outage contract. Always sets
// private no-store + Vary: Accept (merged).
export function payloadTooLarge(c: Context): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(413);
  if (
    jsonOnlyEventRequest(c) ||
    c.req.path.startsWith("/api/") ||
    outageRepresentation(c) === "application/json"
  ) {
    return c.json({
      reason: "payload_too_large",
      message: "Reduce the size of your request and try again.",
    });
  }
  return c.html(<PayloadTooLargePage />);
}

// Feed contracts stay non-HTML: a calendar/RSS/Markdown caller never receives
// the branded shell. Mirrors the per-event ICS draft refusal ("Forbidden") and
// the ai-friendly Markdown envelope, so error helpers cannot swallow them.
function isFeedErrorPath(path: string): boolean {
  return /\.rss$|\.ics$|\.md$|^\/llms\.txt$/.test(path);
}

// Branded 403: one static envelope for API/JSON callers, plain
// text for feed paths (the existing draft-ICS contract), and the branded page
// for browsers. Machine-only event writes and /api/ return JSON even when
// Accept prefers HTML or is absent. Always private no-store + Vary: Accept.
export function forbidden(c: Context): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  c.status(403);
  if (isFeedErrorPath(c.req.path)) {
    return memberReadActive() ? bufferedMemberText(c, "Forbidden", 403) : c.text("Forbidden", 403);
  }
  if (
    jsonOnlyEventRequest(c) ||
    c.req.path.startsWith("/api/") ||
    outageRepresentation(c) === "application/json"
  ) {
    const body = {
      error: "forbidden",
      message: "You do not have access to this.",
    };
    return memberReadActive() ? bufferedMemberJson(c, body, 403) : c.json(body);
  }
  const page = <ForbiddenPage inviteUrl={inviteDestination(c.env?.DISCORD_INVITE_URL)} />;
  return memberReadActive() ? bufferedMemberHtml(c, page, 403) : c.html(page);
}

// Branded 410 for explicitly retired documents. Unknown and
// URL-freeze-retired paths stay 404; cancelled events keep their dedicated
// EventGonePage. Same negotiation as 403: JSON envelope for machine callers,
// plain text for feeds, branded shell for browsers. Gone is
// viewer-independent, so the cache header is private, no-store.
export function gone(c: Context): Response | Promise<Response> {
  c.header("cache-control", "private, no-store");
  varyAccept(c);
  c.status(410);
  if (isFeedErrorPath(c.req.path)) {
    return memberReadActive() ? bufferedMemberText(c, "Gone", 410) : c.text("Gone", 410);
  }
  if (
    jsonOnlyEventRequest(c) ||
    c.req.path.startsWith("/api/") ||
    outageRepresentation(c) === "application/json"
  ) {
    const body = {
      reason: "gone",
      message: "This page is gone.",
    };
    return memberReadActive() ? bufferedMemberJson(c, body, 410) : c.json(body);
  }
  const page = <GonePage />;
  return memberReadActive() ? bufferedMemberHtml(c, page, 410) : c.html(page);
}

export function maintenanceHandler(
  inviteUrl: string,
): (c: Context) => Response | Promise<Response> {
  return (c) => {
    c.header("cache-control", "no-store, private");
    c.status(503);
    return c.html(<MaintenancePage inviteUrl={inviteUrl} supportReference={supportReference(c)} />);
  };
}
