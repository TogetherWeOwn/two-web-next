// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: GET /events.json
// route-inventory: GET /events/:key
// route-inventory: GET /e/:key
// route-inventory: POST /events
// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: POST /events/:key/cancel
// W8: events sync carrier (unit, no DB) + public pages / JSON / moderator round-trips
// (agent-testdb; skipped without DATABASE_URL like test/admin.test.ts).
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import type { Env } from "../src/env";
import { buildSyncMessage, enqueueEventSync } from "../src/events/sync";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import type { QueueMessage } from "../src/jobs/types";

// Carrier integration (real ledger/unique lock) lives in event-writeback.test.ts.
// This suite covers message construction and public route behavior in isolation.
vi.mock("../src/jobs/worker", () => ({
  // Mirrors the real signature: the producer only ever emits the sync-event
  // variant, so the jobId spread stays assignable now alert-probe exists.
  enqueueSyncEvent: async (env: Env, message: Extract<QueueMessage, { kind: "sync-event" }>) => {
    await env.SYNC_EVENT_QUEUE!.send(
      { ...message, jobId: crypto.randomUUID() },
      { delaySeconds: 10 },
    );
    return true;
  },
}));
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

describe("event sync carrier", () => {
  it("builds upsert for published, cancel for cancelled, nothing for draft/past", () => {
    expect(buildSyncMessage("K", "published")?.kind).toBe("sync-event");
    expect(buildSyncMessage("K", "cancelled")?.kind).toBe("sync-event");
    expect(buildSyncMessage("K", "draft")).toBeNull();
    expect(buildSyncMessage("K", "past")).toBeNull();
  });

  it("keys the message on the event (unique per eventKey) and mints a fresh idempotency key per build", () => {
    const a = buildSyncMessage("01ABC", "published")!;
    const b = buildSyncMessage("01ABC", "published")!;
    expect(a.kind).toBe("sync-event");
    expect(a.eventKey).toBe("01ABC");
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("enqueues with the 10 s debounce delay and the legacy backoff schedule", async () => {
    const sent: { m: QueueMessage; o?: { delaySeconds?: number } }[] = [];
    const env = {
      ...baseEnv,
      SYNC_EVENT_QUEUE: {
        send: async (m: QueueMessage, o?: { delaySeconds?: number }) => {
          sent.push({ m, o });
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
        },
      },
    };
    const msg = await enqueueEventSync(env, "01ABC", "published");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.m).toMatchObject(msg!);
    expect(sent[0]!.m.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]!.o?.delaySeconds).toBe(SYNC_EVENT.debounceSeconds);
    expect(SYNC_EVENT.debounceSeconds).toBe(10);
    expect([...SYNC_EVENT.backoffSeconds]).toEqual([10, 60, 300, 900, 3600]);
    expect(backoffFor(SYNC_EVENT.backoffSeconds, 9)).toBe(3600);
  });

  it("never throws when the queue rejects or is unbound", async () => {
    const failing = {
      ...baseEnv,
      SYNC_EVENT_QUEUE: {
        send: async () => {
          throw new Error("down");
        },
      },
    };
    await expect(enqueueEventSync(failing, "K", "published")).resolves.toBeTruthy();
    await expect(enqueueEventSync(baseEnv, "K", "cancelled")).resolves.toBeTruthy();
    await expect(enqueueEventSync(baseEnv, "K", "draft")).resolves.toBeNull();
  });
});

