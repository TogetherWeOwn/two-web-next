// Failing-first acceptance: machine docs revalidate without changing their 200 contract.
// Test Author owned. Builder builds on this branch; corrections return to the author.
// Run: env -u DATABASE_URL -u BOT_DATABASE_URL npx vitest run test/machine-doc-revalidation-acceptance.test.ts
// Only the event-read boundary is replaced: real mounted routes, Markdown builders,
// OpenAPI serialization, validator matching and robots middleware run unchanged.
// Breaks caught: missing/constant/weak validators, hashing anything but response bytes,
// per-route omissions, stale APP_URL/content validators, cacheable errors, lost robots
// headers on 304, and accidental 200-body/TTL/media-type changes.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { getPublicEvent, listFeed, type PublicEvent } from "../src/events/reads";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
  listFeed: vi.fn(),
}));

const APP_URL = "https://togetherweown.com";
const OTHER_URL = "https://machine-docs.example.test";
const KEY = "00000000000000000000000081";
const MARKDOWN = "text/markdown; charset=utf-8";
const EVENT: PublicEvent = {
  id: 7,
  icsSequence: 4n,
  syncRevision: 1,
  syncedRevision: 0,
  eventKey: KEY,
  title: "Café 🎲 game night",
  description: "Bring a friend & a board.\n\nSecond paragraph.",
  game: "Chess",
  startsAt: new Date("2099-01-10T20:00:00Z"),
  endsAt: new Date("2099-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "The lobby",
  capacity: 10,
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
  createdAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2099-01-01T00:00:00Z"),
  goingCount: 3,
  goingOccupancy: 3,
};

// Single source of truth: every machine-doc path occurs in this table once.
// All Markdown entries exercise mdOk through the public app, not a test copy.
const MACHINE_DOCS = [
  { path: "/llms.txt", mime: MARKDOWN, ttl: 3600, kind: "index" },
  { path: "/about.md", mime: MARKDOWN, ttl: 3600, kind: "static" },
  { path: "/faq.md", mime: MARKDOWN, ttl: 3600, kind: "static" },
  { path: "/rules.md", mime: MARKDOWN, ttl: 3600, kind: "static" },
  { path: "/privacy.md", mime: MARKDOWN, ttl: 3600, kind: "static" },
  { path: "/join.md", mime: MARKDOWN, ttl: 3600, kind: "static" },
  { path: "/events.md", mime: MARKDOWN, ttl: 300, kind: "collection" },
  { path: `/e/${KEY}.md`, mime: MARKDOWN, ttl: 300, kind: "detail" },
  { path: "/openapi.json", mime: "application/json", ttl: 3600, kind: "openapi" },
] as const;
const INDEX = MACHINE_DOCS.find((doc) => doc.kind === "index")!;
const EVENT_DOCS = MACHINE_DOCS.filter((doc) => doc.kind === "collection" || doc.kind === "detail");

// Any unmocked database operation fails locally, rather than reaching a real DB.
const offlineDb = new Proxy(
  {},
  {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("Unexpected database access in machine-doc fixture");
    },
  },
);
const env = (appUrl: string, database = true): Env =>
  ({
    APP_URL: appUrl,
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    DISCORD_GUILD_ID: "123",
    RULES_LAST_UPDATED: "2026-09-01",
    ...(database ? { ADMIN_DB: offlineDb } : {}),
  }) as unknown as Env;
const get = (path: string, appUrl = APP_URL, validator?: string, database = true) =>
  app.request(
    path,
    {
      headers: validator === undefined ? {} : { "if-none-match": validator },
    },
    env(appUrl, database),
  );

// Independent byte oracle, not etagFor/matchesIfNoneMatch from production.
const etagOf = (bytes: Uint8Array): string => `"${createHash("sha1").update(bytes).digest("hex")}"`;
const bodyBytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const cacheControl = (ttl: number) => `public, max-age=${ttl}`;

