// route-inventory: GET /events.rss
// RSS cancelled-event signalling acceptance (Test Author owned; the Builder
// must never edit this file). Offline pg-proxy fixtures drive the real route;
// no database, session store or network is contacted.
//
// Accepted contract (roadmap U2):
// - /events.rss includes cancelled events from the same upcoming window
//   listFeed enforces (ends_at >= now, finite/renderable), ordered with
//   published rows by (starts_at, id).
// - Each cancelled item is marked unmistakably: the title is prefixed with
//   `Cancelled: ` and the description carries the one-line note
//   `This event has been cancelled.` appended to the original description
//   (or standing alone when the event has no description).
// - link, guid (isPermaLink="true") and pubDate bytes for a cancelled item
//   match the published rendering of the same row; no <enclosure> appears.
// - Published items are byte-identical to the pre-change feed; channel
//   cache, content-type, ETag/304 and sessionless behavior are unchanged;
//   the feed still costs exactly one statement however many items it holds.
//
// The XML reader below is this suite's real RSS parser: it tokenizes the
// document, validates well-formedness (balanced tags, no stray markup, no
// undeclared entities) and decodes entities into item fields. Title and
// description assertions read parsed fields, never regexes over the
// production encoder's output.
//
// RED on the unmodified tree: the eight "cancelled" tests fail by assertion
// (the item is absent, so the prefix/note/order/statuses checks cannot
// hold). GREEN controls: the eight "preserved" tests pass before and after.
import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import app from "./app";
import { APP_URL, type CalendarRow, calendarRow } from "./helpers/ics-wire-fixture";

const CANCELLED_TITLE_PREFIX = "Cancelled: ";
const CANCELLED_NOTE = "This event has been cancelled.";

const PUB_KEY = "01J0000000000000000000PB01";
const CAN_KEY = "01J0000000000000000000CA01";
const END_KEY = "01J0000000000000000000EN01";
const TRICKY_PUB_KEY = "01J0000000000000000000TP01";
const TRICKY_CAN_KEY = "01J0000000000000000000TC01";
const NODESC_CAN_KEY = "01J0000000000000000000ND01";

const TRICKY_TITLE = `A & "B" <c> 🎮 東京`;
const TRICKY_DESCRIPTION = `it's <b>bold</b> & "quoted"`;

const columns = Object.keys(getTableColumns(events)) as (keyof CalendarRow)[];

function pubRow(): CalendarRow {
  return calendarRow({
    id: 1,
    eventKey: PUB_KEY,
    title: "Friday night Helldivers",
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    status: "published",
    updatedAt: new Date("2026-07-01T12:00:00Z"),
  });
}

function cancelledRow(): CalendarRow {
  return calendarRow({
    id: 2,
    eventKey: CAN_KEY,
    title: "Saturday night raid",
    description: "Bring meds.",
    startsAt: new Date("2026-07-16T18:00:00Z"),
    endsAt: new Date("2026-07-16T20:00:00Z"),
    status: "cancelled",
    updatedAt: new Date("2026-07-02T12:00:00Z"),
  });
}

function endedCancelledRow(): CalendarRow {
  return calendarRow({
    id: 3,
    eventKey: END_KEY,
    title: "Old cancelled night",
    startsAt: new Date("2026-07-10T18:00:00Z"),
    endsAt: new Date("2026-07-10T20:00:00Z"),
    status: "cancelled",
    updatedAt: new Date("2026-07-01T12:00:00Z"),
  });
}

/** Hand-derived channel head: lastBuildDate is the caller's wire instant. */
function channelHead(lastBuildDate: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
    "<title>Together We Own Events</title>" +
    `<link>${APP_URL}/events</link>` +
    `<atom:link href="${APP_URL}/events.rss" rel="self" type="application/rss+xml" />` +
    "<description>Upcoming events from Together We Own</description>" +
    "<ttl>5</ttl>" +
    `<lastBuildDate>${lastBuildDate}</lastBuildDate>`
  );
}

