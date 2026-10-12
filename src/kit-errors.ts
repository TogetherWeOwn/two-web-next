// Branded Kit error copy + framework-free negotiation (TOG-22119).
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

export type KitErrorStatus = 404 | 403 | 410 | 429 | 500 | 503;

export interface KitErrorCopy {
  code: string;
  title: string;
  lead: string;
}

const COPY: Record<KitErrorStatus, KitErrorCopy> = {
  404: {
    code: "404",
    title: "We cannot find that page",
    lead: "The link may be old or mistyped, or the page may have moved.",
  },
  403: {
    code: "403",
    title: "You do not have access to this",
    lead: "This page is for members or moderators. If you should see it, sign in again.",
  },
  410: {
    code: "410",
    title: "This page is gone",
    lead: "The page was removed. The lobby is still open — come in and say hello.",
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
    lead: "The site is down for a minute of maintenance. The Discord server never closes.",
  },
};

export function isKitErrorStatus(status: number): status is KitErrorStatus {
  return (
    status === 404 ||
    status === 403 ||
    status === 410 ||
    status === 429 ||
    status === 500 ||
    status === 503
  );
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

function isMachinePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized === "/api" || normalized.startsWith("/api/")) return true;
  if (normalized === "/events.json") return true;
  const method = "GET";
  void method;
  // JSON-only event writes (src/error-responses.tsx jsonOnlyEventRequest parity
  // for the read side; writes are covered by path shapes below regardless of
  // method because this helper sees only the Request).
  if (normalized === "/events") return true;
  if (/^\/events\/[^/]+\/(publish|cancel|rsvp-pause|rsvp-reopen)$/.test(normalized)) return true;
  if (/^\/events\/[^/]+\/rsvp$/.test(normalized)) return true;
  if (/^\/events\/[^/]+$/.test(normalized)) return true;
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

/** "json" for machine contracts and JSON-preferring callers, else "html". */
export function negotiateKitError(request: Request): "json" | "html" {
  const path = normalizePath(new URL(request.url).pathname);
  if (isMachinePath(path)) return "json";
  return prefersJson(parseAccept(request.headers.get("accept"))) ? "json" : "html";
}