beforeEach(() => {
  vi.mocked(listFeed)
    .mockReset()
    .mockResolvedValue([{ ...EVENT }]);
  vi.mocked(getPublicEvent)
    .mockReset()
    .mockResolvedValue({ ...EVENT });
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network access in machine-doc fixture");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(MACHINE_DOCS)("machine-doc validator: $path", (doc) => {
  it("preserves the public 200 media type, TTL, robots and body bytes", async () => {
    const res = await get(doc.path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(doc.mime);
    expect(res.headers.get("cache-control")).toBe(cacheControl(doc.ttl));
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    const bytes = await bodyBytes(res);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Baseline hashes captured on the pinned main, independently of the builders.
    // llms.txt intentionally gains the requested single revalidation sentence.
    if (doc.kind !== "index") {
      expect(createHash("sha256").update(bytes).digest("hex")).toMatchSnapshot();
    }
    const repeated = await get(doc.path);
    expect(await bodyBytes(repeated)).toEqual(bytes);
  });

  it("emits a strong byte validator and answers matching, weak, list and wildcard requests", async () => {
    for (const origin of [APP_URL, OTHER_URL]) {
      const first = await get(doc.path, origin);
      expect(first.status).toBe(200);
      const bytes = await bodyBytes(first);
      const tag = etagOf(bytes);
      expect(first.headers.get("etag")).toBe(tag);
      const robots = origin === APP_URL ? null : "noindex, nofollow";
      expect(first.headers.get("x-robots-tag")).toBe(robots);
      for (const validator of [
        tag,
        `W/${tag}`,
        `"not-this-document", ${tag}, "also-not-this-document"`,
        `"not-this-document", W/${tag}`,
        "*",
        "  *  ",
      ]) {
        const cached = await get(doc.path, origin, validator);
        expect(cached.status, validator).toBe(304);
        expect(await bodyBytes(cached), validator).toHaveLength(0);
        expect(cached.headers.get("etag"), validator).toBe(tag);
        expect(cached.headers.get("cache-control"), validator).toBe(cacheControl(doc.ttl));
        expect(cached.headers.get("x-robots-tag"), validator).toBe(robots);
        expect(cached.headers.get("set-cookie"), validator).toBeNull();
      }
      for (const validator of ['"not-this-document"', 'W/"not-this-document", "another"']) {
        const changed = await get(doc.path, origin, validator);
        expect(changed.status, validator).toBe(200);
        expect(await bodyBytes(changed), validator).toEqual(bytes);
        expect(changed.headers.get("etag"), validator).toBe(tag);
        expect(changed.headers.get("content-type")).toBe(doc.mime);
        expect(changed.headers.get("cache-control")).toBe(cacheControl(doc.ttl));
        expect(changed.headers.get("x-robots-tag")).toBe(robots);
      }
    }
  });

  it("changes its validator with APP_URL and refuses the previous origin's validator", async () => {
    const first = await get(doc.path);
    expect(first.status).toBe(200);
    const firstBytes = await bodyBytes(first);
    const oldTag = etagOf(firstBytes);
    expect(first.headers.get("etag")).toBe(oldTag);
    const changed = await get(doc.path, OTHER_URL, oldTag);
    expect(changed.status).toBe(200);
    const changedBytes = await bodyBytes(changed);
    expect(changedBytes).not.toEqual(firstBytes);
    const nextTag = etagOf(changedBytes);
    expect(nextTag).not.toBe(oldTag);
    expect(changed.headers.get("etag")).toBe(nextTag);
    const cached = await get(doc.path, OTHER_URL, nextTag);
    expect(cached.status).toBe(304);
    expect(await bodyBytes(cached)).toHaveLength(0);
    expect(cached.headers.get("etag")).toBe(nextTag);
    expect(cached.headers.get("cache-control")).toBe(cacheControl(doc.ttl));
    expect(cached.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe.each(EVENT_DOCS)("dynamic Markdown validator: $path", (doc) => {
  it("invalidates on changed event bytes, not just the path and configured origin", async () => {
    const first = await get(doc.path);
    expect(first.status).toBe(200);
    const before = await first.text();
    const tag = first.headers.get("etag");
    expect(tag).toBe(etagOf(new TextEncoder().encode(before)));
    const changedEvent = { ...EVENT, title: "Renamed 日本語 game night" };
    vi.mocked(listFeed).mockResolvedValue([changedEvent]);
    vi.mocked(getPublicEvent).mockResolvedValue(changedEvent);
    const changed = await get(doc.path, APP_URL, tag!);
    expect(changed.status).toBe(200);
    const after = await changed.text();
    expect(after).toContain(changedEvent.title);
    expect(after).not.toContain(EVENT.title);
    expect(changed.headers.get("etag")).toBe(etagOf(new TextEncoder().encode(after)));
    expect(changed.headers.get("etag")).not.toBe(tag);
    const settled = await get(doc.path, APP_URL, changed.headers.get("etag")!);
    expect(settled.status).toBe(304);
    expect(await settled.text()).toBe("");
  });

  it("never turns an unavailable database into a cacheable response or wildcard 304", async () => {
    for (const origin of [APP_URL, OTHER_URL]) {
      for (const validator of [undefined, "*", '"stale-document"']) {
        const res = await get(doc.path, origin, validator, false);
        expect(res.status).toBe(503);
        expect(res.headers.get("content-type")).toBe(MARKDOWN);
        expect(res.headers.get("cache-control")).toBe("no-store, private");
        expect(res.headers.get("etag")).toBeNull();
        // Preserve the existing outage response (mdUnavailable has no robots tag).
        expect(res.headers.get("x-robots-tag")).toBeNull();
        expect(await res.text()).toContain("Events temporarily unavailable");
      }
    }
  });
});

describe("Markdown refusals remain uncacheable", () => {
  const detail = EVENT_DOCS.find((doc) => doc.kind === "detail")!;
  it.each([
    { name: "unknown", status: 404, row: null },
    { name: "draft", status: 403, row: { ...EVENT, status: "draft" as const } },
    { name: "cancelled", status: 410, row: { ...EVENT, status: "cancelled" as const } },
  ])("$name detail keeps its status and no-store without ETag", async ({ status, row }) => {
    vi.mocked(getPublicEvent).mockResolvedValue(row);
    for (const origin of [APP_URL, OTHER_URL]) {
      for (const validator of [undefined, "*", '"stale-document"']) {
        const res = await get(detail.path, origin, validator);
        expect(res.status).toBe(status);
        expect(res.headers.get("content-type")).toBe(MARKDOWN);
        // The gone notice's existing directive order differs from mdError.
        expect(res.headers.get("cache-control")).toBe(
          status === 410 ? "private, no-store" : "no-store, private",
        );
        expect(res.headers.get("etag")).toBeNull();
        expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect((await res.text()).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("agent-facing revalidation guidance", () => {
  it("keeps the index in its current sub-2-KiB footprint", async () => {
    // Main is 1668 UTF-8 bytes at APP_URL. No tracked llms-specific numeric
    // ceiling exists; 2 KiB leaves space for the requested short sentence.
    const res = await get(INDEX.path);
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).byteLength).toBeLessThanOrEqual(2048);
  });

  it("teaches If-None-Match revalidation in the served machine index", async () => {
    const res = await get(INDEX.path);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/[^\n]*If-None-Match[^\n]*/);
    const guidance = body.split("\n").filter((line) => line.includes("If-None-Match"));
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatch(/revalidat|conditional|304/i);
    expect(guidance[0]).toMatch(/ETag/i);
  });
});
