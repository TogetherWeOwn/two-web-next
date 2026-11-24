// AI-friendly machine routes (A2): GET /llms.txt + curated .md alternates.
//
// New routes, not Accept negotiation: the URL freeze allows one media type
// per route. Every response is viewer-independent (no session read, no cookie
// set) so the shared-cache TTLs below are safe. Drafts refuse, cancelled
// events answer 410, unknown keys 404 — mirroring the HTML detail contract
// for non-moderators without leaking member data.
import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { dbFor } from "../admin/db";
import { alertRequestError } from "../alerts";
import { canonicalEventKey, eventKeyAllowed } from "../events/keys";
import { getPublicEvent, listFeed } from "../events/reads";
import { publicReadGuard } from "../events/routes-shared";
import { isDatabaseUnavailable } from "../db/errors";
import { mdOk, staticMarkdown } from "../static-public";
import { EVENT_MARKDOWN_PATH, EVENTS_MARKDOWN_PATH } from "./kit-event-markdown-routes";
import { FEED_MD_CACHE, MARKDOWN_MIME, mdEvent, mdEventGone, mdEvents, type MdEvent } from "./md";

type App = Hono<{ Bindings: Env }>;

type Ctx = Context<{ Bindings: Env }>;

const NOINDEX = "noindex, nofollow";

function mdError(c: Ctx, body: string, status: 403 | 404 | 410): Response {
  c.header("x-robots-tag", NOINDEX);
  c.header("cache-control", status === 410 ? "private, no-store" : "no-store, private");
  return c.body(body, status, { "content-type": MARKDOWN_MIME });
}

/** Outage envelope in the route's own media type: never branded HTML, never driver details. */
function mdUnavailable(c: Ctx): Response {
  c.header("cache-control", "no-store, private");
  return c.body("Events temporarily unavailable", 503, { "content-type": MARKDOWN_MIME });
}

/** Unexpected-fault envelope in the route's own media type: static guidance, never internals. */
function mdInternal(c: Ctx): Response {
  c.header("cache-control", "no-store, private");
  return c.body("Events temporarily unavailable. Try again shortly.", 500, {
    "content-type": MARKDOWN_MIME,
  });
}

/**
 * Reads stay inside the markdown envelope: a dead database 503s as Markdown,
 * and unexpected query/serializer faults alert once (class fingerprint, the
 * same privacy boundary as the global handler) and 500 as Markdown.
 */
async function mdRead<T>(c: Ctx, route: string, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (err) {
    if (isDatabaseUnavailable(err)) return mdUnavailable(c);
    alertRequestError(err, {
      method: c.req.method,
      route,
      requestId: c.get("requestId"),
    });
    return mdInternal(c);
  }
}

const toMdEvent = (e: {
  eventKey: string;
  title: string;
  game: string | null;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
  status: string;
  goingCount?: number | null;
  goingOccupancy?: number | null;
  /** Carried through to MdEvent; the detail builder renders the section. */
  accessibilityNotes?: string | null;
  organizer_name?: string | null;
  join_url?: string | null;
  join_instructions?: string | null;
}): MdEvent => ({
  ...e,
  goingCount: e.goingCount ?? null,
  // Feed rows carry no counts, so the full signal stays off there; the
  // detail row carries both aggregates from withGoing.
  goingOccupancy: e.goingOccupancy ?? null,
  // Callers only pass published/past rows: the collection predicate filters in
  // SQL and the detail handler returns drafts/cancelled above.
  status: e.status as MdEvent["status"],
});

export function registerAiFriendlyRoutes(app: App): void {
  app.get("/llms.txt", staticMarkdown["/llms.txt"]);
  app.get("/about.md", staticMarkdown["/about.md"]);
  app.get("/faq.md", staticMarkdown["/faq.md"]);
  app.get("/rules.md", staticMarkdown["/rules.md"]);
  app.get("/privacy.md", staticMarkdown["/privacy.md"]);
  app.get("/join.md", staticMarkdown["/join.md"]);

  app.get(EVENTS_MARKDOWN_PATH, eventMarkdownHandlers.collection);

  // Keep the suffix handler ahead of the generic /e/:key document.
  app.get(EVENT_MARKDOWN_PATH, (c) =>
    eventMarkdownHandlers.detail(c, () => c.req.param("file").slice(0, -3)),
  );
}

export const eventMarkdownHandlers = {
  async collection(c: Ctx): Promise<Response> {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return mdUnavailable(c);
    // Query and serialization stay inside the envelope together: a corrupt
    // row faults Markdown either way.
    const built = await mdRead(c, EVENTS_MARKDOWN_PATH, async () =>
      mdEvents(c.env.APP_URL, (await listFeed(db, ["published"])).map(toMdEvent)),
    );
    if (built instanceof Response) return built;
    return mdOk(c, built, FEED_MD_CACHE);
  },

  async detail(c: Ctx, keyFor: () => string): Promise<Response> {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const key = keyFor();
    const canonical = canonicalEventKey(key);
    if (canonical && canonical !== key) {
      const search = new URL(c.req.url).search;
      return c.redirect(`/e/${encodeURIComponent(canonical)}.md${search}`, 301);
    }
    if (!eventKeyAllowed(key, c.env.APP_URL)) return mdError(c, "Not found", 404);
    const db = await dbFor(c);
    if (!db) return mdUnavailable(c);
    const e = await mdRead(c, EVENT_MARKDOWN_PATH, () => getPublicEvent(db, key));
    if (e instanceof Response) return e;
    if (!e) return mdError(c, "Not found", 404);
    if (e.status === "draft") return mdError(c, "Forbidden", 403);
    if (e.status === "cancelled") {
      const gone = await mdRead(c, EVENT_MARKDOWN_PATH, async () => mdEventGone(c.env.APP_URL, e));
      if (gone instanceof Response) return gone;
      return mdError(c, gone, 410);
    }
    const robots = e.status === "past" ? NOINDEX : undefined;
    const built = await mdRead(c, EVENT_MARKDOWN_PATH, async () =>
      mdEvent(c.env.APP_URL, toMdEvent(e)),
    );
    if (built instanceof Response) return built;
    return mdOk(c, built, FEED_MD_CACHE, robots);
  },
};
