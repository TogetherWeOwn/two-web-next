// TOG-12090 (W15c): sitemap + meta-tag rows, island-independent.
//
// Ports the legacy two-web Pest rows that need no RSVP islands:
//   - tests/Feature/SitemapTest.php @ e1e939a (lines 6-86):
//       :6   "advertises the public pages as XML" — home/join/events.index
//            present, profile/login.callback absent, XML content type.
//       :21  "lists published event pages with lastmod, never drafts, gone
//            or gated URLs" — one published /e/{key} row with lastmod =
//            updated_at atom string; draft/cancelled/past excluded; every loc
//            same-host with no /profile, /members/, /events.json, /auth/,
//            /admin leak; the advertised page opens 200 for a guest.
//       :75  "serves a valid sitemap with no events" — static leaves only.
//   - tests/Feature/ShareMetaTagsTest.php @ e1e939a (lines 9-76):
//       :28  "tags the homepage for sharing" — canonical + OG/Twitter set.
//       :39  "tags the join page for sharing" — own canonical + intro.
//       :50  "tags the events page for sharing" — /events canonical, title
//            "Events — Together We Own", community description.
//       :61  "keeps exactly one canonical per page, pointing at itself".
//
// Local fixtures only: pg-proxy DB (no agent-testdb), memory sessions, a
// DISCORD_EVENTS stub. A throwing global fetch proves nothing reaches
// Discord, a preview service or a staging/production database. The sitemap
// rows go through the real GET /sitemap_index.xml route (dbFor reads the
// injected ADMIN_DB); the meta rows through the real page routes.

import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { JOIN_INTRO } from "../src/pages";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";

const HOME_TITLE = "Together We Own — the lobby is open";
const HOME_DESCRIPTION = "We spent most of our life private. Now you can just turn up.";
const JOIN_TITLE = "Join Together We Own";
const EVENTS_TITLE = "Events — Together We Own";
const EVENTS_DESCRIPTION = "Game nights, tournaments and whatever else the community puts on.";

type EventRow = typeof events.$inferSelect;