/** Hand-derived published item bytes for the pubRow() fixture. */
const PUB_ITEM =
  `<item><title>Friday night Helldivers</title><link>${APP_URL}/e/${PUB_KEY}</link>` +
  `<guid isPermaLink="true">${APP_URL}/e/${PUB_KEY}</guid>` +
  "<pubDate>Wed, 15 Jul 2026 18:00:00 +0000</pubDate>" +
  "<description>Bring stims.</description></item>";

/** Hand-derived cancelled item bytes for the cancelledRow() fixture. */
const CANCELLED_ITEM =
  `<item><title>Cancelled: Saturday night raid</title><link>${APP_URL}/e/${CAN_KEY}</link>` +
  `<guid isPermaLink="true">${APP_URL}/e/${CAN_KEY}</guid>` +
  "<pubDate>Thu, 16 Jul 2026 18:00:00 +0000</pubDate>" +
  `<description>Bring meds. ${CANCELLED_NOTE}</description></item>`;

// ---------------------------------------------------------------------------
// Independent RSS reader: a minimal well-formedness parser, not a regex over
// the production encoder's output. Rejects mismatched/unclosed tags, stray
// "&"/"<" in text, and undeclared entities; decodes the predefined and
// numeric entities into parsed fields.
// ---------------------------------------------------------------------------

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const decoded = ENTITIES[body];
    if (decoded === undefined) throw new Error(`Undeclared XML entity: ${entity}`);
    return decoded;
  });
}

