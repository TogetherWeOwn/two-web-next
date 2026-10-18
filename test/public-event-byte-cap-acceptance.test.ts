// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: POST /mcp
// Acceptance: an event representation whose irreducible metadata (title,
// game, location) alone exceeds API_PUBLIC_BOUNDS.maxBodyBytes must never
// be returned or cached as a success. Description trimming cannot save it,
// so the only contract-preserving answer is the existing static
// "unavailable" envelope: REST 503 with no-store, private; MCP tool error
// inside the unchanged JSON-RPC result envelope. Rows must never be
// dropped, metadata never truncated, the cap never raised, and code points
// never split. Real app + agent-testdb/CI Postgres only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import app from "./app";
import { parseEventForm } from "../src/admin/validation";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import {
  API_PUBLIC_BOUNDS,
  PUBLIC_API_EVENT_FIELDS,
  type PublicApiEventCollectionDto,
  type PublicApiEventDto,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// All-digit 26-char keys, same shape as the api-public-events pins, so no
// secret scanner trips.
const key = (n: number) => String(n).padStart(26, "0");

const MAX_BYTES = API_PUBLIC_BOUNDS.maxBodyBytes;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

// One astral code point: 1 code point, 2 UTF-16 units, 4 UTF-8 bytes. At
// the event-form caps (title 100, game 100, location 255 code points) one
// row of maximum-width metadata is (100 + 100 + 255) * 4 = 1,820 bytes
// before any JSON overhead, so a full 20-row page is 36,400 bytes of
// metadata alone — irreducibly above the 32 KiB cap.
const ASTRAL = "😀";
const MAX_TITLE = ASTRAL.repeat(100);
const MAX_GAME = ASTRAL.repeat(100);
const MAX_LOCATION = ASTRAL.repeat(255);
const MAX_DESCRIPTION = ASTRAL.repeat(1000);
const METADATA_BYTES_PER_ROW =
  byteLength(MAX_TITLE) + byteLength(MAX_GAME) + byteLength(MAX_LOCATION);

const UNAVAILABLE = {
  error: { code: "unavailable", message: "Event data is temporarily unavailable." },
} as const;

type RpcResponse = {
  status: number;
  headers: Headers;
  messages: Record<string, unknown>[];
};

describe.skipIf(!process.env.DATABASE_URL)("public event byte cap: irreducible metadata", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let store: SessionStore;
  let env: Env & EnvWithThrottle;
  let now: number;
  let hits: { bucket: string; at: number }[];
  let eventStore: Mock<() => unknown>;

  const throttleDouble = () => {
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("SELECT count(*)")) {
          const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
          return [
            {
              n: rows.length,
              wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
            },
          ];
        }
        if (statement.includes("INSERT INTO web_throttle_hits")) {
          hits.push({ bucket: String(values[0]), at: now });
          return [];
        }
        if (statement.includes("DELETE FROM web_throttle_hits")) return [];
        throw new Error("Unexpected throttle statement");
      },
      {
        begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
        // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before
        // the advisory lock; the double passes it through.
        unsafe: async () => [],
      },
    );
    return sql;
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    store = createMemorySessionStore();
    now = Date.now();
    hits = [];
    eventStore = vi.fn(() => db);
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_STORE: store,
      THROTTLE_STORE: async () => throttleDouble() as unknown as Sql,
      get ADMIN_DB() {
        return eventStore();
      },
    } as unknown as Env & EnvWithThrottle;
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetApiPublicCacheForTests();
    hits = [];
    eventStore.mockClear();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string, ip = "192.0.2.71") =>
    app.request(path, { headers: { "cf-connecting-ip": ip } }, env);

  const post = async (body: unknown, ip = "192.0.2.71"): Promise<RpcResponse> => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify(body),
      },
      env,
    );
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let messages: Record<string, unknown>[];
    if (contentType.includes("text/event-stream")) {
      messages = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice("data:".length).trim()));
    } else if (text.length > 0) {
      messages = [JSON.parse(text)];
    } else {
      messages = [];
    }
    return { status: res.status, headers: res.headers, messages };
  };

  const initializeMcp = async () => {
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "byte-cap-acceptance-test", version: "0" },
      },
    });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  };

  const callTool = (name: string, args: Record<string, unknown>, id: number | string = 3) =>
    post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  // One full page of validator-admissible maximum-width metadata rows.
  const seedMaxMetadataPage = (extra: Record<string, unknown> = {}) =>
    db.insert(events).values(
      Array.from({ length: API_PUBLIC_BOUNDS.maxPageSize }, (_, i) => ({
        eventKey: key(i + 1),
        title: MAX_TITLE,
        game: MAX_GAME,
        location: MAX_LOCATION,
        description: null,
        status: "published",
        startsAt: new Date(Date.UTC(2099, 0, i + 1, 20)),
        endsAt: new Date(Date.UTC(2099, 0, i + 1, 22)),
        ...extra,
      })),
    );

  it("proves the fixture is validator-admissible and irreducibly over the cap", () => {
    expect(MAX_BYTES).toBe(32 * 1024);
    expect([...MAX_TITLE]).toHaveLength(100);
    expect([...MAX_GAME]).toHaveLength(100);
    expect([...MAX_LOCATION]).toHaveLength(255);
    expect([...MAX_DESCRIPTION]).toHaveLength(1000);
    expect(byteLength(ASTRAL)).toBe(4);
    expect(byteLength(MAX_TITLE)).toBe(400);
    expect(byteLength(MAX_GAME)).toBe(400);
    expect(byteLength(MAX_LOCATION)).toBe(1020);
    expect(METADATA_BYTES_PER_ROW).toBe(1820);
    // Metadata alone, before event keys, timestamps or JSON punctuation,
    // already exceeds the cap: no description trimming can recover it.
    expect(METADATA_BYTES_PER_ROW * API_PUBLIC_BOUNDS.maxPageSize).toBe(36_400);
    expect(METADATA_BYTES_PER_ROW * API_PUBLIC_BOUNDS.maxPageSize).toBeGreaterThan(MAX_BYTES);

    const parsed = parseEventForm({
      title: MAX_TITLE,
      game: MAX_GAME,
      location: MAX_LOCATION,
      timezone: "UTC",
      starts_at: "2099-01-01 20:00",
      ends_at: "2099-01-01 22:00",
    });
    expect(parsed.title).toBe(MAX_TITLE);
    expect(parsed.game).toBe(MAX_GAME);
    expect(parsed.location).toBe(MAX_LOCATION);
    expect(parsed.description).toBeNull();

    const withDescription = parseEventForm({
      title: MAX_TITLE,
      game: MAX_GAME,
      location: MAX_LOCATION,
      description: MAX_DESCRIPTION,
      timezone: "UTC",
      starts_at: "2099-01-01 20:00",
      ends_at: "2099-01-01 22:00",
    });
    expect(withDescription.description).toBe(MAX_DESCRIPTION);
  });

  it("answers the static 503 envelope for a max-metadata page with null descriptions", async () => {
    await seedMaxMetadataPage();
    const res = await get("/api/public/events");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const raw = await res.text();
    expect(byteLength(raw)).toBeLessThanOrEqual(MAX_BYTES);
    expect(JSON.parse(raw)).toEqual(UNAVAILABLE);
    // No metadata leaks through in truncated form.
    expect(raw).not.toContain(ASTRAL);
  });

  it("answers 503 after description trimming is exhausted and metadata still overflows", async () => {
    await seedMaxMetadataPage({ description: MAX_DESCRIPTION });
    const res = await get("/api/public/events");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const raw = await res.text();
    expect(byteLength(raw)).toBeLessThanOrEqual(MAX_BYTES);
    expect(JSON.parse(raw)).toEqual(UNAVAILABLE);
    expect(raw).not.toContain(ASTRAL);
  });

  it("never caches an oversized collection as a success for a repeat request", async () => {
    await seedMaxMetadataPage();
    const first = await get("/api/public/events");
    expect(first.status).toBe(503);
    const firstBody = await first.text();
    eventStore.mockClear();
    const second = await get("/api/public/events");
    expect(second.status).toBe(503);
    expect(await second.text()).toBe(firstBody);
    // A cached success would be served before any database read; the
    // overflow path must reach the store again instead of replaying one.
    expect(eventStore).toHaveBeenCalled();
  });

  it("answers the static 503 envelope for one stored event whose metadata alone exceeds the cap", async () => {
    // Stored rows can predate or bypass the form caps (imports, older
    // writers); the representation contract itself is unconditional, so
    // the single-event caller gets the same refusal as the collection.
    const giantTitle = ASTRAL.repeat(9000);
    expect(byteLength(giantTitle)).toBe(36_000);
    expect(byteLength(giantTitle)).toBeGreaterThan(MAX_BYTES);
    await seed(61, { title: giantTitle, description: null });
    const res = await get(`/api/public/events/${key(61)}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const raw = await res.text();
    expect(byteLength(raw)).toBeLessThanOrEqual(MAX_BYTES);
    expect(JSON.parse(raw)).toEqual(UNAVAILABLE);
    expect(raw).not.toContain(ASTRAL);
    const repeat = await get(`/api/public/events/${key(61)}`);
    expect(repeat.status).toBe(503);
    expect(await repeat.json()).toEqual(UNAVAILABLE);
  });

  it("keeps a small max-metadata collection successful with metadata byte-identical", async () => {
    await seed(71, {
      title: MAX_TITLE,
      game: MAX_GAME,
      location: MAX_LOCATION,
      description: null,
    });
    await seed(72, {
      title: MAX_TITLE,
      game: MAX_GAME,
      location: MAX_LOCATION,
      description: null,
    });
    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(byteLength(raw)).toBeLessThanOrEqual(MAX_BYTES);
    const body = JSON.parse(raw) as PublicApiEventCollectionDto;
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual({ current_page: 1, per_page: 20, total: 2, last_page: 1 });
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([...PUBLIC_API_EVENT_FIELDS].sort());
      // Metadata is never truncated to fit: it round-trips exactly.
      expect(row.title).toBe(MAX_TITLE);
      expect(row.game).toBe(MAX_GAME);
      expect(row.location).toBe(MAX_LOCATION);
      expect(row.description).toBeNull();
      expect(validatePublicSchema(row, "PublicApiEvent")).toEqual([]);
    }
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("keeps a description-trimmed collection successful, schema-valid and complete", async () => {
    for (let i = 0; i < 10; i++) await seed(81 + i, { description: MAX_DESCRIPTION });
    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(byteLength(raw)).toBeLessThanOrEqual(MAX_BYTES);
    const body = JSON.parse(raw) as PublicApiEventCollectionDto;
    expect(body.data).toHaveLength(10);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const trimmed = body.data.filter((row) => row.description!.endsWith("…"));
    expect(trimmed.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(loneSurrogate.test(row.description!), row.event_key).toBe(false);
    }
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("maps a max-metadata page to the MCP unavailable tool error on list_events", async () => {
    await seedMaxMetadataPage();
    await initializeMcp();
    const called = await callTool("list_events", { per_page: 20, page: 1 });
    // The JSON-RPC envelope policy is unchanged: HTTP 200, a result (not a
    // protocol error), carrying the tool error.
    expect(called.status).toBe(200);
    expect(called.messages).toHaveLength(1);
    expect(called.messages[0]).toMatchObject({ jsonrpc: "2.0", id: 3 });
    expect(called.messages[0]).not.toHaveProperty("error");
    const result = called.messages[0]!["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(result["structuredContent"]).toBeUndefined();
    const content = result["content"] as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(byteLength(content[0]!.text)).toBeLessThanOrEqual(MAX_BYTES);
    expect(JSON.parse(content[0]!.text)).toEqual(UNAVAILABLE);
    expect(content[0]!.text).not.toContain(ASTRAL);
  });

  it("maps one oversized stored event to the MCP unavailable tool error on get_event", async () => {
    await seed(61, { title: ASTRAL.repeat(9000), description: null });
    await initializeMcp();
    const called = await callTool("get_event", { event_key: key(61) }, 4);
    expect(called.status).toBe(200);
    expect(called.messages[0]).toMatchObject({ jsonrpc: "2.0", id: 4 });
    expect(called.messages[0]).not.toHaveProperty("error");
    const result = called.messages[0]!["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect(result["structuredContent"]).toBeUndefined();
    const content = result["content"] as { type: string; text: string }[];
    expect(byteLength(content[0]!.text)).toBeLessThanOrEqual(MAX_BYTES);
    expect(JSON.parse(content[0]!.text)).toEqual(UNAVAILABLE);
    expect(content[0]!.text).not.toContain(ASTRAL);
  });

  it("keeps MCP list_events successful for a small max-metadata collection", async () => {
    await seed(71, {
      title: MAX_TITLE,
      game: MAX_GAME,
      location: MAX_LOCATION,
      description: null,
    });
    await initializeMcp();
    const called = await callTool("list_events", { per_page: 20, page: 1 }, 5);
    expect(called.status).toBe(200);
    const result = called.messages[0]!["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data).toHaveLength(1);
    const row = structured.data[0]! as PublicApiEventDto;
    expect(row.title).toBe(MAX_TITLE);
    expect(row.game).toBe(MAX_GAME);
    expect(row.location).toBe(MAX_LOCATION);
    expect(validatePublicSchema(structured, "PublicApiEventCollection")).toEqual([]);
    const content = result["content"] as { type: string; text: string }[];
    expect(byteLength(content[0]!.text)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("keeps MCP list_events successful when descriptions trim to fit", async () => {
    for (let i = 0; i < 10; i++) await seed(81 + i, { description: MAX_DESCRIPTION });
    await initializeMcp();
    const called = await callTool("list_events", { per_page: 20, page: 1 }, 6);
    expect(called.status).toBe(200);
    const result = called.messages[0]!["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data).toHaveLength(10);
    expect(validatePublicSchema(structured, "PublicApiEventCollection")).toEqual([]);
    const content = result["content"] as { type: string; text: string }[];
    expect(byteLength(content[0]!.text)).toBeLessThanOrEqual(MAX_BYTES);
  });
});
