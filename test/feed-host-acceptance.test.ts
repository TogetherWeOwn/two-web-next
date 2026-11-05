// route-inventory: GET /events.ics
// route-inventory: GET /events.rss
// route-inventory: GET /events/:file{.+\.ics}
// U1 feed-host acceptance (Test Author owned, protected): feeds carry the host
// name from the already-public `organizer_name`.
//
// PROTECTED: the Builder builds on this branch and never edits this file.
// RED on the unpatched head: every `host present` assertion fails because no
// ORGANIZER/author is emitted. GREEN controls (blank/missing omission, header,
// ETag, redirect and query-count parity) pass before and after.
//
// Builder contract (GREEN path):
// - Non-blank means `organizer_name != null` and `trim() !== ""`. Blank,
//   whitespace-only, null or missing omits the property entirely.
// - ICS VEVENT gains one line for non-blank hosts:
//     ORGANIZER;CN="<normalized>":mailto:noreply@example.invalid
//   CN is always double-quoted; inside `"` normalizes to `'` and runs of C0
//   controls/DEL normalize to one space (RFC 5545 §3.1/§3.2 quoted-string is
//   DQUOTE *QSAFE-CHAR DQUOTE with no backslash escape). Single backslash,
//   comma, semicolon, colon, caret, `<`, `>`, `&`, Unicode and 200-char names
//   round-trip literally inside the quotes. Fold with the
//   existing 75-octet `fold()` so long hosts stay wire-valid. Value is always
//   the non-routable placeholder, never member text.
// - RSS `<item>` gains one child for non-blank hosts:
//     <author>noreply@example.invalid (Name)</author>
//   where `Name` is the trimmed organizer escaped with the existing `rssXml()`
//   (so `<`, `>`, `&`, quotes round-trip). No other address appears.
// - No new queries: `organizer_name` already arrives on the feed row
//   (part of the feed egress projection); the builders only read it. Headers, ETag/304, redirects and
//   canonical behaviour stay byte-identical apart from the new property.
// - Placeholder is fixed and non-routable (`.invalid`, RFC 2606): ICS
//   `mailto:noreply@example.invalid`, RSS `noreply@example.invalid`.
//
// Validation is parser-based, never regex over the new property: the ICS
// reader below unfolds, checks CRLF/75-octet structure and extracts ORGANIZER
// params+value; the RSS reader is an independent well-formedness XML parser.
// Raw-byte `includes`/`split` checks only prove escaping and placeholder-only
// (no other `mailto:` / real domain), never presence.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { eventIcs, eventsIcsCollection, eventsRss, latestWireUpdatedAt } from "../src/events/feeds";
import { projectEventRowValues } from "./helpers/pg-proxy-event-projection";

type EventRow = typeof events.$inferSelect;

const APP_URL = "https://next.example.test";
const KEY_A = "01J0000000000000000000ABCD";
const KEY_B = "01J0000000000000000000WXYZ";
const KEY_C = "01J0000000000000000000EFGH";
const ICS_PLACEHOLDER = "mailto:noreply@example.invalid";
const RSS_PLACEHOLDER = "noreply@example.invalid";
const HOST_SUFFIX = "@next.example.test";

const PLAIN = "Ada Lovelace";
const COMMA = "Doe, Jane";
const SEMICOLON = "Raid; Night";
const NEWLINE = "Line1\nLine2";
const PADDED = "  Ada Lovelace  ";
const HTML_SHAPED = `<b>Host</b> & "Friends" <script>alert(1)</script>`;
const UNICODE = "🎮 Nächster Raid — 東京ゲームナイト";
const LONG_200 = "H".repeat(200);
const AT_NAME = "host@example.com";