function parseRss(document: string): XmlNode {
  const decl = '<?xml version="1.0" encoding="UTF-8"?>\n';
  expect(document.startsWith(decl)).toBe(true);
  const body = document.slice(decl.length);
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_:][\w:.-]*)\s*>|<([A-Za-z_:][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*\/>|<([A-Za-z_:][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*>|([^<]+)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  const parseAttrs = (raw: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (const attr of raw.matchAll(/\s+([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
      attrs[attr[1]!] = decodeEntities(attr[2]!);
    }
    return attrs;
  };
  while ((match = token.exec(body)) !== null) {
    consumed = token.lastIndex;
    const [full, endName, emptyName, emptyAttrs, startName, startAttrs, text] = match;
    if (text !== undefined) {
      if (/[<>]/.test(text)) throw new Error(`Stray markup in text: ${JSON.stringify(text)}`);
      stack[stack.length - 1]!.text += decodeEntities(text);
      continue;
    }
    if (full.startsWith("<!--") || full.startsWith("<?")) continue;
    if (endName !== undefined) {
      const open = stack.pop();
      if (open === undefined || open.name !== endName) {
        throw new Error(`Mismatched end tag </${endName}>`);
      }
      continue;
    }
    if (emptyName !== undefined) {
      stack[stack.length - 1]!.children.push({
        name: emptyName,
        attrs: parseAttrs(emptyAttrs ?? ""),
        children: [],
        text: "",
      });
      continue;
    }
    if (startName !== undefined) {
      const node: XmlNode = {
        name: startName,
        attrs: parseAttrs(startAttrs ?? ""),
        children: [],
        text: "",
      };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    }
  }
  if (consumed !== body.length) throw new Error("Unparsed trailing bytes in RSS document");
  if (stack.length !== 1) throw new Error("Unclosed tags in RSS document");
  expect(root.children).toHaveLength(1);
  return root.children[0]!;
}

function child(node: XmlNode, name: string): XmlNode {
  const found = node.children.filter((c) => c.name === name);
  expect(found, `expected one <${name}> in <${node.name}>`).toHaveLength(1);
  return found[0]!;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

function maybeChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

type ParsedItem = {
  title: string;
  link: string;
  guid: string;
  guidPermaLink: string | undefined;
  pubDate: string;
  description: string | null;
};

function parsedItems(document: string): { lastBuildDate: string; items: ParsedItem[] } {
  const channel = child(parseRss(document), "channel");
  const items = children(channel, "item").map((item) => ({
    title: child(item, "title").text,
    link: child(item, "link").text,
    guid: child(item, "guid").text,
    guidPermaLink: child(item, "guid").attrs["isPermaLink"],
    pubDate: child(item, "pubDate").text,
    description: maybeChild(item, "description")?.text ?? null,
  }));
  return { lastBuildDate: child(channel, "lastBuildDate").text, items };
}

// ---------------------------------------------------------------------------
// Route fixture: the real /events.rss route over an injected pg-proxy that
// answers the feed read from local rows. It honors whatever statuses the
// route asks for, so the statuses assertion below reads the route's behavior.
// ---------------------------------------------------------------------------

function feedSource(rows: CalendarRow[]) {
  const seenStatuses: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes('from "events"') || !sql.includes('"status" in')) {
      throw new Error("Unexpected RSS fixture query");
    }
    for (const param of params) {
      if (param === "published" || param === "cancelled") seenStatuses.push(param);
    }
    const cutoff = params.find(
      (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    if (typeof cutoff !== "string") throw new Error("Expected feed cutoff");
    const now = new Date(cutoff);
    return {
      rows: rows
        .filter((row) => seenStatuses.includes(row.status) && row.endsAt >= now)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id)
        .map((row) =>
          columns.map((key) => {
            const value = row[key];
            return value instanceof Date
              ? Number.isFinite(value.getTime())
                ? value.toISOString()
                : "infinity"
              : value;
          }),
        ),
    };
  });
  const env = { APP_URL, ADMIN_DB: drizzle(query) as unknown as Db } as unknown as Env;
  return {
    query,
    seenStatuses,
    request: (init: RequestInit = {}) => app.request("/events.rss", init, env),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T19:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RSS cancelled-event signalling (acceptance)", () => {
  it("includes an upcoming cancelled event in /events.rss", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const response = await source.request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PUB_KEY);
    expect(body).toContain(CAN_KEY);
    expect(body).toContain(CANCELLED_ITEM);
    expect(body.match(/<item>/g)).toHaveLength(2);
  });

  it("marks the cancelled item title with the unmistakable prefix", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const body = await (await source.request()).text();
    const { items } = parsedItems(body);
    const cancelled = items.find((item) => item.guid === `${APP_URL}/e/${CAN_KEY}`);
    expect(cancelled, "cancelled item present in the parsed feed").toBeDefined();
    expect(cancelled!.title).toBe(`${CANCELLED_TITLE_PREFIX}Saturday night raid`);
    const published = items.find((item) => item.guid === `${APP_URL}/e/${PUB_KEY}`);
    expect(published!.title).toBe("Friday night Helldivers");
  });

  it("carries the one-line cancellation note in the cancelled description", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const body = await (await source.request()).text();
    const { items } = parsedItems(body);
    const cancelled = items.find((item) => item.guid === `${APP_URL}/e/${CAN_KEY}`);
    expect(cancelled, "cancelled item present in the parsed feed").toBeDefined();
    expect(cancelled!.description).toBe(`Bring meds. ${CANCELLED_NOTE}`);
  });

  it("gives a cancelled event without a description a note-only description element", async () => {
    const noDesc = calendarRow({
      id: 4,
      eventKey: NODESC_CAN_KEY,
      title: "Quiet cancelled night",
      description: null,
      startsAt: new Date("2026-07-17T18:00:00Z"),
      endsAt: new Date("2026-07-17T20:00:00Z"),
      status: "cancelled",
      updatedAt: new Date("2026-07-01T12:00:00Z"),
    });
    const source = feedSource([pubRow(), noDesc]);
    const body = await (await source.request()).text();
    expect(body).toContain(`<guid isPermaLink="true">${APP_URL}/e/${NODESC_CAN_KEY}</guid>`);
    const { items } = parsedItems(body);
    const cancelled = items.find((item) => item.guid === `${APP_URL}/e/${NODESC_CAN_KEY}`);
    expect(cancelled, "cancelled item present in the parsed feed").toBeDefined();
    expect(cancelled!.title).toBe(`${CANCELLED_TITLE_PREFIX}Quiet cancelled night`);
    expect(cancelled!.description).toBe(CANCELLED_NOTE);
  });

  it("reads both published and cancelled statuses in the feed query", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const response = await source.request();
    expect(response.status).toBe(200);
    expect(source.query).toHaveBeenCalledTimes(1);
    expect(source.seenStatuses).toContain("published");
    expect(source.seenStatuses).toContain("cancelled");
  });

  it("round-trips an HTML-shaped/Unicode cancelled title through the parser", async () => {
    const tricky = calendarRow({
      id: 5,
      eventKey: TRICKY_CAN_KEY,
      title: TRICKY_TITLE,
      description: TRICKY_DESCRIPTION,
      startsAt: new Date("2026-07-18T18:00:00Z"),
      endsAt: new Date("2026-07-18T20:00:00Z"),
      status: "cancelled",
      updatedAt: new Date("2026-07-01T12:00:00Z"),
    });
    const source = feedSource([pubRow(), tricky]);
    const body = await (await source.request()).text();
    // Byte pins: the production escaping spelling, read raw.
    expect(body).toContain(
      `<title>${CANCELLED_TITLE_PREFIX}A &amp; &quot;B&quot; &lt;c&gt; 🎮 東京</title>`,
    );
    expect(body).toContain(
      "<description>it&#039;s &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; " +
        `${CANCELLED_NOTE}</description>`,
    );
    expect(body).toContain(`<link>${APP_URL}/e/${TRICKY_CAN_KEY}</link>`);
    expect(body).toContain(`<guid isPermaLink="true">${APP_URL}/e/${TRICKY_CAN_KEY}</guid>`);
    expect(body).not.toContain("<enclosure");
    const { items } = parsedItems(body);
    const cancelled = items.find((item) => item.guid === `${APP_URL}/e/${TRICKY_CAN_KEY}`);
    expect(cancelled, "cancelled item present in the parsed feed").toBeDefined();
    expect(cancelled!.title).toBe(`${CANCELLED_TITLE_PREFIX}${TRICKY_TITLE}`);
    expect(cancelled!.description).toBe(`${TRICKY_DESCRIPTION} ${CANCELLED_NOTE}`);
    expect(cancelled!.link).toBe(`${APP_URL}/e/${TRICKY_CAN_KEY}`);
    expect(cancelled!.guidPermaLink).toBe("true");
  });

  it("orders cancelled items with published by start then id", async () => {
    const late = calendarRow({
      id: 6,
      eventKey: TRICKY_PUB_KEY,
      title: "Late published night",
      startsAt: new Date("2026-07-19T18:00:00Z"),
      endsAt: new Date("2026-07-19T20:00:00Z"),
      status: "published",
      updatedAt: new Date("2026-07-01T12:00:00Z"),
    });
    const source = feedSource([late, cancelledRow(), pubRow()]);
    const body = await (await source.request()).text();
    const { items } = parsedItems(body);
    expect(items.map((item) => item.guid)).toEqual([
      `${APP_URL}/e/${PUB_KEY}`,
      `${APP_URL}/e/${CAN_KEY}`,
      `${APP_URL}/e/${TRICKY_PUB_KEY}`,
    ]);
  });

  it("moves lastBuildDate to the newer cancelled update", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const body = await (await source.request()).text();
    const { lastBuildDate } = parsedItems(body);
    expect(lastBuildDate).toBe("Thu, 02 Jul 2026 12:00:00 +0000");
  });
});

