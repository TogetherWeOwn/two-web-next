// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// Bounded public read API: event collection + single event. Real app +
// agent-testdb/CI Postgres only. The session-gated /events.json contract
// stays unchanged; these routes read no session and serve published rows
// only to every viewer.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import app from "./app";
import { updateEvent } from "../src/admin/store-event-writes";
import { parseEventForm } from "../src/admin/validation";
import {
  DEFAULT_CONFIG as AGENT_DEFAULT_CONFIG,
  handleAgentEvent,
  type IngressConfig,
} from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  API_PUBLIC_BOUNDS,
  PUBLIC_API_EVENT_FIELDS,
  type PublicApiEventCollectionDto,
  type PublicApiEventDto,
} from "../src/public-data/contracts";
import {
  API_PUBLIC_CACHE_TTL_MS,
  __resetApiPublicCacheForTests,
  readApiPublicCache,
  retireApiPublicEventCache,
  writeApiPublicCache,
} from "../src/public-data/cache";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

// Deferred-reader gate for the overtaken-read pin below: the mocked
// collection read resolves its rows first (so the in-flight request has
// already seen pre-retirement bytes), then pauses on the test's promise
// before returning to the route. Null unless a test arms it.
const gates = vi.hoisted(() => ({
  collection: null as null | { used: boolean; arrived: () => void; gate: Promise<void> },
}));
vi.mock("../src/events/reads", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/events/reads")>();
  return {
    ...original,
    listPublicApiEvents: async (...args: Parameters<typeof original.listPublicApiEvents>) => {
      const result = await original.listPublicApiEvents(...args);
      const gate = gates.collection;
      if (gate && !gate.used) {
        gate.used = true;
        gate.arrived();
        await gate.gate;
      }
      return result;
    },
  };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// All-digit 26-char keys, same shape as the paging pins in
// test/events.test.ts, so no secret scanner trips.
const key = (n: number) => String(n).padStart(26, "0");

const MAX_BYTES = 32 * 1024;

const maxAgeOf = (res: Response): number | null => {
  const header = res.headers.get("cache-control");
  const match = header ? header.match(/max-age=(\d+)/) : null;
  return match ? Number(match[1]) : null;
};

describe.skipIf(!process.env.DATABASE_URL)("public read API: events", () => {
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
    await fixture.client.unsafe(
      `INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash) VALUES ($1,'co',$2,$3)`,
      [CALLER, agentCfg.stagingGuildId, await sha256Hex(agentToken)],
    );
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetApiPublicCacheForTests();
    gates.collection = null;
    hits = [];
    eventStore.mockClear();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string, init: RequestInit = {}, ip = "192.0.2.71") =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": ip, ...init.headers } }, env);

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  const moderatorCookie = async () => {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000171",
      username: "100000000000000171",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };

  // Agent ingress identity for the denials-retire-nothing pin (one grant per
  // suite; events reset per test, grants persist because the fixture reset
  // keeps grant tables).
  const CALLER = "public-cache-agent-under-test";
  const agentCfg: IngressConfig = {
    ...AGENT_DEFAULT_CONFIG,
    enabled: true,
    callerAgentId: CALLER,
    lockWaitMs: 1500,
  };
  const agentToken = `tok-public-cache-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let idemCounter = 0;
  const idemKey = () => `public-cache-${Date.now()}-${++idemCounter}`;

  const agentCall = (body: unknown, token: string | null = agentToken) =>
    handleAgentEvent(fixture.client, agentCfg, body, token);

  const AGENT_FIELDS = {
    title: "Agent public-cache proof",
    game: "Helldivers 2",
    description: "Uniquely labelled public-cache proof.",
    starts_at: "2099-10-01 20:00",
    ends_at: "2099-10-01 22:00",
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: 4,
  };

  const smuggleTitle = (eventKey: string, title: string) =>
    fixture.client`update events set title = ${title} where event_key = ${eventKey}`;

  it("lists published events soonest-first with the shared 16-key projection", async () => {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: key(41),
        title: "Counted night",
        status: "published",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
      })
      .returning();
    // Attributable seeds: the going count only counts named rows.
    await db
      .insert(users)
      .values([
        { id: "going-1", username: "going-1" },
        { id: "going-2", username: "going-2" },
      ])
      .onConflictDoNothing();
    await db.insert(rsvps).values([
      { eventId: ev!.id, userId: "going-1", status: "going" },
      { eventId: ev!.id, userId: "going-2", status: "going" },
      { eventId: ev!.id, userId: "unsure", status: "maybe" },
    ]);
    await seed(42, { status: "draft", title: "Hidden draft" });
    await seed(43, { status: "cancelled", title: "Called off" });
    await seed(44);

    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as PublicApiEventCollectionDto;
    expect(body.page).toBe(1);
    expect(body.meta.total).toBe(2);
    // Drafts and cancelled rows never reach AI consumers.
    expect(body.data.map((row) => row.event_key)).toEqual([key(44), key(41)]);
    const counted = body.data.find((row) => row.event_key === key(41))!;
    expect(counted.going_count).toBe(2);
    expect(body.data.find((row) => row.event_key === key(44))!.going_count).toBe(0);
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([...PUBLIC_API_EVENT_FIELDS].sort());
      expect(row.status).toBe("published");
      expect(validatePublicSchema(row, "PublicApiEvent")).toEqual([]);
    }
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("caps the collection at 20 rows even when asked for more", async () => {
    expect(API_PUBLIC_BOUNDS.maxPageSize).toBe(20);
    await db.insert(events).values(
      Array.from({ length: 25 }, (_, i) => ({
        eventKey: key(100 + i),
        title: `Game ${100 + i}`,
        status: "published",
        startsAt: new Date(Date.UTC(2099, 1, 1, i, 0)),
        endsAt: new Date(Date.UTC(2099, 1, 1, i, 2)),
      })),
    );
    const res = await get("/api/public/events?per_page=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicApiEventCollectionDto;
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(20);
    expect(body.meta).toEqual({ current_page: 1, per_page: 20, total: 25, last_page: 2 });
  });

  it("clamps a past-the-end page to the last page before issuing an offset", async () => {
    await seed(1);
    await seed(2);
    const res = await get("/api/public/events?per_page=1&page=99999999");
    const body = (await res.json()) as PublicApiEventCollectionDto;
    expect(body.page).toBe(2);
    expect(body.data.map((row) => row.event_key)).toEqual([key(2)]);
  });

  it("keeps every response body within 32 KiB by trimming descriptions", async () => {
    await seed(7, { description: "x".repeat(100_000), title: "Long read" });
    await seed(8, { description: "y".repeat(100_000), title: "Long read two" });
    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_BYTES);
    const body = JSON.parse(raw) as PublicApiEventCollectionDto;
    expect(body.data).toHaveLength(2);
    for (const row of body.data) expect(row.description!.endsWith("…")).toBe(true);
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("trims astral descriptions on code-point boundaries", async () => {
    // 10 events of 1000 emoji (the form cap) push the body past 32 KiB, so
    // the trimmer runs on exactly the inputs that used to split UTF-16
    // surrogate pairs into lone surrogates strict decoders reject.
    for (let i = 0; i < 10; i++) await seed(31 + i, { description: "😀".repeat(1000) });
    const res = await get("/api/public/events");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_BYTES);
    const body = JSON.parse(raw) as PublicApiEventCollectionDto;
    expect(body.data).toHaveLength(10);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const trimmed = body.data.filter((row) => row.description!.endsWith("…"));
    // The cap forces at least one trim, and no row — trimmed or intact —
    // may carry a split surrogate pair.
    expect(trimmed.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(loneSurrogate.test(row.description!), row.event_key).toBe(false);
    }
    expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
  });

  it("serves one published event and 404s drafts, cancelled rows and missing keys", async () => {
    // Synthetic mirror id: non-numeric on purpose, so the secret scanner
    // never reads it as a Discord snowflake. The property under test is
    // non-reflection of the stored id, whatever its shape.
    await seed(11, { discordEventId: "mirror-ev-11" });
    await seed(12, { status: "draft" });
    await seed(13, { status: "cancelled" });
    const ok = await get(`/api/public/events/${key(11)}`);
    expect(ok.status).toBe(200);
    const row = (await ok.json()) as PublicApiEventDto;
    expect(row.event_key).toBe(key(11));
    expect(row.synced_to_discord).toBe(true);
    expect(validatePublicSchema(row, "PublicApiEvent")).toEqual([]);
    // The raw Discord mirror id never leaves the server.
    const raw = await (await get(`/api/public/events/${key(11)}`)).text();
    expect(raw).not.toContain("mirror-ev-11");
    for (const missing of [key(12), key(13), key(99)]) {
      const res = await get(`/api/public/events/${missing}`);
      expect(res.status, missing).toBe(404);
      expect(await res.json()).toEqual({
        error: {
          code: "not_found",
          message: "No published event with that key.",
          request_id: expect.any(String),
          next: "Check the event key and retry.",
        },
      });
    }
  });

  it("refuses a malformed event key with invalid_request and no reflection", async () => {
    const res = await get("/api/public/events/not-a-key!!!");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "That event key is not valid.",
        request_id: expect.any(String),
        next: "Fix the request and retry.",
      },
    });
    const raw = await (await get("/api/public/events/x")).text();
    expect(raw).not.toContain("not-a-key");
  });

  it("pairs the attributable going_count with seat occupancy when a nameless row holds a seat", async () => {
    // A client computing capacity minus going_count would see a free seat
    // the write path will not grant, so occupancy ships beside the count on
    // both the collection and the single route.
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: key(31),
        title: "Game 31",
        status: "published",
        startsAt: new Date(Date.UTC(2099, 0, 31, 20)),
        endsAt: new Date(Date.UTC(2099, 0, 31, 22)),
        capacity: 2,
      })
      .returning();
    await db
      .insert(users)
      .values([
        { id: "api-named", username: "api-named" },
        { id: "api-nameless", username: "" },
      ])
      .onConflictDoNothing();
    await db.insert(rsvps).values([
      { eventId: ev!.id, userId: "api-named", status: "going" },
      { eventId: ev!.id, userId: "api-nameless", status: "going" },
    ]);
    const listed = (await (await get("/api/public/events")).json()) as PublicApiEventCollectionDto;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ going_count: 1, going_occupancy: 2, capacity: 2 });
    expect(validatePublicSchema(listed, "PublicApiEventCollection")).toEqual([]);
    const single = (await (await get(`/api/public/events/${key(31)}`)).json()) as PublicApiEventDto;
    expect(single).toMatchObject({ going_count: 1, going_occupancy: 2, capacity: 2 });
    expect(validatePublicSchema(single, "PublicApiEvent")).toEqual([]);
  });

  it("returns null, never 0, when the going-count aggregate is unavailable", async () => {
    await seed(21);
    await db.execute("ALTER TABLE rsvps RENAME TO rsvps_hidden_probe");
    try {
      const res = await get("/api/public/events");
      expect(res.status).toBe(200);
      const body = (await res.json()) as PublicApiEventCollectionDto;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.going_count).toBeNull();
      expect(body.data[0]!.going_occupancy).toBeNull();
      expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
    } finally {
      await db.execute("ALTER TABLE rsvps_hidden_probe RENAME TO rsvps");
    }
  });

  it("answers 503 unavailable, never an empty list, when the database is down", async () => {
    eventStore.mockReturnValueOnce(null);
    const res = await get("/api/public/events");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "unavailable",
        message: "Event data is temporarily unavailable.",
        request_id: expect.any(String),
        next: "Retry the read shortly.",
      },
    });
  });

  it("refuses past the shared budget with a JSON 429, Retry-After and no store read", async () => {
    for (let n = 0; n < 60; n++) {
      const probe = await get("/api/public/events", {}, "192.0.2.72");
      expect(probe.status).not.toBe(429);
    }
    eventStore.mockClear();
    for (const path of ["/api/public/events", `/api/public/events/${key(1)}`]) {
      const res = await get(path, { headers: { accept: "application/json" } }, "192.0.2.72");
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(await res.json()).toEqual({
        error: {
          code: "rate_limited",
          message: "Too many requests. Try again in 60 seconds.",
          request_id: expect.any(String),
          next: "Wait for Retry-After, then retry.",
        },
      });
    }
    expect(eventStore).not.toHaveBeenCalled();
  });

  it("emits an ETag and answers 304 without touching the database again", async () => {
    await seed(31);
    const first = await get("/api/public/events");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    await first.text();
    eventStore.mockClear();
    const cached = await get("/api/public/events", { headers: { "if-none-match": etag! } });
    expect(cached.status).toBe(304);
    // Remaining TTL, rounded down, on a real clock: any elapsed millisecond
    // makes a back-to-back hit answer 59, a same-instant hit answers 60. Same
    // tolerance as the anonymous-card retire pins; exact values stay pinned
    // under a fake clock.
    expect(cached.headers.get("cache-control")).toMatch(/^public, max-age=(59|60)$/);
    expect(eventStore).not.toHaveBeenCalled();
  });

  it("isolates the cache across cookies and moderator sessions", async () => {
    await seed(51);
    await seed(52, { status: "draft", title: "Moderator-only draft" });
    const anon = await get("/api/public/events");
    const anonBody = await anon.text();
    const mod = await get("/api/public/events", { headers: { cookie: await moderatorCookie() } });
    // A moderator session buys no extra rows: the representation is identical.
    expect(await mod.text()).toBe(anonBody);
    expect(
      (JSON.parse(anonBody) as PublicApiEventCollectionDto).data.map((r) => r.event_key),
    ).toEqual([key(51)]);
    // A fresh published row stays hidden until the cache entry is retired.
    await seed(53);
    expect(await (await get("/api/public/events")).text()).toBe(anonBody);
    expect(
      await (await get("/api/public/events", { headers: { cookie: "stray=crumb" } })).text(),
    ).toBe(anonBody);
  });

  it("retires the entry at TTL expiry with a controlled clock", async () => {
    const t0 = 1_000_000;
    writeApiPublicCache(
      "GET /api/public/events?probe=ttl",
      {
        status: 200,
        headers: { etag: '"probe"', "cache-control": "public, max-age=60" },
        body: '{"probe":1}',
      },
      t0,
    );
    const hit = readApiPublicCache(
      "GET /api/public/events?probe=ttl",
      t0 + API_PUBLIC_CACHE_TTL_MS - 1,
    );
    expect(hit).not.toBeNull();
    expect(hit!.expiresAt).toBe(t0 + API_PUBLIC_CACHE_TTL_MS);
    expect(
      readApiPublicCache("GET /api/public/events?probe=ttl", t0 + API_PUBLIC_CACHE_TTL_MS),
    ).toBeNull();
    // Expiry retires the entry: a second read at the same instant still misses.
    expect(
      readApiPublicCache("GET /api/public/events?probe=ttl", t0 + API_PUBLIC_CACHE_TTL_MS),
    ).toBeNull();
  });

  it("misses the route cache at TTL expiry with a controlled clock", async () => {
    await seed(61);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      eventStore.mockClear();
      nowSpy.mockReturnValue(t0 + API_PUBLIC_CACHE_TTL_MS - 1);
      const hit = await get("/api/public/events");
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(firstBody);
      expect(eventStore).not.toHaveBeenCalled();
      nowSpy.mockReturnValue(t0 + API_PUBLIC_CACHE_TTL_MS);
      eventStore.mockClear();
      const miss = await get("/api/public/events");
      expect(miss.status).toBe(200);
      expect(await miss.text()).toBe(firstBody);
      expect(eventStore).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("serves a fresh 200 with a new ETag after expiry when rows change, then 304s the new ETag", async () => {
    await seed(71);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      const etag1 = first.headers.get("etag");
      expect(etag1).not.toBeNull();
      await first.text();
      // Change the fixture while the entry is still fresh.
      await seed(72);
      // Past TTL the next read is fresh, so the stale ETag must not 304.
      nowSpy.mockReturnValue(t0 + API_PUBLIC_CACHE_TTL_MS);
      eventStore.mockClear();
      const stale = await get("/api/public/events", {
        headers: { "if-none-match": etag1! },
      });
      expect(stale.status).toBe(200);
      const etag2 = stale.headers.get("etag");
      expect(etag2).not.toBeNull();
      expect(etag2).not.toBe(etag1);
      const freshBody = await stale.text();
      expect(freshBody).toContain(key(72));
      expect(eventStore).toHaveBeenCalled();
      // Unchanged data may 304, but only after that fresh read warmed the cache.
      eventStore.mockClear();
      const revalidated = await get("/api/public/events", {
        headers: { "if-none-match": etag2! },
      });
      expect(revalidated.status).toBe(304);
      expect(eventStore).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rounds remaining max-age down at fractional offsets, never past expiry", async () => {
    // A hit half a second before expiry must answer max-age=0: rounding up
    // would keep the body fresh past the original deadline. Whole-second
    // offsets still answer 1 (pinned by the acceptance suite).
    await seed(203);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await get("/api/public/events");
      expect(first.status).toBe(200);
      expect(maxAgeOf(first)).toBe(60);
      await first.text();
      nowSpy.mockReturnValue(t0 + 59_500);
      const hit = await get("/api/public/events");
      expect(hit.status).toBe(200);
      expect(maxAgeOf(hit)).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("answers an overtaken pre-retirement read with a non-reusable cache-control", async () => {
    // The generation fence refuses the deferred settle, but the overtaken
    // response still answers its own pre-retire bytes: those bytes must not
    // carry a reusable max-age downstream, or a cancelled event stays fresh
    // in browsers and CDNs past the retire.
    await seed(204, { title: "Old title" });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let arrived!: () => void;
    const arrivedAtGate = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    gates.collection = { used: false, arrived, gate };
    try {
      const inflight = get("/api/public/events");
      await arrivedAtGate;
      await smuggleTitle(key(204), "Smuggled title");
      retireApiPublicEventCache();
      releaseGate();
      const overtaken = await inflight;
      expect(overtaken.status).toBe(200);
      expect(await overtaken.text()).toContain("Old title");
      expect(overtaken.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
      // The refused settle left nothing shared: the next fetch re-reads.
      expect(await (await get("/api/public/events")).text()).toContain("Smuggled title");
    } finally {
      releaseGate();
      gates.collection = null;
    }
  });

  it("retires collection and detail on a committed full-form updateEvent", async () => {
    // The acceptance moderator-update test drives the JSON PATCH route
    // (patchEvent); this pins the same retire on the live admin full-form
    // edit path (updateEvent), which carries its own retire line.
    await seed(205, { title: "Old title", location: "Voice" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    expect((await get(`/api/public/events/${key(205)}`)).status).toBe(200);
    await smuggleTitle(key(205), "Smuggled title");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const actor = { id: "pin-moderator", username: "Pin Moderator" };
    const { row } = await updateEvent(
      fixture.db,
      actor,
      key(205),
      parseEventForm({
        title: "Full-form renamed night",
        game: "Chess",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
        timezone: "Europe/London",
        location: "Voice",
        capacity: 8,
      }),
    );
    expect(row.title).toBe("Full-form renamed night");

    const after = await get("/api/public/events");
    const html = await after.text();
    expect(html).toContain("Full-form renamed night");
    expect(html).not.toContain("Smuggled title");
    expect(maxAgeOf(after)).toBe(60);
    const detailAfter = await get(`/api/public/events/${key(205)}`);
    expect(detailAfter.status).toBe(200);
    expect(await detailAfter.text()).toContain("Full-form renamed night");
  });

  it("keeps entries on agent denials after re-warming past the committed create", async () => {
    // Distinguishing shape: the committed create retires (cache empty), so
    // the test re-warms with the smuggled bytes and smuggles again before
    // the denials. A denial that retired would serve the second smuggle
    // below; denials that retire nothing keep serving the first.
    await seed(206, { title: "Old title", location: "Voice" });
    expect(await (await get("/api/public/events")).text()).toContain("Old title");
    await smuggleTitle(key(206), "Smuggled one");
    expect(await (await get("/api/public/events")).text()).toContain("Old title");

    const created = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: { ...AGENT_FIELDS, title: "Agent denial-cache fixture" },
    });
    expect(created.status).toBe(201);
    const eventKey = (created.body as { event_key: string }).event_key;

    expect(await (await get("/api/public/events")).text()).toContain("Smuggled one");
    await smuggleTitle(key(206), "Smuggled two");

    const read = await agentCall({
      op: "read",
      idempotency_key: idemKey(),
      event_key: eventKey,
    });
    expect(read.status).toBe(200);
    const stale = await agentCall({
      op: "update",
      idempotency_key: idemKey(),
      event_key: eventKey,
      version: 999001,
      fields: AGENT_FIELDS,
    });
    expect(stale.status).toBe(409);

    const invalid = await agentCall({
      op: "update",
      idempotency_key: idemKey(),
      event_key: eventKey,
      version: (read.body as { event: { agent_version: number } }).event.agent_version,
      fields: { ...AGENT_FIELDS, title: "" },
    });
    expect(invalid.status).toBe(422);

    const quota = await agentCall({
      op: "create",
      idempotency_key: idemKey(),
      fields: AGENT_FIELDS,
    });
    expect(quota.status).toBe(409);

    const wrongCaller = await agentCall(
      { op: "read", idempotency_key: idemKey(), event_key: eventKey },
      "tok-unknown-public-cache",
    );
    expect(wrongCaller.status).toBe(401);

    // None of the denials retired: the re-warmed bytes stay served.
    expect(await (await get("/api/public/events")).text()).toContain("Smuggled one");
  });
});