async function cookieFor(
  store: SessionStore,
  row: { userId: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.userId,
    avatar: null,
    member: true,
    moderator: row.moderator,
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
}

describe.each(["/events.json", "/events/01ARZ3NDEKTSV4RRFFQ69G5FAV"])(
  "guest event JSON access: %s",
  (path) => {
    it.each([
      "text/html",
      "TEXT/HTML",
      "text/html;q=1",
      "text/html;q=0.001",
      "text/html;q=0.5, */*;q=1",
      "text/html;charset=utf-8; q=0.8",
      "text/html;q = 0.8",
      "text/html, application/jsonfoo",
    ])(
      "redirects a %s browser before reading the DB, with a guarded request-path next",
      async (accept) => {
        const target = `${path}?page=2&next=https%3A%2F%2Fevil.test`;
        const res = await app.request(target, { headers: { accept } }, baseEnv);
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location")!, APP_URL);
        expect(location.pathname).toBe("/join/discord");
        expect(location.searchParams.get("next")).toBe(target);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
      },
    );

    it.each([
      "",
      "application/json",
      "*/*",
      "application/json, text/html",
      "text/html;q=0, */*;q=1",
      "text/html;q=0.000",
      "text/htmlfoo",
      "text/htmlfoo;q=1",
      "text/html;q=bad",
      "text/html;q=1.1",
      "text/html;q=-1",
      "text/html;q=0.0001",
      "text/html;q=0;q=1",
      "text/html;q=1=0",
      "text/html;q=0.8, application/json;q=0.9",
      "text/html, application/json;q=0",
    ])("keeps a %s guest at 401 JSON", async (accept) => {
      const res = await app.request(path, { headers: { accept } }, baseEnv);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toContain("Accept");
    });

    it("keeps a guest without Accept at 401 JSON before reading the DB", async () => {
      const res = await app.request(path, {}, baseEnv);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL)("events routes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  // Routes only enqueue the sync-event variant; narrowing keeps idempotencyKey
  // readable now the alert-probe variant (no idempotency key) exists.
  const sent: Extract<QueueMessage, { kind: "sync-event" }>[] = [];
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    SYNC_EVENT_QUEUE: {
      send: async (m: Extract<QueueMessage, { kind: "sync-event" }>) => void sent.push(m),
    },
  } as unknown as Env;
  // Sessions rotate on every authenticated view (a replayed cookie is a guest), so each
  // request mints a fresh cookie.
  const MOD = "mod" as const;
  const MEMBER = "member" as const;
  const fresh = (who: typeof MOD | typeof MEMBER) =>
    cookieFor(store, {
      userId: who === MOD ? "100000000000000111" : "100000000000000112",
      moderator: who === MOD,
    });

  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, init, { ...env, ADMIN_DB: db });
  const as = async (who: typeof MOD | typeof MEMBER, extra: Record<string, string> = {}) => ({
    headers: { cookie: await fresh(who), ...extra },
  });
  const write = async (
    method: string,
    path: string,
    who: typeof MOD | typeof MEMBER,
    body?: unknown,
  ) =>
    req(path, {
      method,
      headers: { cookie: await fresh(who), origin: APP_URL, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const payload = {
    title: "Game night",
    game: "Chess",
    starts_at: "2099-11-04 20:00",
    ends_at: "2099-11-04 22:00",
    timezone: "Europe/London",
    location: "Voice",
    capacity: 8,
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    sent.length = 0;
  });

  it("CRUD + publish/cancel round-trip with write-back enqueued and ULID route keys", async () => {
    expect((await write("POST", "/events", MEMBER, payload)).status).toBe(403);
    expect(
      (await req("/events", { method: "POST", headers: { origin: APP_URL }, body: "{}" })).status,
    ).toBe(401);

    const created = await write("POST", "/events", MOD, payload);
    expect(created.status).toBe(201);
    const key = ((await created.json()) as { data: { event_key: string; status: string } }).data;
    expect(key.event_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(key.status).toBe("draft");
    expect(sent).toHaveLength(0); // drafts never sync

    // draft: 403 for a member, 200 for a moderator
    expect((await req(`/e/${key.event_key}`, await as(MEMBER))).status).toBe(403);
    expect((await req(`/e/${key.event_key}`, await as(MOD))).status).toBe(200);

    const patched = await write("PATCH", `/events/${key.event_key}`, MOD, { title: "Renamed" });
    expect(patched.status).toBe(200);
    const pj = ((await patched.json()) as { data: { title: string; starts_at: string } }).data;
    expect(pj.title).toBe("Renamed");
    expect(pj.starts_at).toBe("2099-11-04T20:00:00.000Z");
    expect(sent).toHaveLength(0);

    const pub = await write("POST", `/events/${key.event_key}/publish`, MOD);
    expect(pub.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventKey: key.event_key, kind: "sync-event" });
    expect(sent[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    const page = await req(`/e/${key.event_key}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Renamed");
    const list = await req("/events");
    expect(await list.text()).toContain(key.event_key);
    expect(await (await req("/sitemap_index.xml")).text()).toContain(`/e/${key.event_key}`);

    // /events.json needs a session and carries going_count
    expect((await req("/events.json")).status).toBe(401);
    const j = await req("/events.json", await as(MEMBER));
    expect(j.status).toBe(200);
    const rows = ((await j.json()) as { data: { event_key: string; going_count: number }[] }).data;
    expect(rows[0]).toMatchObject({ event_key: key.event_key, going_count: 0 });
    const etag = j.headers.get("etag")!;
    expect((await req("/events.json", await as(MEMBER, { "if-none-match": etag }))).status).toBe(
      304,
    );

    const cancel = await write("POST", `/events/${key.event_key}/cancel`, MOD);
    expect(cancel.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "sync-event", eventKey: key.event_key });
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);

    const gone = await req(`/e/${key.event_key}`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-robots-tag")).toContain("noindex");
    expect(await (await req("/sitemap_index.xml")).text()).not.toContain(key.event_key);
    // cancelled is terminal
    expect((await write("POST", `/events/${key.event_key}/publish`, MOD)).status).toBe(422);
  });

  const eventRow = (i: number, status = "published", day = 1) => ({
    eventKey: String(i).padStart(26, "0"),
    title: `Game ${i}`,
    status,
    startsAt: new Date(Date.UTC(2099, 0, day, 20)),
    endsAt: new Date(Date.UTC(2099, 0, day, 22)),
  });
  type JsonRow = {
    event_key: string;
    title: string;
    game: string | null;
    description: string | null;
    starts_at: string;
    ends_at: string;
    starts_at_local: string;
    ends_at_local: string;
    timezone: string;
    location: string | null;
    capacity: number | null;
    going_count: number;
    status: string;
    rsvp_open: boolean;
    synced_to_discord: boolean;
    waitlist_position: number | null;
  };
  type Collection = {
    data: JsonRow[];
    page: number;
    limit: number;
    meta: { current_page: number; per_page: number; total: number; last_page: number };
  };
  const collection = async (query = "", who: typeof MOD | typeof MEMBER = MEMBER) => {
    const res = await req(`/events.json${query}`, await as(who));
    expect(res.status).toBe(200);
    return (await res.json()) as Collection;
  };

  it("pages earliest-first without repeats/skips, with an ID tiebreak and role-scoped totals", async () => {
    // Insert later rows first; six tied starts straddle two page boundaries.
    const seeded = await db
      .insert(events)
      .values([
        eventRow(1, "published", 3),
        ...Array.from({ length: 6 }, (_, i) => eventRow(i + 2, "published", 2)),
        eventRow(8, "past", 1),
        eventRow(9, "cancelled", 4),
        eventRow(10, "draft", 1),
      ])
      .returning();
    const expected = [seeded[7]!, ...seeded.slice(1, 7), seeded[0]!, seeded[8]!].map(
      (row) => row.eventKey,
    );
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await collection(`?per_page=3&page=${page}`);
      expect(result.meta).toEqual({ current_page: page, per_page: 3, total: 9, last_page: 3 });
      expect(result.page).toBe(page);
      expect(result.limit).toBe(3);
      seen.push(...result.data.map((row) => row.event_key));
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(9);
    const mod = await collection("?per_page=100", MOD);
    expect(mod.meta.total).toBe(10);
    expect([...new Set(mod.data.map((row) => row.status))].sort()).toEqual([
      "cancelled",
      "draft",
      "past",
      "published",
    ]);
    const outside = await collection("?per_page=3&page=4");
    expect(outside.data).toEqual([]);
    expect(outside.meta).toEqual({ current_page: 4, per_page: 3, total: 9, last_page: 3 });
  });

  it("defaults to 20, clamps per_page to 100, preserves limit alias and gives per_page precedence", async () => {
    await db.insert(events).values(Array.from({ length: 105 }, (_, i) => eventRow(i + 1)));
    const defaultPage = await collection();
    expect(defaultPage.data).toHaveLength(20);
    expect(defaultPage.meta).toEqual({ current_page: 1, per_page: 20, total: 105, last_page: 6 });
    const clamped = await collection("?per_page=500");
    expect(clamped.data).toHaveLength(100);
    expect(clamped.limit).toBe(100);
    expect(clamped.meta).toEqual({ current_page: 1, per_page: 100, total: 105, last_page: 2 });
    expect((await collection("?per_page=500&page=2")).data).toHaveLength(5);
    expect(await collection("?limit=3&page=2")).toEqual(await collection("?per_page=3&page=2"));
    expect((await collection("?per_page=3&limit=100")).limit).toBe(3);
    expect((await collection("?per_page=0&page=-2")).meta).toMatchObject({
      per_page: 1,
      current_page: 1,
    });
    expect((await collection("?per_page=-3")).limit).toBe(1);
    expect((await collection("?per_page=bad&limit=3")).limit).toBe(20);
  });

  it.each(["per_page", "limit"])(
    "defaults malformed %s sizes to 20 without accepting a numeric prefix",
    async (parameter) => {
      await db.insert(events).values(Array.from({ length: 25 }, (_, i) => eventRow(i + 1)));
      for (const value of ["3garbage", "1e3", "3.5", "0x10", "Infinity", "NaN", "", "3 4", "3\n"]) {
        const query = `?${parameter}=${encodeURIComponent(value)}${parameter === "per_page" ? "&limit=3" : ""}`;
        const result = await collection(query);
        expect(result.limit, value).toBe(20);
        expect(result.data, value).toHaveLength(20);
        expect(result.meta, value).toEqual({
          current_page: 1,
          per_page: 20,
          total: 25,
          last_page: 2,
        });
      }
    },
  );

  it.each(["per_page", "limit"])(
    "clamps complete signed integer %s sizes at both boundaries",
    async (parameter) => {
      for (const [value, expected] of [
        ["+3", 3],
        ["003", 3],
        ["-0", 1],
        ["1", 1],
        ["100", 100],
        ["101", 100],
        ["-1", 1],
        ["9".repeat(400), 100],
        [`-${"9".repeat(400)}`, 1],
      ] as const) {
        const result = await collection(`?${parameter}=${encodeURIComponent(value)}`);
        expect(result.limit, value).toBe(expected);
        expect(result.meta.per_page, value).toBe(expected);
      }
    },
  );

  it("returns an empty paginator with last_page one", async () => {
    expect(await collection()).toEqual({
      data: [],
      page: 1,
      limit: 20,
      meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
    });
  });

  it("draft JSON show enforces policy before ETag, keeps noindex on 304 and does not rotate cookies", async () => {
    const [draft] = await db.insert(events).values(eventRow(1, "draft")).returning();
    const path = `/events/${draft!.eventKey}`;
    const moderatorHeaders = await as(MOD);
    const preview = await req(path, moderatorHeaders);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(preview.headers.get("cache-control")).toBe("private, no-cache");
    expect(preview.headers.get("set-cookie")).toBeNull();
    const etag = preview.headers.get("etag")!;
    const unchanged = await req(path, {
      headers: { ...moderatorHeaders.headers, "if-none-match": etag },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await req(path, await as(MEMBER, { "if-none-match": etag }))).status).toBe(403);
    expect(
      (await req(path, { headers: { accept: "application/json", "if-none-match": etag } })).status,
    ).toBe(401);
  });

  it("cancelled JSON show returns the exact legacy Gone body for either role", async () => {
    const [cancelled] = await db.insert(events).values(eventRow(1, "cancelled")).returning();
    for (const who of [MEMBER, MOD] as const) {
      const res = await req(`/events/${cancelled!.eventKey}`, await as(who));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({
        reason: "event_cancelled",
        message: "This event was cancelled.",
        event_key: cancelled!.eventKey,
        status: "cancelled",
      });
    }
  });

  it("show and list preserve the row keys/types, count only going and isolate the viewer's FIFO position", async () => {
    const [event] = await db
      .insert(events)
      .values({
        ...eventRow(1),
        game: "Chess",
        description: "Bring a board.",
        location: "Voice",
        timezone: "Europe/London",
        capacity: 2,
        rsvpOpen: false,
      })
      .returning();
    await db.insert(rsvps).values([
      { eventId: event!.id, userId: "going-a", status: "going" },
      { eventId: event!.id, userId: "going-b", status: "going" },
      { eventId: event!.id, userId: "maybe", status: "maybe" },
      { eventId: event!.id, userId: "not-going", status: "not_going" },
      {
        eventId: event!.id,
        userId: "first",
        status: "waitlisted",
        createdAt: new Date("2026-01-01"),
      },
      {
        eventId: event!.id,
        userId: "100000000000000112",
        status: "waitlisted",
        createdAt: new Date("2026-01-02"),
      },
    ]);
    const path = `/events/${event!.eventKey}`;
    const res = await req(path, await as(MEMBER));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: JsonRow };
    expect(Object.keys(data)).toEqual([
      "event_key",
      "title",
      "game",
      "description",
      "starts_at",
      "ends_at",
      "starts_at_local",
      "ends_at_local",
      "timezone",
      "location",
      "capacity",
      "going_count",
      "status",
      "rsvp_open",
      "synced_to_discord",
      "waitlist_position",
    ]);
    expect(data).toEqual({
      event_key: event!.eventKey,
      title: "Game 1",
      game: "Chess",
      description: "Bring a board.",
      starts_at: "2099-01-01T20:00:00.000Z",
      ends_at: "2099-01-01T22:00:00.000Z",
      starts_at_local: "2099-01-01 20:00",
      ends_at_local: "2099-01-01 22:00",
      timezone: "Europe/London",
      location: "Voice",
      capacity: 2,
      going_count: 2,
      status: "published",
      rsvp_open: false,
      synced_to_discord: false,
      waitlist_position: 2,
    });
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect((await collection()).data).toEqual([data]);
    const etag = res.headers.get("etag")!;
    const mod = await req(path, await as(MOD, { "if-none-match": etag }));
    expect(mod.status).toBe(200);
    expect(((await mod.json()) as { data: JsonRow }).data.waitlist_position).toBeNull();
    expect(mod.headers.get("etag")).not.toBe(etag);
    expect(res.headers.get("vary")).toContain("Cookie");
  });

  it.each(["published", "past"])(
    "show keeps nullable fields and zero counts for %s",
    async (status) => {
      const [event] = await db.insert(events).values(eventRow(1, status)).returning();
      const res = await req(`/events/${event!.eventKey}`, await as(MEMBER));
      expect(res.status).toBe(200);
      const data = ((await res.json()) as { data: JsonRow }).data;
      expect(data).toMatchObject({
        game: null,
        description: null,
        location: null,
        capacity: null,
        status,
        going_count: 0,
        waitlist_position: null,
        rsvp_open: true,
      });
      expect(data).not.toHaveProperty("id");
    },
  );

  it("collection ETag changes with totals, role, page, going counts and viewer position", async () => {
    const seeded = await db
      .insert(events)
      .values([eventRow(1), eventRow(2), eventRow(3, "draft")])
      .returning();
    const path = "/events.json?per_page=1";
    const original = await req(path, await as(MEMBER));
    const etag = original.headers.get("etag")!;
    expect((await req(path, await as(MEMBER, { "if-none-match": etag }))).status).toBe(304);
    expect((await req(path, await as(MOD, { "if-none-match": etag }))).status).toBe(200);
    expect((await req(`${path}&page=2`, await as(MEMBER, { "if-none-match": etag }))).status).toBe(
      200,
    );
    await db.insert(events).values(eventRow(4, "published", 5));
    expect((await req(path, await as(MEMBER, { "if-none-match": etag }))).status).toBe(200);
    const current = (await req(path, await as(MEMBER))).headers.get("etag")!;
    await db.insert(rsvps).values({ eventId: seeded[0]!.id, userId: "going", status: "going" });
    expect((await req(path, await as(MEMBER, { "if-none-match": current }))).status).toBe(200);
    const counted = (await req(path, await as(MEMBER))).headers.get("etag")!;
    await db
      .insert(rsvps)
      .values({ eventId: seeded[0]!.id, userId: "100000000000000112", status: "waitlisted" });
    expect((await req(path, await as(MEMBER, { "if-none-match": counted }))).status).toBe(200);
  });

  it("JSON show distinguishes malformed/missing keys and does not shadow archive or ICS", async () => {
    for (const key of ["bad-key", String(1).padStart(26, "0")]) {
      const res = await req(`/events/${key}`, await as(MEMBER));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    const [event] = await db.insert(events).values(eventRow(1)).returning();
    const archive = await req("/events/past");
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toContain("text/html");
    const ics = await req(`/events/${event!.eventKey}.ics`);
    expect(ics.status).toBe(200);
    expect(ics.headers.get("content-type")).toContain("text/calendar");
  });

  it("validates input and refuses forged origins", async () => {
    const bad = await write("POST", "/events", MOD, { title: "" });
    expect(bad.status).toBe(422);
    const forged = await req("/events", {
      method: "POST",
      headers: { cookie: await fresh(MOD), origin: "https://evil.test" },
      body: "{}",
    });
    expect(forged.status).toBe(403);
    expect((await req("/e/not-a-ulid")).status).toBe(404);
  });

  it("filters keyed JSON reads before pagination without changing draft visibility", async () => {
    const key = String(26).padStart(26, "0");
    const draftKey = String(99).padStart(26, "0");
    await db.insert(events).values(
      Array.from({ length: 26 }, (_, i) => ({
        eventKey: String(i + 1).padStart(26, "0"),
        title: `Game ${i + 1}`,
        status: "published",
        startsAt: new Date(Date.UTC(2099, 0, i + 1)),
        endsAt: new Date(Date.UTC(2099, 0, i + 1, 1)),
      })),
    );
    await db.insert(events).values({
      eventKey: draftKey,
      title: "Draft game",
      status: "draft",
      startsAt: new Date("2099-02-01T00:00:00Z"),
      endsAt: new Date("2099-02-01T01:00:00Z"),
    });
    const first = await req("/events.json", await as(MEMBER));
    const firstRows = ((await first.json()) as { data: { event_key: string }[] }).data;
    expect(firstRows).toHaveLength(20);
    expect(firstRows.some((row) => row.event_key === key)).toBe(false);
    const selected = await req(`/events.json?event_key=${key}`, await as(MEMBER));
    expect(selected.status).toBe(200);
    const selectedBody = (await selected.json()) as Collection;
    expect(selectedBody.data).toHaveLength(1);
    expect(selectedBody.data[0]).toMatchObject({ event_key: key, going_count: 0 });
    expect(selectedBody.meta).toEqual({ current_page: 1, per_page: 20, total: 1, last_page: 1 });
    const hidden = await collection(`?event_key=${draftKey}`);
    expect(hidden.data).toEqual([]);
    expect(hidden.meta.total).toBe(0);
    const shown = await collection(`?event_key=${draftKey}`, MOD);
    expect(shown.data[0]?.event_key).toBe(draftKey);
    expect(shown.meta.total).toBe(1);
    const second = await collection(`?event_key=${key}&per_page=1&page=2`);
    expect(second.data).toEqual([]);
    expect(second.meta).toEqual({ current_page: 2, per_page: 1, total: 1, last_page: 1 });
    const missing = await collection(`?event_key=${String(98).padStart(26, "0")}`);
    expect(missing.data).toEqual([]);
    expect(missing.meta.total).toBe(0);
    expect((await req("/events.json?event_key=not-a-key", await as(MEMBER))).status).toBe(422);
    expect((await req(`/events.json?event_key=${key}`)).status).toBe(401);
  });

  it("past archive pages twenty newest-first eligible rows with a stable tie-break and correct page count", async () => {
    await db.insert(events).values(
      Array.from({ length: 25 }, (_, i) => ({
        eventKey: `archive-${i + 1}`,
        title: `Past game ${i + 1}`,
        status: i < 23 ? "past" : "published",
        startsAt: new Date(Date.UTC(2020, 0, Math.min(i + 1, 24))),
        endsAt: new Date(Date.UTC(2020, 0, Math.min(i + 1, 24), 1)),
      })),
    );
    await db.insert(events).values(
      ["draft", "cancelled", "published"].map((status) => ({
        eventKey: `excluded-${status}`,
        title: "Not in the archive",
        status,
        startsAt: new Date("2099-01-01T00:00:00Z"),
        endsAt: new Date("2099-01-01T01:00:00Z"),
      })),
    );
    const keys = (html: string) => [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
    const first = await req("/events/past");
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(keys(html)).toEqual(Array.from({ length: 20 }, (_, i) => `archive-${25 - i}`));
    expect(html).toContain('data-total-pages="2"');
    expect(html).not.toContain("excluded-");
    expect(html).not.toMatch(/data-island="rsvp-button"|<button|<form/);
    const second = await (await req("/events/past?page=2")).text();
    expect(keys(second)).toEqual(["archive-5", "archive-4", "archive-3", "archive-2", "archive-1"]);
    expect(second).not.toContain(">Older</a>");
    const outside = await (await req("/events/past?page=3")).text();
    expect(keys(outside)).toEqual([]);
    expect(outside).toContain('role="status" data-testid="past-events-out-of-range"');
    expect(outside).toContain("There are 2 pages.");
  });
});