describe("RSS preserved behavior (acceptance controls)", () => {
  it("keeps a published-only feed byte-identical to the legacy document", async () => {
    const source = feedSource([pubRow()]);
    const response = await source.request();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `${channelHead("Wed, 01 Jul 2026 12:00:00 +0000")}${PUB_ITEM}</channel></rss>`,
    );
  });

  it("keeps published item bytes identical inside a mixed feed", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const body = await (await source.request()).text();
    // The cancelled item's own bytes are pinned by the RED tests above; this
    // control pins only that the published item survives the mix verbatim.
    expect(body).toContain(PUB_ITEM);
  });

  it("pins link/guid bytes and no enclosure on published items", async () => {
    const source = feedSource([pubRow()]);
    const body = await (await source.request()).text();
    expect(body).toContain(`<link>${APP_URL}/e/${PUB_KEY}</link>`);
    expect(body).toContain(`<guid isPermaLink="true">${APP_URL}/e/${PUB_KEY}</guid>`);
    expect(body).not.toContain("<enclosure");
    const { items } = parsedItems(body);
    expect(items).toHaveLength(1);
    expect(items[0]!.guidPermaLink).toBe("true");
    expect(items[0]!.pubDate).toBe("Wed, 15 Jul 2026 18:00:00 +0000");
  });

  it("excludes ended cancelled events from the window", async () => {
    const source = feedSource([pubRow(), endedCancelledRow()]);
    const body = await (await source.request()).text();
    expect(body).toContain(PUB_KEY);
    expect(body).not.toContain(END_KEY);
    expect(body.match(/<item>/g)).toHaveLength(1);
  });

  it("issues one feed statement for a mixed window", async () => {
    const source = feedSource([pubRow(), cancelledRow(), endedCancelledRow()]);
    const response = await source.request();
    expect(response.status).toBe(200);
    expect(source.query).toHaveBeenCalledTimes(1);
  });

  it("keeps cache, content-type, ETag and 304 behavior on the mixed feed", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const first = await source.request();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("max-age=300, public");
    expect(first.headers.get("set-cookie")).toBeNull();
    const body = await first.text();
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    const unchanged = await source.request({ headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("cache-control")).toBe("max-age=300, public");
    expect(unchanged.headers.get("set-cookie")).toBeNull();
    const skipped = vi
      .mocked(console.warn)
      .mock.calls.filter(([message]) => String(message).includes("skipped"));
    expect(skipped).toHaveLength(0);
  });

  it("exposes no member/session fields and stays byte-identical for cookie bearers", async () => {
    const source = feedSource([pubRow(), cancelledRow()]);
    const guest = await source.request();
    const bearer = await source.request({
      headers: { cookie: "__Host-two_session=not-a-session" },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get("set-cookie")).toBeNull();
    const [guestBody, bearerBody] = await Promise.all([guest.text(), bearer.text()]);
    expect(bearerBody).toBe(guestBody);
    expect(guestBody).not.toContain("<author>");
    expect(guestBody).not.toContain("session");
  });

  it("round-trips an HTML-shaped/Unicode published title through the parser", async () => {
    const tricky = calendarRow({
      id: 7,
      eventKey: TRICKY_PUB_KEY,
      title: TRICKY_TITLE,
      description: TRICKY_DESCRIPTION,
      startsAt: new Date("2026-07-18T18:00:00Z"),
      endsAt: new Date("2026-07-18T20:00:00Z"),
      status: "published",
      updatedAt: new Date("2026-07-01T12:00:00Z"),
    });
    const source = feedSource([tricky]);
    const body = await (await source.request()).text();
    expect(body).toContain("<title>A &amp; &quot;B&quot; &lt;c&gt; 🎮 東京</title>");
    const { items } = parsedItems(body);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(TRICKY_TITLE);
    expect(items[0]!.description).toBe(TRICKY_DESCRIPTION);
  });
});