const row = (overrides: Partial<EventRow> = {}): EventRow =>
  ({
    id: 1,
    icsSequence: 1782907200n,
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
    startsAt: new Date("2099-07-15T18:00:00Z"),
    endsAt: new Date("2099-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    createdBy: null,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  }) as EventRow;

const trimmed = (v: string): string => v.trim();

/** Mirror of the builder CN normalization: trim, `"` to `'`, control runs to one space. */
const normalizedCn = (v: string): string =>
  trimmed(v)
    .replace(/"/g, "'")
    .replace(/[\u0000-\u001F\u007F]+/g, " ");

// ---------------------------------------------------------------------------
// Independent ICS reader: CRLF split, unfold, BEGIN/END nesting, ORGANIZER
// params+value extraction. Hand-rolled, not the production encoder.
// ---------------------------------------------------------------------------

type IcsProp = { params: Map<string, string>; value: string };
type IcsBlock = { name: string; props: Map<string, IcsProp[]>; children: IcsBlock[] };

function decodeCnParam(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')))
    throw new Error(`CN param must be quoted: ${JSON.stringify(raw)}`);
  const inner = raw.slice(1, -1);
  // Strict literal extractor: QSAFE-CHAR excludes DQUOTE and controls and the
  // grammar defines no backslash escape, so neither may appear. No decoding.
  if (/["\u0000-\u001F\u007F]/.test(inner))
    throw new Error(`CN param holds a forbidden char: ${JSON.stringify(raw)}`);
  return inner;
}

function parseIcsParams(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  if (!raw) return params;
  // Split on unquoted semicolons; CN is always quoted so commas/colons inside survive.
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      // A DQUOTE while quoted closes the value, so it must end the params or
      // precede the next `;`-param; anything else is a stray quote.
      if (quoted && i + 1 < raw.length && raw[i + 1] !== ";")
        throw new Error(`Stray DQUOTE in ICS params: ${JSON.stringify(raw)}`);
      quoted = !quoted;
    }
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`Bad ICS param: ${JSON.stringify(part)}`);
    params.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return params;
}

function parseIcs(body: string): IcsBlock {
  expect(body.endsWith("\r\n")).toBe(true);
  expect(body.includes("\n") ? body.split("\r\n").join("").includes("\n") : false).toBe(false);
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
    // The value colon is the first `:` outside quoted params, so a colon
    // inside a quoted CN (e.g. `A:B`) never splits the property early.
    let colon = -1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ":" && !inQuotes) {
        colon = i;
        break;
      }
    }
    expect(colon, `property without value: ${JSON.stringify(line)}`).toBeGreaterThan(0);
    const head = line.slice(0, colon);
    const semi = head.indexOf(";");
    const name = semi === -1 ? head : head.slice(0, semi);
    expect(name).toMatch(/^[A-Z0-9-]+$/);
    const paramRaw = semi === -1 ? "" : head.slice(semi + 1);
    const value = line.slice(colon + 1);
    expect(value.includes("\r") || value.includes("\n")).toBe(false);
    if (name === "BEGIN") {
      const block: IcsBlock = { name: value, props: new Map(), children: [] };
      stack[stack.length - 1]!.children.push(block);
      stack.push(block);
      continue;
    }
    if (name === "END") {
      const open = stack.pop();
      expect(open!.name).toBe(value);
      continue;
    }
    const list = stack[stack.length - 1]!.props.get(name) ?? [];
    list.push({ params: parseIcsParams(paramRaw), value });
    stack[stack.length - 1]!.props.set(name, list);
  }
  expect(stack).toHaveLength(1);
  expect(root.children).toHaveLength(1);
  return root.children[0]!;
}

const vevents = (cal: IcsBlock): IcsBlock[] => cal.children.filter((c) => c.name === "VEVENT");

function organizerOf(vevent: IcsBlock): IcsProp | undefined {
  return vevent.props.get("ORGANIZER")?.[0];
}

// ---------------------------------------------------------------------------
// Independent RSS reader: minimal well-formedness XML parser (not regex).
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
    if (body === "039" || body === "#039") return "'";
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
      if (text.includes("<") || text.includes(">"))
        throw new Error(`Stray markup in text: ${JSON.stringify(text)}`);
      stack[stack.length - 1]!.text += decodeEntities(text);
      continue;
    }
    if (full.startsWith("<!--") || full.startsWith("<?")) continue;
    if (endName !== undefined) {
      const open = stack.pop();
      if (open === undefined || open.name !== endName)
        throw new Error(`Mismatched end tag </${endName}>`);
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

const rssItems = (rss: XmlNode): XmlNode[] => {
  const channel = rss.children.find((c) => c.name === "channel");
  expect(channel).toBeDefined();
  return channel!.children.filter((c) => c.name === "item");
};

const authorOf = (item: XmlNode): XmlNode | undefined =>
  item.children.find((c) => c.name === "author");

// ---------------------------------------------------------------------------
// Builder-level: ICS ORGANIZER via the real parser
// ---------------------------------------------------------------------------

describe("feed host: ICS ORGANIZER from organizer_name (parser-validated)", () => {
  it("emits one ORGANIZER per VEVENT for a non-blank host in per-event and collection bytes", () => {
    for (const body of [
      eventIcs(row({ organizer_name: PLAIN }), APP_URL),
      eventsIcsCollection([row({ organizer_name: PLAIN })], APP_URL),
    ]) {
      const cal = parseIcs(body);
      expect(cal.name).toBe("VCALENDAR");
      const events = vevents(cal);
      expect(events).toHaveLength(1);
      const org = organizerOf(events[0]!);
      // RED on unpatched head: no ORGANIZER property is emitted.
      expect(org, "VEVENT must carry ORGANIZER for a non-blank host").toBeDefined();
      expect(org!.value).toBe(ICS_PLACEHOLDER);
      expect(decodeCnParam(org!.params.get("CN") ?? "")).toBe(normalizedCn(PLAIN));
      // UID keeps its host suffix; ORGANIZER is the only mailto:.
      expect(events[0]!.props.get("UID")?.[0]?.value.endsWith(HOST_SUFFIX)).toBe(true);
      expect(body.split(ICS_PLACEHOLDER).length - 1).toBe(1);
      expect(body.split("mailto:").length - 1).toBe(1);
    }
  });

  it.each([
    ["null", null],
    ["missing", undefined],
    ["empty", ""],
    ["spaces", "   "],
    ["whitespace", "\t\n  "],
  ])("omits ORGANIZER for %s organizer (per-event and collection)", (_label, organizer) => {
    for (const body of [
      eventIcs(row({ organizer_name: organizer as string | null | undefined }), APP_URL),
      eventsIcsCollection(
        [row({ organizer_name: organizer as string | null | undefined })],
        APP_URL,
      ),
    ]) {
      const cal = parseIcs(body);
      const events = vevents(cal);
      expect(events).toHaveLength(1);
      expect(events[0]!.props.get("ORGANIZER")).toBeUndefined();
      expect(body.includes("ORGANIZER")).toBe(false);
      expect(body.includes("mailto:")).toBe(false);
    }
  });

  it.each([
    ["comma", COMMA],
    ["semicolon", SEMICOLON],
    ["newline", NEWLINE],
    ["padded-trim", PADDED],
    ["html-shaped", HTML_SHAPED],
    ["unicode", UNICODE],
    ["200-char", LONG_200],
    ["at-in-name", AT_NAME],
  ])(
    "round-trips %s organizer through the parser (CN quoted, value placeholder)",
    (_label, name) => {
      const body = eventIcs(row({ organizer_name: name }), APP_URL);
      const cal = parseIcs(body); // asserts CRLF-only and <=75 octets per line
      const [vevent] = vevents(cal);
      const org = organizerOf(vevent!);
      expect(org, `ORGANIZER missing for ${_label}`).toBeDefined();
      expect(org!.value).toBe(ICS_PLACEHOLDER);
      expect(decodeCnParam(org!.params.get("CN") ?? "")).toBe(normalizedCn(name));
      // Always quoted so commas/semicolons/colons survive param parsing.
      const unfolded = body.replace(/\r\n[ \t]/g, "");
      const line = unfolded.split("\r\n").find((l) => l.startsWith("ORGANIZER"))!;
      expect(line.startsWith('ORGANIZER;CN="')).toBe(true);
      expect(line.endsWith(`":${ICS_PLACEHOLDER}`)).toBe(true);
      expect(unfolded.split("mailto:").length - 1).toBe(1);
    },
  );

  it("pins quote/newline normalization as literals (apostrophe, single space)", () => {
    for (const [name, literal] of [
      [HTML_SHAPED, `<b>Host</b> & 'Friends' <script>alert(1)</script>`],
      [NEWLINE, "Line1 Line2"],
    ] as const) {
      const body = eventIcs(row({ organizer_name: name }), APP_URL);
      const [vevent] = vevents(parseIcs(body));
      const org = organizerOf(vevent!);
      expect(org, "ORGANIZER missing for literal-pin check").toBeDefined();
      const decoded = decodeCnParam(org!.params.get("CN") ?? "");
      expect(decoded).toBe(normalizedCn(name));
      expect(decoded).toBe(literal);
    }
  });

  it.each([
    ["dquote", `Ada "Host" Lovelace`, "Ada 'Host' Lovelace"],
    ["backslash", "A\\B", "A\\B"],
    ["colon", "A:B", "A:B"],
    ["caret", "A^nB", "A^nB"],
  ])("normalizes %s organizer: exact CN via the strict decoder", (_label, name, expected) => {
    const body = eventIcs(row({ organizer_name: name }), APP_URL);
    const [vevent] = vevents(parseIcs(body));
    const org = organizerOf(vevent!);
    expect(org, `ORGANIZER missing for ${_label}`).toBeDefined();
    expect(decodeCnParam(org!.params.get("CN") ?? "")).toBe(expected);
    // Raw-byte check on the unfolded ORGANIZER line: the CN section holds no
    // DQUOTE beyond its delimiters and no control characters.
    const unfolded = body.replace(/\r\n[ \t]/g, "");
    const line = unfolded.split("\r\n").find((l) => l.startsWith("ORGANIZER"))!;
    expect(line.startsWith('ORGANIZER;CN="')).toBe(true);
    expect(line.endsWith(`":${ICS_PLACEHOLDER}`)).toBe(true);
    const cnSection = line.slice(
      'ORGANIZER;CN="'.length,
      line.length - `":${ICS_PLACEHOLDER}`.length,
    );
    expect(cnSection.includes('"')).toBe(false);
    expect(/[\u0000-\u001F\u007F]/.test(cnSection)).toBe(false);
  });

  it("keeps each VEVENT host independent in a mixed collection (present, blank, unicode)", () => {
    const body = eventsIcsCollection(
      [
        row({ eventKey: KEY_A, organizer_name: PLAIN }),
        row({ eventKey: KEY_B, organizer_name: "   " }),
        row({ eventKey: KEY_C, organizer_name: UNICODE }),
      ],
      APP_URL,
    );
    const cal = parseIcs(body);
    const events = vevents(cal);
    expect(events).toHaveLength(3);
    const byUid = new Map(events.map((v) => [v.props.get("UID")?.[0]?.value, v]));
    const first = organizerOf(byUid.get(`${KEY_A}${HOST_SUFFIX}`)!);
    expect(first, "ORGANIZER missing for first mixed host").toBeDefined();
    expect(decodeCnParam(first!.params.get("CN") ?? "")).toBe(normalizedCn(PLAIN));
    expect(first!.value).toBe(ICS_PLACEHOLDER);
    expect(byUid.get(`${KEY_B}${HOST_SUFFIX}`)!.props.get("ORGANIZER")).toBeUndefined();
    const third = organizerOf(byUid.get(`${KEY_C}${HOST_SUFFIX}`)!);
    expect(third, "ORGANIZER missing for third mixed host").toBeDefined();
    expect(decodeCnParam(third!.params.get("CN") ?? "")).toBe(normalizedCn(UNICODE));
    expect(third!.value).toBe(ICS_PLACEHOLDER);
    // Unfold first: folded long hosts split the placeholder across lines.
    const unfoldedMixed = body.replace(/\r\n[ \t]/g, "");
    expect(unfoldedMixed.split(ICS_PLACEHOLDER).length - 1).toBe(2);
  });

  it("never emits a real address: only the non-routable placeholder as mailto:", () => {
    const body = eventsIcsCollection(
      [row({ organizer_name: AT_NAME }), row({ eventKey: KEY_B, organizer_name: HTML_SHAPED })],
      APP_URL,
    );
    const cal = parseIcs(body);
    for (const vevent of vevents(cal)) {
      // Even when the display name looks like an email, the address stays fixed.
      const org = organizerOf(vevent);
      expect(org, "ORGANIZER missing for placeholder-only check").toBeDefined();
      expect(org!.value).toBe(ICS_PLACEHOLDER);
    }
    // Unfold first: folding can split "mailto:" across lines by alignment.
    const unfoldedOnly = body.replace(/\r\n[ \t]/g, "");
    expect(unfoldedOnly.split("mailto:").length - 1).toBe(2);
    expect(body.includes("@togetherweown")).toBe(false);
    expect(body.includes("@example.com")).toBe(true); // display text only, inside quoted CN
  });
});

// ---------------------------------------------------------------------------
// Builder-level: RSS author via the real parser
// ---------------------------------------------------------------------------

describe("feed host: RSS author from organizer_name (parser-validated)", () => {
  const lastBuild = new Date("2026-07-01T12:00:00Z");

  it("emits one author per item for a non-blank host (placeholder plus display name)", () => {
    const body = eventsRss([row({ organizer_name: PLAIN })], APP_URL, lastBuild);
    const items = rssItems(parseRss(body));
    expect(items).toHaveLength(1);
    const author = authorOf(items[0]!);
    // RED on unpatched head: no author element is emitted.
    expect(author, "RSS item must carry author for a non-blank host").toBeDefined();
    expect(author!.text).toBe(`${RSS_PLACEHOLDER} (${PLAIN})`);
    expect(body.split(RSS_PLACEHOLDER).length - 1).toBe(1);
  });

  it.each([
    ["null", null],
    ["missing", undefined],
    ["empty", ""],
    ["spaces", "   "],
    ["whitespace", "\t\n  "],
  ])("omits author for %s organizer", (_label, organizer) => {
    const body = eventsRss(
      [row({ organizer_name: organizer as string | null | undefined })],
      APP_URL,
      lastBuild,
    );
    const items = rssItems(parseRss(body));
    expect(items).toHaveLength(1);
    expect(authorOf(items[0]!)).toBeUndefined();
    expect(body.includes("<author>")).toBe(false);
  });

  it.each([
    ["comma", COMMA],
    ["semicolon", SEMICOLON],
    ["newline", NEWLINE],
    ["padded-trim", PADDED],
    ["unicode", UNICODE],
    ["200-char", LONG_200],
    ["at-in-name", AT_NAME],
  ])("round-trips %s organizer through the parser", (_label, name) => {
    const body = eventsRss([row({ organizer_name: name })], APP_URL, lastBuild);
    const items = rssItems(parseRss(body));
    const author = authorOf(items[0]!);
    expect(author, `author missing for ${_label}`).toBeDefined();
    expect(author!.text).toBe(`${RSS_PLACEHOLDER} (${trimmed(name)})`);
  });

  it("escapes HTML-shaped organizers as XML text, never markup", () => {
    const body = eventsRss([row({ organizer_name: HTML_SHAPED })], APP_URL, lastBuild);
    const items = rssItems(parseRss(body));
    const author = authorOf(items[0]!);
    expect(author, "author missing for HTML-shaped host").toBeDefined();
    expect(author!.text).toBe(`${RSS_PLACEHOLDER} (${HTML_SHAPED})`);
    // Escaped on the wire: no raw tag survives.
    expect(body.includes("<b>Host</b>")).toBe(false);
    expect(body.includes("&lt;b&gt;Host&lt;/b&gt;")).toBe(true);
    expect(body.includes("&amp;")).toBe(true);
    expect(body.includes("&quot;")).toBe(true);
  });

  it("keeps each item host independent and placeholder-only (no real address)", () => {
    const body = eventsRss(
      [
        row({ eventKey: KEY_A, organizer_name: PLAIN }),
        row({ eventKey: KEY_B, organizer_name: "" }),
        row({ eventKey: KEY_C, organizer_name: AT_NAME }),
      ],
      APP_URL,
      lastBuild,
    );
    const items = rssItems(parseRss(body));
    expect(items).toHaveLength(3);
    const firstAuthor = authorOf(items[0]!);
    expect(firstAuthor, "author missing for first mixed item").toBeDefined();
    expect(firstAuthor!.text).toBe(`${RSS_PLACEHOLDER} (${PLAIN})`);
    expect(authorOf(items[1]!)).toBeUndefined();
    // The at-shaped display name stays inside the placeholder wrapper.
    const thirdAuthor = authorOf(items[2]!);
    expect(thirdAuthor, "author missing for at-shaped item").toBeDefined();
    expect(thirdAuthor!.text).toBe(`${RSS_PLACEHOLDER} (${AT_NAME})`);
    expect(body.split(RSS_PLACEHOLDER).length - 1).toBe(2);
    expect(body.includes("@togetherweown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route-level: pg-proxy fixtures, real app/reads/builders, no DB or network.
// ---------------------------------------------------------------------------

// The transport models the emitted projection (pg-proxy maps positionally):
// the keyed read still selects the stored row, the collection read selects
// its byte-admitted egress fields.
function wireRow(sql: string, params: unknown[], row: EventRow): unknown[] {
  return projectEventRowValues(sql, params, row);
}

function routeFixture(rows: EventRow[]) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      return {
        rows: rows.filter((r) => r.eventKey === params[0]).map((r) => wireRow(sql, params, r)),
      };
    }
    if (sql.includes('from "events"') && sql.includes('"status" in')) {
      const cutoff = params.find((v) => typeof v === "string" && (v as string).startsWith("20")) as
        | string
        | undefined;
      if (!cutoff) throw new Error("Fixture expected a feed cutoff instant");
      const now = new Date(cutoff);
      return {
        rows: rows
          .filter((r) => (params as string[]).includes(r.status) && r.endsAt >= now)
          .map((r) => wireRow(sql, params, r)),
      };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const env = { APP_URL, ADMIN_DB: drizzle(query) as unknown as Db } as unknown as Env;
  return {
    query,
    request: (path: string, init?: RequestInit) => app.request(path, init ?? {}, env),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("feed host: routes carry the host (pg-proxy, parser-validated)", () => {
  it("serves ORGANIZER per VEVENT on /events.ics via the parser", async () => {
    const f = routeFixture([
      row({ eventKey: KEY_A, organizer_name: PLAIN }),
      row({ eventKey: KEY_B, organizer_name: COMMA, id: 2 }),
    ]);
    const res = await f.request("/events.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="events.ics"');
    expect(res.headers.get("cache-control")).toBe("max-age=300, public");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    const events = vevents(parseIcs(body));
    expect(events).toHaveLength(2);
    const first = organizerOf(events[0]!);
    expect(first, "ORGANIZER missing on /events.ics first VEVENT").toBeDefined();
    expect(decodeCnParam(first!.params.get("CN") ?? "")).toBe(normalizedCn(PLAIN));
    expect(first!.value).toBe(ICS_PLACEHOLDER);
    const second = organizerOf(events[1]!);
    expect(second, "ORGANIZER missing on /events.ics second VEVENT").toBeDefined();
    expect(decodeCnParam(second!.params.get("CN") ?? "")).toBe(normalizedCn(COMMA));
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it("serves ORGANIZER on the per-event /events/:key.ics via the parser", async () => {
    const f = routeFixture([row({ organizer_name: SEMICOLON })]);
    const res = await f.request(`/events/${KEY_A}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${KEY_A}.ics"`);
    expect(res.headers.get("cache-control")).toBe("max-age=300, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    const events = vevents(parseIcs(body));
    expect(events).toHaveLength(1);
    const org = organizerOf(events[0]!);
    expect(org, "ORGANIZER missing on per-event ICS").toBeDefined();
    expect(org!.value).toBe(ICS_PLACEHOLDER);
    expect(decodeCnParam(org!.params.get("CN") ?? "")).toBe(normalizedCn(SEMICOLON));
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it("serves author per item on /events.rss via the parser", async () => {
    const f = routeFixture([
      row({ eventKey: KEY_A, organizer_name: UNICODE }),
      row({ eventKey: KEY_B, organizer_name: NEWLINE, id: 2 }),
    ]);
    const res = await f.request("/events.rss");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=300, public");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    const items = rssItems(parseRss(await res.text()));
    expect(items).toHaveLength(2);
    const firstAuthor = authorOf(items[0]!);
    expect(firstAuthor, "author missing on /events.rss first item").toBeDefined();
    expect(firstAuthor!.text).toBe(`${RSS_PLACEHOLDER} (${UNICODE})`);
    const secondAuthor = authorOf(items[1]!);
    expect(secondAuthor, "author missing on /events.rss second item").toBeDefined();
    expect(secondAuthor!.text).toBe(`${RSS_PLACEHOLDER} (${NEWLINE})`);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it("omits ORGANIZER/author for blank hosts at the route level (no placeholder leak)", async () => {
    const f = routeFixture([
      row({ eventKey: KEY_A, organizer_name: null }),
      row({ eventKey: KEY_B, organizer_name: "  ", id: 2 }),
    ]);
    for (const path of ["/events.ics", "/events.rss"] as const) {
      const body = await (await f.request(path)).text();
      if (path.endsWith(".ics")) {
        for (const vevent of vevents(parseIcs(body))) {
          expect(vevent.props.get("ORGANIZER")).toBeUndefined();
        }
        expect(body.includes("ORGANIZER")).toBe(false);
      } else {
        for (const item of rssItems(parseRss(body))) {
          expect(authorOf(item)).toBeUndefined();
        }
        expect(body.includes("<author>")).toBe(false);
      }
      expect(body.includes(RSS_PLACEHOLDER)).toBe(false);
      expect(body.includes("mailto:")).toBe(false);
    }
    const single = await (await f.request(`/events/${KEY_A}.ics`)).text();
    expect(vevents(parseIcs(single))[0]!.props.get("ORGANIZER")).toBeUndefined();
  });

  it("pins the statement count: N hosted events still cost one feed read", async () => {
    const rows = [PLAIN, COMMA, SEMICOLON, UNICODE, LONG_200].map((organizer_name, i) =>
      row({ eventKey: [KEY_A, KEY_B, KEY_C][i % 3]! + i, organizer_name, id: i + 1 }),
    );
    for (const path of ["/events.ics", "/events.rss"] as const) {
      const f = routeFixture(rows);
      const res = await f.request(path);
      expect(res.status).toBe(200);
      // One listFeed select no matter how many hosts render.
      expect(f.query).toHaveBeenCalledTimes(1);
      const body = await res.text();
      if (path.endsWith(".ics")) {
        expect(vevents(parseIcs(body))).toHaveLength(rows.length);
        // Unfold first: folded long hosts split the placeholder across lines.
        const unfoldedFeed = body.replace(/\r\n[ \t]/g, "");
        expect(unfoldedFeed.split(ICS_PLACEHOLDER).length - 1).toBe(rows.length);
      } else {
        expect(rssItems(parseRss(body))).toHaveLength(rows.length);
        expect(body.split(RSS_PLACEHOLDER).length - 1).toBe(rows.length);
      }
    }
  });

  it("preserves conditional GET: ETag/304 round-trips with hosts present", async () => {
    const f = routeFixture([row({ organizer_name: PLAIN })]);
    for (const [path, cache] of [
      ["/events.ics", "max-age=300, public"],
      ["/events.rss", "max-age=300, public"],
      [`/events/${KEY_A}.ics`, "max-age=300, private"],
    ] as const) {
      const first = await f.request(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(first.headers.get("cache-control")).toBe(cache);
      const unchanged = await f.request(path, { headers: { "if-none-match": etag } });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(await unchanged.text()).toBe("");
    }
  });

  it("preserves the per-event canonical redirect before any DB read (host present)", async () => {
    const f = routeFixture([row({ organizer_name: PLAIN })]);
    const moved = await f.request(`/events/${KEY_A.toLowerCase()}.ics`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`/events/${KEY_A}.ics`);
    expect(f.query).toHaveBeenCalledTimes(0);
    const withQuery = await f.request(`/events/${KEY_A.toLowerCase()}.ics?download=1`);
    expect(withQuery.status).toBe(301);
    expect(withQuery.headers.get("location")).toBe(`/events/${KEY_A}.ics?download=1`);
    // The canonical target serves the host; forged and unknown keys still 404.
    const served = await f.request(`/events/${KEY_A}.ics`);
    expect(served.status).toBe(200);
    const org = organizerOf(vevents(parseIcs(await served.text()))[0]!);
    expect(org, "ORGANIZER missing on canonical redirect target").toBeDefined();
    expect(decodeCnParam(org!.params.get("CN") ?? "")).toBe(normalizedCn(PLAIN));
    for (const path of [`/events/${KEY_B}.ics`, "/events/nope.ics"]) {
      const res = await f.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("keeps latestWireUpdatedAt/collection helpers host-agnostic (no date shift)", () => {
    const rows = [
      row({ organizer_name: PLAIN, updatedAt: new Date("2026-07-01T12:00:00Z") }),
      row({
        eventKey: KEY_B,
        organizer_name: null,
        updatedAt: new Date("2026-07-02T12:00:00Z"),
      }),
    ];
    expect(latestWireUpdatedAt(rows)).toEqual(new Date("2026-07-02T12:00:00Z"));
  });
});
