// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: GET /events.json
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
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import type { Env } from "../src/env";
import { buildSyncMessage, enqueueEventSync } from "../src/events/sync";
import { SYNC_EVENT, backoffFor } from "../src/jobs/constants";
import type { QueueMessage } from "../src/jobs/types";

// Carrier integration (real ledger/unique lock) lives in event-writeback.test.ts.
// This suite covers message construction and public route behavior in isolation.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send({ ...message, jobId: crypto.randomUUID() }, { delaySeconds: 10 });
    return true;
  },
}));
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";

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
    const env = { ...baseEnv, SYNC_EVENT_QUEUE: { send: async (m: QueueMessage, o?: { delaySeconds?: number }) => { sent.push({ m, o }); return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }; } } };
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
    const failing = { ...baseEnv, SYNC_EVENT_QUEUE: { send: async () => { throw new Error("down"); } } };
    await expect(enqueueEventSync(failing, "K", "published")).resolves.toBeTruthy();
    await expect(enqueueEventSync(baseEnv, "K", "cancelled")).resolves.toBeTruthy();
    await expect(enqueueEventSync(baseEnv, "K", "draft")).resolves.toBeNull();
  });
});

async function cookieFor(store: SessionStore, row: { userId: string; moderator: boolean }): Promise<string> {
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
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)("events routes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  beforeAll(async () => {
    // Replay every canonical migration into a guarded, owned schema (never public).
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => { await fixture?.dispose(); });
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  const env = {
    ...baseEnv,
    get ADMIN_DB() { return db; },
    SESSION_STORE: store,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
  } as unknown as Env;
  // Sessions rotate on every authenticated view (a replayed cookie is a guest), so each
  // request mints a fresh cookie.
  const MOD = "mod" as const;
  const MEMBER = "member" as const;
  const fresh = (who: typeof MOD | typeof MEMBER) => cookieFor(store, { userId: who === MOD ? "100000000000000111" : "100000000000000112", moderator: who === MOD });

  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const as = async (who: typeof MOD | typeof MEMBER, extra: Record<string, string> = {}) => ({ headers: { cookie: await fresh(who), ...extra } });
  const write = async (method: string, path: string, who: typeof MOD | typeof MEMBER, body?: unknown) =>
    req(path, {
      method,
      headers: { cookie: await fresh(who), origin: APP_URL, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const payload = { title: "Game night", game: "Chess", starts_at: "2099-11-04 20:00", ends_at: "2099-11-04 22:00", timezone: "Europe/London", location: "Voice", capacity: 8 };

  beforeEach(async () => {
    await db.delete(rsvps);
    await db.delete(activityLog);
    await db.delete(events);
    sent.length = 0;
  });

  it("CRUD + publish/cancel round-trip with write-back enqueued and ULID route keys", async () => {
    expect((await write("POST", "/events", MEMBER, payload)).status).toBe(403);
    expect((await req("/events", { method: "POST", headers: { origin: APP_URL }, body: "{}" })).status).toBe(401);

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
    expect((await req("/events.json", await as(MEMBER, { "if-none-match": etag }))).status).toBe(304);

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

  it("validates input and refuses forged origins", async () => {
    const bad = await write("POST", "/events", MOD, { title: "" });
    expect(bad.status).toBe(422);
    const forged = await req("/events", { method: "POST", headers: { cookie: await fresh(MOD), origin: "https://evil.test" }, body: "{}" });
    expect(forged.status).toBe(403);
    expect((await req("/e/not-a-ulid")).status).toBe(404);
  });

  it("filters keyed JSON reads before pagination without changing draft visibility", async () => {
    const key = String(1).padStart(26, "0");
    const draftKey = String(99).padStart(26, "0");
    await db.insert(events).values(Array.from({ length: 26 }, (_, i) => ({
      eventKey: String(i + 1).padStart(26, "0"), title: `Game ${i + 1}`, status: "published",
      startsAt: new Date(Date.UTC(2099, 0, i + 1)), endsAt: new Date(Date.UTC(2099, 0, i + 1, 1)),
    })));
    await db.insert(events).values({ eventKey: draftKey, title: "Draft game", status: "draft",
      startsAt: new Date("2099-02-01T00:00:00Z"), endsAt: new Date("2099-02-01T01:00:00Z") });
    const first = await req("/events.json", await as(MEMBER));
    const firstRows = (await first.json() as { data: { event_key: string }[] }).data;
    expect(firstRows).toHaveLength(20);
    expect(firstRows.some((row) => row.event_key === key)).toBe(false);
    const selected = await req(`/events.json?event_key=${key}`, await as(MEMBER));
    expect(selected.status).toBe(200);
    const selectedRows = (await selected.json() as { data: { event_key: string; going_count: number }[] }).data;
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]).toMatchObject({ event_key: key, going_count: 0 });
    const hidden = await req(`/events.json?event_key=${draftKey}`, await as(MEMBER));
    expect((await hidden.json() as { data: unknown[] }).data).toEqual([]);
    const shown = await req(`/events.json?event_key=${draftKey}`, await as(MOD));
    expect((await shown.json() as { data: { event_key: string }[] }).data[0]?.event_key).toBe(draftKey);
    expect((await req(`/events.json?event_key=${key}`)).status).toBe(401);
  });

  it("past archive pages twenty newest-first eligible rows with a stable tie-break and correct page count", async () => {
    await db.insert(events).values(Array.from({ length: 25 }, (_, i) => ({
      eventKey: `archive-${i + 1}`, title: `Past game ${i + 1}`, status: i < 23 ? "past" : "published",
      startsAt: new Date(Date.UTC(2020, 0, Math.min(i + 1, 24))),
      endsAt: new Date(Date.UTC(2020, 0, Math.min(i + 1, 24), 1)),
    })));
    await db.insert(events).values(["draft", "cancelled", "published"].map((status) => ({
      eventKey: `excluded-${status}`, title: "Not in the archive", status,
      startsAt: new Date("2099-01-01T00:00:00Z"), endsAt: new Date("2099-01-01T01:00:00Z"),
    })));
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
