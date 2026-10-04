// route-inventory: GET /events.rss
// route-inventory: GET /events.ics
// TOG-14932: structural validity of the feed builders from local fixtures.
// Pure unit tests: no database, session store, clock reads or network.
// The small independent parsers below (hand-rolled, not the production
// encoders) prove the RSS is well-formed XML with the required channel/item
// fields and the ICS is a well-structured VCALENDAR with required VEVENT
// properties — the consumer contract feed readers and calendar apps rely on.
import { describe, expect, it } from "vitest";
import type { events } from "../src/db/admin-schema";
import { eventIcs, eventsIcsCollection, eventsRss } from "../src/events/feeds";

type EventRow = typeof events.$inferSelect;

const APP_URL = "https://next.example.test";
const KEY_A = "01J0000000000000000000ABCD";
const KEY_B = "01J0000000000000000000WXYZ";

const row = (overrides: Partial<EventRow> = {}): EventRow =>
  ({
    id: 1,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    eventKey: KEY_A,
    title: "Friday night Helldivers",
    game: null,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "UTC",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    createdBy: null,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  }) as EventRow;

// ---------------------------------------------------------------------------
// Independent RSS reader: a minimal well-formedness parser, not a regex over
// the production encoder's output. Rejects mismatched/unclosed tags, stray
// "&"/"<" in text, and undeclared entities.
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
  // Tokens: comments, PIs, end tags, self-closing/empty tags, start tags, text.
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
      const decoded = decodeEntities(text);
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text) && decoded === text) {
        throw new Error(`Bare ampersand in text: ${JSON.stringify(text)}`);
      }
      stack[stack.length - 1]!.text += decoded;
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

const child = (node: XmlNode, name: string): XmlNode => {
  const found = node.children.filter((c) => c.name === name);
  expect(found, `expected one <${name}> in <${node.name}>`).toHaveLength(1);
  return found[0]!;
};

const children = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((c) => c.name === name);

// ---------------------------------------------------------------------------
// Independent ICS reader: CRLF split, unfold, BEGIN/END nesting check.
// ---------------------------------------------------------------------------

type IcsBlock = { name: string; props: Map<string, string[]>; children: IcsBlock[] };

function parseIcs(body: string): IcsBlock {
  expect(body.endsWith("\r\n")).toBe(true);
  expect(body).not.toMatch(/(?<!\r)\n/);
  expect(body).not.toContain("\r\r");
  const physical = body.split("\r\n").slice(0, -1);
  for (const line of physical) {
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  }
  const logical = body
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .slice(0, -1);
  const root: IcsBlock = { name: "#root", props: new Map(), children: [] };
  const stack: IcsBlock[] = [root];
  for (const line of logical) {
    const colon = line.indexOf(":");
    const semi = line.indexOf(";");
    const nameEnd = semi === -1 || semi > colon ? colon : semi;
    expect(
      nameEnd,
      `property without name/value separator: ${JSON.stringify(line)}`,
    ).toBeGreaterThan(0);
    const name = line.slice(0, nameEnd);
    expect(name).toMatch(/^[A-Z0-9-]+$/);
    if (name === "BEGIN") {
      const block: IcsBlock = { name: line.slice(colon + 1), props: new Map(), children: [] };
      stack[stack.length - 1]!.children.push(block);
      stack.push(block);
      continue;
    }
    if (name === "END") {
      const open = stack.pop();
      expect(open, `END without BEGIN: ${line}`).toBeDefined();
      expect(open!.name, `END:${line.slice(colon + 1)} closes ${open!.name}`).toBe(
        line.slice(colon + 1),
      );
      continue;
    }
    const value = line.slice(colon + 1);
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    const list = stack[stack.length - 1]!.props.get(name) ?? [];
    list.push(value);
    stack[stack.length - 1]!.props.set(name, list);
  }
  expect(stack).toHaveLength(1);
  expect(root.children).toHaveLength(1);
  return root.children[0]!;
}

