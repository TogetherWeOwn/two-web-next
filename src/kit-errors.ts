// Branded Kit error copy + framework-free negotiation.
//
// The Hono shells in src/error-pages.tsx stay the HTML source of truth; this
// module carries the same copy as data so the SvelteKit error boundary
// (web/src/lib/ErrorShell.svelte, web/src/routes/+error.svelte) renders
// byte-identical titles without importing Hono JSX. No session, cookie or DB
// reads: every shell works without them, so recovery is always offerable.
//
// Negotiation mirrors src/error-responses.tsx (quality/specificity/q=0,
// machine-only contracts win, feeds stay non-HTML) but operates on a plain
// Request, so the Kit hook and Svelte loads can use it without a Hono Context.
//
// 400 is the one status without a RecoveryShell counterpart: its Hono twin is
// the member-shell board-filter page (src/leaderboards/pages.tsx), so the
// title and lead below are Kit's own client-error copy, never outage copy.
// 422 is the other: its Hono twin is the overlong-search notice page
// (EventsSearchTooLongPage in src/events/pages-calendar-screen.tsx), so the
// title and lead below match that notice exactly, never outage copy.

import { EVENTS_SEARCH_TOO_LONG_COPY } from "./islands/contracts";

export type KitErrorStatus = 400 | 404 | 403 | 410 | 422 | 429 | 500 | 503;

export interface KitErrorCopy {
  code: string;
  title: string;
  lead: string;
}

const COPY: Record<KitErrorStatus, KitErrorCopy> = {
  400: {
    code: "400",
    title: "Check your request",
    lead: "Check the address or filters and try again.",
  },
  404: {
    code: "404",
    title: "We cannot find that page",
    lead: "The link may be old or mistyped, or the page may have moved.",
  },
  403: {
    code: "403",
    title: "You do not have access to this",
    lead: "This page needs membership to unlock it — join to get in. Moderator-only areas stay locked otherwise.",
  },
  410: {
    code: "410",
    title: "This page is gone",
    lead: "The page was removed. The lobby is still open — come in and say hello.",
  },
  422: {
    code: "422",
    title: "Events",
    lead: EVENTS_SEARCH_TOO_LONG_COPY,
  },
  429: {
    code: "429",
    title: "Slow down a little",
    lead: "You have made a lot of requests in a short time. Wait a moment and try again.",
  },
  500: {
    code: "500",
    title: "Something broke on our side",
    lead: "It is not you. We have logged the failure and the team will take a look.",
  },
  503: {
    code: "503",
    title: "We will be right back",
    lead: "The site is temporarily unavailable. You can use the Discord invite or return to the homepage.",
  },
};

export function isKitErrorStatus(status: number): status is KitErrorStatus {
  return Object.hasOwn(COPY, status);
}

export function kitErrorCopy(status: KitErrorStatus): KitErrorCopy {
  return COPY[status];
}

const DATA_SUFFIX = "/__data.json";

function normalizePath(path: string): string {
  const withoutData = path.endsWith(DATA_SUFFIX) ? path.slice(0, -DATA_SUFFIX.length) : path;
  let out = withoutData;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out || "/";
}

function isMachinePath(path: string, method: string): boolean {
  if (path === "/api" || path.startsWith("/api/")) return true;
  // Match jsonOnlyEventRequest: browser GET/HEAD pages still negotiate.
  if (method === "GET" || method === "HEAD") return path === "/events.json";
  if (method === "POST") {
    return (
      path === "/events" ||
      /^\/events\/[^/]+\/(publish|cancel|duplicate|rsvp-pause|rsvp-reopen)$/.test(path)
    );
  }
  if (method === "PATCH") return /^\/events\/[^/]+$/.test(path);
  if (method === "PUT" || method === "DELETE") return /^\/events\/[^/]+\/rsvp$/.test(path);
  return false;
}

export function isFeedPath(path: string): boolean {
  return /\.rss$|\.ics$|\.md$|^\/llms\.txt$/.test(normalizePath(path));
}

interface AcceptRange {
  type: string;
  q: number;
  order: number;
}

function parseAccept(header: string | null): AcceptRange[] {
  if (!header) return [];
  return header.split(",").map((part, order) => {
    const [type, ...parameters] = part.split(";").map((p) => p.trim());
    let q = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameter);
      if (match) q = Number(match[1]);
    }
    return { type: (type ?? "*/*").toLowerCase(), q, order };
  });
}

// The most specific range determines each representation's quality, including
// q=0 exclusions; only then compare the supported responses. Mirrors
// outageRepresentation in src/error-responses.tsx.
function prefersJson(ranges: AcceptRange[]): boolean {
  const supports = ["text/html", "application/json"];
  const candidates = supports.map((type) => {
    let specificity = -1;
    let q = 0;
    let order = ranges.length;
    ranges.forEach((range, index) => {
      const media = range.type;
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
  const preferred = candidates[0];
  if (!preferred || preferred.q <= 0) return false;
  return preferred.type === "application/json";
}

/** Feeds stay "text"; machine contracts stay "json"; browser pages negotiate. */
export function negotiateKitError(request: Request): "json" | "html" | "text" {
  const path = normalizePath(new URL(request.url).pathname);
  if (isFeedPath(path)) return "text";
  if (isMachinePath(path, request.method)) return "json";
  return prefersJson(parseAccept(request.headers.get("accept"))) ? "json" : "html";
}
