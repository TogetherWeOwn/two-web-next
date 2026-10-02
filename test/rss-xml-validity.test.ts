// Synthetic reads only: no database, session store or network is contacted.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { eventIcs, eventsIcsCollection, eventsRss } from "../src/events/feeds";
import { listFeed } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  listFeed: vi.fn(),
}));

const APP_URL = "https://next.example.test";
const row = {
  id: 1,
  icsSequence: 1782907200n,
  eventKey: "01J0000000000000000000ABCD",
  title: "Synthetic event",
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
  description: "Synthetic description",
  startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date("2026-07-01T12:00:00Z"),
  updatedAt: new Date("2026-07-01T12:00:00Z"),
} satisfies typeof events.$inferSelect;

// Independent oracle: XML 1.0 Fifth Edition §2.2, production [2] Char.
// Check the serialized string before UTF-8 encoding can hide lone surrogates.
function expectXmlCharacters(document: string) {
  const forbidden = [...document]
    .map((c) => c.codePointAt(0)!)
    .filter(
      (cp) =>
        !(
          cp === 9 ||
          cp === 10 ||
          cp === 13 ||
          (cp >= 0x20 && cp <= 0xd7ff) ||
          (cp >= 0xe000 && cp <= 0xfffd) ||
          (cp >= 0x10000 && cp <= 0x10ffff)
        ),
    );
  expect(forbidden.map((cp) => `U+${cp.toString(16).toUpperCase()}`)).toEqual([]);
}

const forbiddenCodePoints = [
  ...Array.from({ length: 32 }, (_, i) => i).filter((cp) => ![9, 10, 13].includes(cp)),
  0xd800,
  0xdbff,
  0xdc00,
  0xdfff,
  0xfffe,
  0xffff,
];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("RSS XML character validity", () => {
  it("replaces forbidden BMP noncharacters in event text without invalidating the feed", () => {
    const out = eventsRss(
      [{ ...row, title: "A\u{FFFE}B", description: "C\u{FFFF}D" }],
      APP_URL,
      row.updatedAt,
    );
    expectXmlCharacters(out);
    expect(out).toContain("<title>A�B</title>");
    expect(out).toContain("<description>C�D</description>");
  });

  it.each(forbiddenCodePoints)("replaces forbidden U+%i in both text fields", (cp) => {
    const value = `before${String.fromCodePoint(cp)}after`;
    const out = eventsRss([{ ...row, title: value, description: value }], APP_URL, row.updatedAt);
    expectXmlCharacters(out);
    expect(out).toContain("<title>before�after</title>");
    expect(out).toContain("<description>before�after</description>");
  });

  it("replaces adjacent lone surrogates individually without dropping neighboring text", () => {
    const value = `A${String.fromCharCode(0xd800, 0xdbff)}B${String.fromCharCode(0xdc00, 0xdfff)}C`;
    const out = eventsRss([{ ...row, title: value }], APP_URL, row.updatedAt);
    expectXmlCharacters(out);
    expect(out).toContain("<title>A��B��C</title>");
  });

  it("preserves all legal range boundaries, whitespace and astral characters after escaping", () => {
    const legal = String.fromCodePoint(
      9,
      10,
      13,
      0x20,
      0x7f,
      0x85,
      0x9f,
      0xd7ff,
      0xe000,
      0xfdd0,
      0xfffd,
      0x10000,
      0x1f680,
      0x1fffe,
      0x1ffff,
      0x10fffe,
      0x10ffff,
    );
    const value = `${legal}&<>"' &amp;`;
    const out = eventsRss([{ ...row, title: value, description: value }], APP_URL, row.updatedAt);
    expectXmlCharacters(out);
    const item = out.match(/<item>([\s\S]*?)<\/item>/)![1]!;
    const encoded = `${legal}&amp;&lt;&gt;&quot;&#039; &amp;amp;`;
    for (const tag of ["title", "description"]) {
      const content = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1]!;
      expect(content).toBe(encoded);
      // Independent one-pass entity decoding, not the production encoder.
      const entities: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#039;": "'",
      };
      expect(content.replace(/&(?:amp|lt|gt|quot|#039);/g, (entity) => entities[entity]!)).toBe(
        value,
      );
    }
  });

  it("sanitizes every RSS encoder call, including permalink and self-link attributes", () => {
    const out = eventsRss(
      [{ ...row, eventKey: "key\u{FFFF}&" }],
      `${APP_URL}/\u{FFFE}&`,
      row.updatedAt,
    );
    expectXmlCharacters(out);
    expect(out).toContain(`href="${APP_URL}/�&amp;/events.rss"`);
    expect(out).toContain(`<guid isPermaLink="true">${APP_URL}/�&amp;/e/key�&amp;</guid>`);
  });

  it("keeps repeated nonempty feed bytes and strong/weak validators stable", async () => {
    const event = { ...row, title: "A\u{FFFE}B", description: "C\u{FFFF}D" };
    vi.mocked(listFeed).mockResolvedValue([event]);
    const env: EnvWithAdminDb = {
      APP_URL,
      ADMIN_DB: new Proxy({} as Db, {
        get: (_, key) => {
          if (key === "then") return undefined;
          throw new Error("fixture must not query a DB");
        },
      }),
    } as EnvWithAdminDb;
    const app = new Hono<{ Bindings: Env }>();
    const readSession = vi.fn().mockResolvedValue(null);
    registerEventRoutes(app, readSession, readSession);
    const req = (validator?: string) =>
      app.request(
        "/events.rss",
        {
          headers: validator === undefined ? {} : { "if-none-match": validator },
        },
        env,
      );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
    const first = await req();
    expect(first.status).toBe(200);
    const body = await first.text();
    expectXmlCharacters(body);
    expect(body).toBe(eventsRss([event], APP_URL, row.updatedAt));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
    expect(first.headers.get("etag")).toBe(etag);
    vi.setSystemTime(new Date("2026-07-02T12:00:00Z"));
    const repeated = await req();
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(body);
    expect(repeated.headers.get("etag")).toBe(etag);
    for (const validator of [etag, `W/${etag}`]) {
      const cached = await req(validator);
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("etag")).toBe(etag);
    }
    expect(first.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(readSession).not.toHaveBeenCalled();
    expect(event.title).toBe("A\u{FFFE}B");
    expect(event.description).toBe("C\u{FFFF}D");
  });

  it("does not sanitize stored event text or change per-event/collection ICS bytes", () => {
    const title = `A${String.fromCharCode(0, 0xd800, 0xfffe)}B`;
    const description = `C${String.fromCharCode(0xdc00, 0xffff)}D`;
    const event = { ...row, title, description };
    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TogetherWeOwn//Events//EN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Together We Own Events",
      "X-WR-CALDESC:Upcoming events from Together We Own",
      "BEGIN:VEVENT",
      `UID:${row.eventKey}@next.example.test`,
      "SEQUENCE:1782907200",
      "DTSTAMP:20260701T120000Z",
      "DTSTART:20260715T180000Z",
      "DTEND:20260715T200000Z",
      `SUMMARY:${title}`,
      "STATUS:CONFIRMED",
      `DESCRIPTION:${description}`,
      `URL:${APP_URL}/e/${row.eventKey}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT30M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${title}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    expect(eventIcs(event, APP_URL)).toBe(expected);
    expectXmlCharacters(eventsRss([event], APP_URL, row.updatedAt));
    expect(eventIcs(event, APP_URL)).toBe(expected);
    expect(eventsIcsCollection([event], APP_URL)).toBe(expected);
    expect(event.title).toBe(title);
    expect(event.description).toBe(description);
  });
});
