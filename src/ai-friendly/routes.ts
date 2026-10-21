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
import { robotsTagFor } from "../headers";
import { requestRoute } from "../request-log";
import { rulesLastUpdated } from "../rules-last-updated";
import {
  FEED_MD_CACHE,
  MARKDOWN_MIME,
  STATIC_MD_CACHE,
  llmsTxt,
  mdAbout,
  mdEvent,
  mdEventGone,
  mdEvents,
  mdFaq,
  mdJoin,
  mdPrivacy,
  mdRules,
  type MdEvent,
} from "./md";

type App = Hono<{ Bindings: Env }>;

type Ctx = Context<{ Bindings: Env }>;

const NOINDEX = "noindex, nofollow";

/** Staging/preview/dev builds noindex every machine format (production apex only indexes). */
function stagingRobots(c: Ctx): string | null {
  let serving: string | undefined;
  try {
    serving = new URL(c.req.url).hostname;
  } catch {
    serving = undefined;
  }
  return robotsTagFor(c.env.APP_URL, serving);
}

function mdOk(c: Ctx, body: string, cache: string, robots?: string): Response {
  const tag = robots ?? stagingRobots(c);
  if (tag) c.header("x-robots-tag", tag);
  c.header("cache-control", cache);
  return c.body(body, 200, { "content-type": MARKDOWN_MIME });
}

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
async function mdRead<T>(c: Ctx, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (err) {
    if (isDatabaseUnavailable(err)) return mdUnavailable(c);
    alertRequestError(err, {
      method: c.req.method,
      route: requestRoute(c),
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
  app.get("/llms.txt", (c) => mdOk(c, llmsTxt(c.env.APP_URL), STATIC_MD_CACHE));
  app.get("/about.md", (c) => mdOk(c, mdAbout(c.env.APP_URL), STATIC_MD_CACHE));
  app.get("/faq.md", (c) => mdOk(c, mdFaq(c.env.APP_URL), STATIC_MD_CACHE));
  app.get("/rules.md", (c) =>
    mdOk(c, mdRules(c.env.APP_URL, rulesLastUpdated(c.env.RULES_LAST_UPDATED)), STATIC_MD_CACHE),
  );
  app.get("/privacy.md", (c) => mdOk(c, mdPrivacy(c.env.APP_URL), STATIC_MD_CACHE));
  app.get("/join.md", (c) =>
    mdOk(c, mdJoin(c.env.APP_URL, c.env.DISCORD_INVITE_URL), STATIC_MD_CACHE),
  );

  app.get("/events.md", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return mdUnavailable(c);
    // Query and serialization stay inside the envelope together: a corrupt
    // row faults Markdown either way.
    const built = await mdRead(c, async () =>
      mdEvents(c.env.APP_URL, (await listFeed(db, ["published"])).map(toMdEvent)),
    );
    if (built instanceof Response) return built;
    return mdOk(c, built, FEED_MD_CACHE);
  });

  // Same suffix pattern as the per-event ICS export: one canonical key form
  // per event, forged keys refuse, unknown keys 404.
  app.get("/e/:file{.+\\.md}", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const key = c.req.param("file").slice(0, -3);
    const canonical = canonicalEventKey(key);
    if (canonical && canonical !== key) {
      const search = new URL(c.req.url).search;
      return c.redirect(`/e/${encodeURIComponent(canonical)}.md${search}`, 301);
    }
    if (!eventKeyAllowed(key, c.env.APP_URL)) return mdError(c, "Not found", 404);
    const db = await dbFor(c);
    if (!db) return mdUnavailable(c);
    const e = await mdRead(c, () => getPublicEvent(db, key));
    if (e instanceof Response) return e;
    if (!e) return mdError(c, "Not found", 404);
    if (e.status === "draft") return mdError(c, "Forbidden", 403);
    if (e.status === "cancelled") {
      const gone = await mdRead(c, async () => mdEventGone(c.env.APP_URL, e));
      if (gone instanceof Response) return gone;
      return mdError(c, gone, 410);
    }
    const robots = e.status === "past" ? NOINDEX : undefined;
    const built = await mdRead(c, async () => mdEvent(c.env.APP_URL, toMdEvent(e)));
    if (built instanceof Response) return built;
    return mdOk(c, built, FEED_MD_CACHE, robots);
  });
}