let rowSeq = 0;
function eventRow(over: Partial<EventRow> = {}): EventRow {
  const n = ++rowSeq;
  const start = new Date(Date.UTC(2030, 0, 10 + n, 20));
  const end = new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `01ARZ3NDEKTSV4RRFFQ69G5FA${String(n).padStart(2, "0")}`,
    title: `Game night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    syncRevision: 1,
    syncedRevision: 0,
    ...over,
  };
}

// pg-proxy answers the queries the sitemap + /events routes issue:
// sitemapEvents (status = published, order by starts_at), the /events
// calendar reads (upcoming/past by ends_at, identity probes, RSVP counts)
// and the member-data access-log write. Anything else throws, so a new
// query shape fails loudly instead of silently returning empty rows.
function harness(rows: EventRow[]) {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((k) => (row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k]));
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    if (sql.startsWith('insert into "member_data_access_logs"') || sql.startsWith("SET LOCAL"))
      return { rows: [] };
    if (sql.includes('from "events"')) {
      // sitemapEvents filters status = published; calendar reads filter on
      // ends_at. Honor both, then encode full rows in column order.
      let out = rows;
      if (sql.includes('"status" =') || sql.includes("= 'published'") || sql.includes("status")) {
        out =
          params.length > 0 && typeof params[0] === "string"
            ? rows.filter((r) => r.status === params[0])
            : rows.filter((r) => r.status === "published");
      }
      if (/"ends_at" </.test(sql)) out = out.filter((r) => r.endsAt < new Date());
      else if (/"ends_at" >=/.test(sql)) out = out.filter((r) => r.endsAt >= new Date());
      return { rows: out.map(encode) };
    }
    throw new Error(`Unexpected sitemap-meta fixture query: ${sql}`);
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const env = {
    APP_URL,
    SESSION_SECRET: SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/configured",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
  return { env, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

beforeEach(() => {
  // Even a swallowed fetch error is a test failure: nothing reaches Discord,
  // a preview service or a staging/production database in this suite.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("sitemap-meta tests must remain local");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// SitemapTest.php:6 — the static leaves ship as XML with the right content
// type; auth-gated and machine URLs never appear.
describe("sitemap static leaves (SitemapTest.php:6)", () => {
  it("advertises home, join, events.index and the leaves as XML", async () => {
    const res = await harness([]).request("/sitemap_index.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=UTF-8");
    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    for (const loc of [
      `${APP_URL}/`,
      `${APP_URL}/join`,
      `${APP_URL}/events`,
      `${APP_URL}/about`,
      `${APP_URL}/faq`,
      `${APP_URL}/rules`,
      `${APP_URL}/privacy`,
    ]) {
      expect(xml, loc).toContain(`<loc>${loc}</loc>`);
    }
    for (const banned of ["/profile", "/members/", "/events.json", "/auth/", "/admin"]) {
      expect(xml, banned).not.toContain(banned);
    }
  });

  it("pins changefreq/priority per entry, matching the legacy sitemap", async () => {
    const xml = await (await harness([]).request("/sitemap_index.xml")).text();
    const entry = (loc: string, changefreq: string, priority: string) => {
      const block = new RegExp(
        `<url>\\s*<loc>${loc.replace(/[./]/g, (c) => `\\${c}`)}</loc>[\\s\\S]*?</url>`,
        "m",
      ).exec(xml);
      expect(block, loc).not.toBeNull();
      expect(block![0]).toContain(`<changefreq>${changefreq}</changefreq>`);
      expect(block![0]).toContain(`<priority>${priority}</priority>`);
    };
    entry(`${APP_URL}/`, "weekly", "1.0");
    entry(`${APP_URL}/join`, "monthly", "0.9");
    entry(`${APP_URL}/events`, "daily", "0.8");
    for (const leaf of ["about", "faq", "rules", "privacy"]) {
      entry(`${APP_URL}/${leaf}`, "monthly", "0.7");
    }
    // No past archive, no feeds: the crawl set is index pages + published events.
    expect(xml).not.toContain("/events/past");
    expect(xml).not.toContain("/events.rss");
  });

  // SitemapTest.php:75 — with no events the sitemap is still valid XML with
  // the static leaves.
  it("serves a valid sitemap with no events", async () => {
    const xml = await (await harness([]).request("/sitemap_index.xml")).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const loc of [`${APP_URL}/`, `${APP_URL}/join`, `${APP_URL}/events`]) {
      expect(locs).toContain(loc);
    }
    expect(xml.match(/<url>/g)).toHaveLength(locs.length);
  });
});

// SitemapTest.php:21 — published events are advertised with lastmod; drafts,
// cancelled and past rows stay out; every loc is same-host.
describe("sitemap published events (SitemapTest.php:21)", () => {
  const UPDATED = new Date("2026-09-01T00:00:00Z");
  const live = eventRow({ id: 11, title: "Live night", updatedAt: UPDATED });
  const draft = eventRow({ id: 12, title: "Draft night", status: "draft" });
  const cancelled = eventRow({ id: 13, title: "Gone night", status: "cancelled" });
  const past = eventRow({ id: 14, title: "Old night", status: "past" });

  it("lists the published event once with lastmod = updated_at", async () => {
    const rows = [live, draft, cancelled, past];
    const xml = await (await harness(rows).request("/sitemap_index.xml")).text();
    const loc = `${APP_URL}/e/${live.eventKey}`;
    expect(xml.match(new RegExp(`<loc>${loc}</loc>`, "g"))).toHaveLength(1);
    expect(xml).toContain(`<lastmod>${UPDATED.toISOString()}</lastmod>`);
    const matches = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)]
      .map((m) => m[1])
      .filter((block) => (block ?? "").includes(`<loc>${loc}</loc>`));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain("<changefreq>weekly</changefreq>");
    expect(matches[0]).toContain("<priority>0.6</priority>");
  });

  it("keeps drafts, cancelled and past events out of the index", async () => {
    const xml = await (
      await harness([live, draft, cancelled, past]).request("/sitemap_index.xml")
    ).text();
    expect(xml).toContain(`<loc>${APP_URL}/e/${live.eventKey}</loc>`);
    for (const hidden of [draft, cancelled, past]) {
      expect(xml, hidden.eventKey).not.toContain(`/e/${hidden.eventKey}`);
    }
  });

  it("leaks no gated, API or wrong-host URLs", async () => {
    const xml = await (
      await harness([live, draft, cancelled, past]).request("/sitemap_index.xml")
    ).text();
    for (const loc of [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)) {
      expect(loc, "same host").toMatch(new RegExp(`^${APP_URL.replace(/[./]/g, (c) => `\\${c}`)}`));
      for (const banned of ["/profile", "/members/", "/events.json", "/auth/", "/admin"]) {
        expect(loc, banned).not.toContain(banned);
      }
    }
  });
});

// ShareMetaTagsTest.php:28,39 — home and join carry their own canonical plus
// the full OG/Twitter set; exactly one self-pointing canonical each.
describe("share meta home + join (ShareMetaTagsTest.php:28,39,61)", () => {
  const tags = (html: string, canonical: string, title: string, description: string) => {
    for (const needle of [
      `<title>${title}</title>`,
      `<meta name="description" content="${description}"/>`,
      `<link rel="canonical" href="${canonical}"`,
      '<meta property="og:type" content="website"',
      '<meta property="og:site_name" content="Together We Own"',
      `<meta property="og:url" content="${canonical}"`,
      `<meta property="og:title" content="${title}"`,
      `<meta property="og:description" content="${description}"`,
      '<meta name="twitter:card" content="summary"',
      `<meta name="twitter:title" content="${title}"`,
      `<meta name="twitter:description" content="${description}"`,
    ]) {
      expect(html, needle).toContain(needle);
    }
  };

  it("tags the homepage for sharing", async () => {
    const html = await (await harness([]).request("/")).text();
    tags(html, `${APP_URL}/`, HOME_TITLE, HOME_DESCRIPTION);
    expect(html).not.toContain("og:image");
  });

  it("tags the join page with its own canonical and the funnel intro", async () => {
    const html = await (await harness([]).request("/join")).text();
    tags(html, `${APP_URL}/join`, JOIN_TITLE, JOIN_INTRO);
  });

  it("keeps exactly one canonical per page, pointing at itself", async () => {
    const src = harness([]);
    for (const [path, canonical] of [
      ["/", `${APP_URL}/`],
      ["/join", `${APP_URL}/join`],
    ] as const) {
      const html = await (await src.request(path)).text();
      expect(html.match(/rel="canonical"/g), path).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
    }
  });
});

// ShareMetaTagsTest.php:50,61 — the events index carries its own canonical
// plus the full OG/Twitter set, exactly once and self-pointing.
describe("share meta events index (ShareMetaTagsTest.php:50,61)", () => {
  it("tags the events page for sharing", async () => {
    const res = await harness([eventRow()]).request("/events");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${EVENTS_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${EVENTS_DESCRIPTION}"/>`);
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/events"`);
    expect(html).toContain(`<meta property="og:url" content="${APP_URL}/events"`);
    expect(html).toContain(`<meta property="og:title" content="${EVENTS_TITLE}"`);
    expect(html).toContain(`<meta property="og:description" content="${EVENTS_DESCRIPTION}"`);
    expect(html).toContain(`<meta name="twitter:title" content="${EVENTS_TITLE}"`);
    expect(html).toContain(`<meta name="twitter:description" content="${EVENTS_DESCRIPTION}"`);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });
});

// The static leaves ship shareable titles/descriptions through the same
// Layout head: one canonical each, no tag duplication.
describe("share meta static leaves", () => {
  it.each([
    ["/about", "About — Together We Own"],
    ["/faq", "FAQ — Together We Own"],
    ["/rules", "House rules — Together We Own"],
    ["/privacy", "Privacy policy — Together We Own"],
  ])("%s carries its title, one canonical and feed autodiscovery", async (path, title) => {
    const html = await (await harness([]).request(path)).text();
    expect(html).toContain(`<title>${title}</title>`);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}${path}"`);
    expect(html).toContain(`<meta property="og:title" content="${title}"`);
    expect(html).toContain('type="application/rss+xml"');
  });
});