const prop = (block: IcsBlock, name: string): string => {
  const values = block.props.get(name);
  expect(values, `expected ${name} in ${block.name}`).toBeDefined();
  expect(values).toHaveLength(1);
  return values![0]!;
};

const UTC_STAMP = /^\d{8}T\d{6}Z$/;

/** Independent UTC-stamp reader: parses `YYYYMMDDTHHMMSSZ` without the builder. */
function readUtcStamp(raw: string): string {
  const parsed = raw.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
  expect(parsed).not.toBe(raw);
  return new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// RSS validity
// ---------------------------------------------------------------------------

describe("RSS feed structural validity (fixtures)", () => {
  it("parses as well-formed XML with the required channel fields", () => {
    const rss = parseRss(eventsRss([row()], APP_URL, new Date("2026-07-01T12:00:00Z")));
    expect(rss.name).toBe("rss");
    expect(rss.attrs.version).toBe("2.0");
    const channel = child(rss, "channel");
    expect(channel.children.some((c) => c.name === "item")).toBe(true);
    expect(child(channel, "title").text).toBe("Together We Own Events");
    expect(child(channel, "link").text).toBe(`${APP_URL}/events`);
    expect(child(channel, "description").text).toBe("Upcoming events from Together We Own");
    expect(child(channel, "lastBuildDate").text).toBe("Wed, 01 Jul 2026 12:00:00 +0000");
    const self = channel.children.find((c) => c.name === "atom:link");
    expect(self).toBeDefined();
    expect(self!.attrs.href).toBe(`${APP_URL}/events.rss`);
    expect(self!.attrs.rel).toBe("self");
    expect(self!.attrs.type).toBe("application/rss+xml");
  });

  it("carries the required fields on every item and one item per event", () => {
    const built = new Date("2026-07-01T12:00:00Z");
    const rss = parseRss(
      eventsRss(
        [row(), row({ eventKey: KEY_B, title: "Second raid", description: null })],
        APP_URL,
        built,
      ),
    );
    const items = children(child(rss, "channel"), "item");
    expect(items).toHaveLength(2);
    expect(child(items[0]!, "title").text).toBe("Friday night Helldivers");
    expect(child(items[0]!, "link").text).toBe(`${APP_URL}/e/${KEY_A}`);
    expect(child(items[0]!, "guid").text).toBe(`${APP_URL}/e/${KEY_A}`);
    expect(child(items[0]!, "guid").attrs.isPermaLink).toBe("true");
    expect(child(items[0]!, "pubDate").text).toBe("Wed, 15 Jul 2026 18:00:00 +0000");
    expect(child(items[0]!, "description").text).toBe("Bring stims.");
    // No description element when the event has none; guid still points at the page.
    expect(children(items[1]!, "description")).toHaveLength(0);
    expect(child(items[1]!, "guid").text).toBe(`${APP_URL}/e/${KEY_B}`);
  });

  it("keeps an event-free feed well-formed with channel fields and no items", () => {
    const rss = parseRss(eventsRss([], APP_URL, new Date(0)));
    const channel = child(rss, "channel");
    expect(children(channel, "item")).toHaveLength(0);
    expect(child(channel, "title").text).toBe("Together We Own Events");
    expect(child(channel, "lastBuildDate").text).toBe("Thu, 01 Jan 1970 00:00:00 +0000");
  });

  it("round-trips markup, quotes, ampersands and emoji through well-formed items", () => {
    const title = `A & "B" <c> 🎮 東京`;
    const description = `it's <b>bold</b> & "quoted"`;
    const rss = parseRss(
      eventsRss([row({ title, description })], APP_URL, new Date("2026-07-01T12:00:00Z")),
    );
    const [item] = children(child(rss, "channel"), "item");
    expect(child(item!, "title").text).toBe(title);
    expect(child(item!, "description").text).toBe(description);
  });
});

// ---------------------------------------------------------------------------
// ICS validity
// ---------------------------------------------------------------------------

describe("ICS feed structural validity (fixtures)", () => {
  it("parses a per-event calendar with required calendar and VEVENT properties", () => {
    const cal = parseIcs(eventIcs(row(), APP_URL));
    expect(cal.name).toBe("VCALENDAR");
    expect(prop(cal, "VERSION")).toBe("2.0");
    expect(prop(cal, "PRODID")).toBe("-//TogetherWeOwn//Events//EN");
    expect(prop(cal, "METHOD")).toBe("PUBLISH");
    expect(prop(cal, "X-WR-CALNAME")).toBe("Together We Own Events");
    expect(cal.children).toHaveLength(1);
    const [vevent] = cal.children;
    expect(vevent!.name).toBe("VEVENT");
    expect(prop(vevent!, "UID")).toBe(`${KEY_A}@next.example.test`);
    expect(prop(vevent!, "SEQUENCE")).toBe("0");
    expect(prop(vevent!, "DTSTAMP")).toMatch(UTC_STAMP);
    expect(prop(vevent!, "DTSTART")).toBe("20260715T180000Z");
    expect(prop(vevent!, "DTEND")).toBe("20260715T200000Z");
    expect(prop(vevent!, "SUMMARY")).toBe("Friday night Helldivers");
    expect(prop(vevent!, "STATUS")).toBe("CONFIRMED");
    expect(prop(vevent!, "DESCRIPTION")).toBe("Bring stims.");
    expect(prop(vevent!, "LOCATION")).toBe("Voice: General");
    expect(prop(vevent!, "URL")).toBe(`${APP_URL}/e/${KEY_A}`);
    expect(readUtcStamp(prop(vevent!, "DTSTART"))).toBe("2026-07-15T18:00:00.000Z");
  });

  it("maps cancelled events to STATUS:CANCELLED and keeps one VALARM per VEVENT", () => {
    const cal = parseIcs(
      eventsIcsCollection(
        [row(), row({ eventKey: KEY_B, status: "cancelled", description: null, location: null })],
        APP_URL,
      ),
    );
    expect(cal.name).toBe("VCALENDAR");
    expect(cal.children).toHaveLength(2);
    const [first, second] = cal.children;
    expect(prop(first!, "STATUS")).toBe("CONFIRMED");
    expect(prop(second!, "STATUS")).toBe("CANCELLED");
    expect(prop(second!, "UID")).toBe(`${KEY_B}@next.example.test`);
    expect(second!.props.get("DESCRIPTION")).toBeUndefined();
    expect(second!.props.get("LOCATION")).toBeUndefined();
    for (const vevent of cal.children) {
      expect(vevent.children).toHaveLength(1);
      const [alarm] = vevent.children;
      expect(alarm!.name).toBe("VALARM");
      expect(prop(alarm!, "TRIGGER")).toBe("-PT30M");
      expect(prop(alarm!, "ACTION")).toBe("DISPLAY");
    }
    // UIDs are unique across the collection.
    const uids = cal.children.map((v) => prop(v, "UID"));
    expect(new Set(uids).size).toBe(2);
  });

  it("keeps an event-free collection a well-formed calendar with no VEVENTs", () => {
    const cal = parseIcs(eventsIcsCollection([], APP_URL));
    expect(cal.name).toBe("VCALENDAR");
    expect(prop(cal, "VERSION")).toBe("2.0");
    expect(cal.children).toHaveLength(0);
  });

  it("keeps every physical line within 75 octets with CRLF-only endings", () => {
    const long = row({
      title: "a;b,c\\d\ne",
      description: "é".repeat(60),
      location: "L".repeat(200),
    });
    const body = eventsIcsCollection([long, row({ eventKey: KEY_B })], APP_URL);
    parseIcs(body); // asserts CRLF-only, <=75 octets per line, balanced blocks
    expect(body.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${"é".repeat(60)}`);
  });
});
