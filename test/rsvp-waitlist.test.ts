// WaitlistTest.php service/HTTP pins, plus real Postgres promotion races.
// Every driver is guarded and scoped to its own disposable schema.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { adminApp } from "../src/admin/routes";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { CAPACITY_BELOW_GOING, waitlistPosition } from "../src/events/waitlist";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
type JsonRow = { event_key: string; status: string; going_count: number; waitlist_position: number | null };
const answer = async (res: Response) => (await res.json() as { data: JsonRow }).data;
const collection = async (res: Response) => (await res.json() as { data: JsonRow[] }).data;

describe("waitlist test containment", () => {
  it("rejects production/staging URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow("refusing before connecting");
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("RSVP waitlist (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let client: MemberDataFixture["client"];
  const store = createMemorySessionStore();
  const sent: SyncMessage[] = [];
  const env = {
    APP_URL, SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730", DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_BOT_TOKEN: "bot-token", SESSION_STORE: store,
    get ADMIN_DB() { return db; },
    EVENT_SYNC_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) },
  } as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 20 });
    db = fixture.db;
    client = fixture.client;
  });
  beforeEach(async () => {
    await fixture.reset();
    await client`delete from web_throttle_hits`;
    sent.length = 0;
  });
  afterAll(async () => { await fixture?.dispose(); });

  async function cookieFor(userId: string, moderator = false): Promise<string> {
    const token = newSessionToken();
    await store.create({ tokenHash: await hashToken(token), userId, username: userId, avatar: null,
      member: true, moderator, expiresAt: new Date(Date.now() + 3600_000) });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET,
      { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  }
  async function request(path: string, userId: string | null, method = "GET", body?: unknown, moderator = false, extra: Record<string, string> = {}) {
    return app.request(path, { method, headers: { origin: APP_URL, "content-type": "application/json",
      ...(userId ? { cookie: await cookieFor(userId, moderator) } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  const put = (key: string, userId: string, status = "going") => request(`/events/${key}/rsvp`, userId, "PUT", { status });
  const withdraw = (key: string, userId: string) => request(`/events/${key}/rsvp`, userId, "DELETE");
  const patch = (key: string, capacity: number | null) => request(`/events/${key}`, "moderator", "PATCH", { capacity }, true);
  const rows = (eventId: number) => db.select().from(rsvps).where(eq(rsvps.eventId, eventId)).orderBy(rsvps.id);

  async function seed(over: Partial<typeof events.$inferInsert> = {}) {
    const [ev] = await db.insert(events).values({
      eventKey: `01W1${crypto.randomUUID().replace(/[^0-9a-f]/g, "").slice(0, 22).toUpperCase()}`,
      title: "Waitlist night", startsAt: new Date("2099-01-01T20:00:00Z"), endsAt: new Date("2099-01-01T22:00:00Z"),
      timezone: "UTC", status: "published", capacity: 1, ...over,
    }).returning();
    return ev!;
  }
  async function fullWithLine(count = 2) {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    for (let i = 1; i <= count; i++) await put(ev.eventKey, `waiter-${i}`);
    // Pin same-instant FIFO so ID, not wall time, breaks the tie.
    await client`update rsvps set created_at = '2020-01-01T00:00:00Z', synced_to_discord_at = now() where event_id = ${ev.id}`;
    sent.length = 0;
    return ev;
  }
  async function adminEdit(ev: typeof events.$inferSelect, capacity: number | null) {
    return adminApp({ sessionStore: store, db }).request(`/events/${ev.eventKey}`, {
      method: "POST", headers: { cookie: await cookieFor("moderator", true), origin: APP_URL },
      body: new URLSearchParams({ title: ev.title, timezone: "UTC", starts_at: "2099-01-01T20:00",
        ends_at: "2099-01-01T22:00", capacity: capacity === null ? "" : String(capacity) }),
    }, env);
  }

  it("full Going writes/re-answers are 201/200 waitlisted with position and no seat", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    for (const code of [201, 200]) {
      const res = await put(ev.eventKey, "waiter");
      expect(res.status).toBe(code);
      expect(await res.json()).toEqual({ data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 1 } });
    }
    const line = await rows(ev.id);
    expect(line.filter((r) => r.status === "going")).toHaveLength(1);
    expect(line.filter((r) => r.status === "waitlisted")).toHaveLength(1);
    expect(await waitlistPosition(db, ev.id, "holder")).toBeNull();
    expect(await waitlistPosition(db, ev.id, "absent")).toBeNull();
    const [hit] = await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:waiter'`;
    expect(hit!.n).toBe(2);
  });

  it("withdraw promotes the FIFO head in its commit, clears its mirror stamp and queues write-back", async () => {
    const ev = await fullWithLine();
    const before = await rows(ev.id);
    expect(await waitlistPosition(db, ev.id, "waiter-1")).toBe(1);
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(2);
    expect((await withdraw(ev.eventKey, "holder")).status).toBe(204);
    const after = await rows(ev.id);
    expect(after.map((r) => [r.userId, r.status])).toEqual([["waiter-1", "going"], ["waiter-2", "waitlisted"]]);
    expect(after[0]!.syncedToDiscordAt).toBeNull();
    expect(after[1]!.syncedToDiscordAt).toEqual(before[2]!.syncedToDiscordAt);
    expect(await waitlistPosition(db, ev.id, "waiter-1")).toBeNull();
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
    expect(sent.map((m) => [m.eventKey, m.action])).toEqual([[ev.eventKey, "event.upsert"]]);
    const [hit] = await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:waiter-1'`;
    expect(hit!.n).toBe(1); // Automatic promotion spends no member attempt.
  });

  it("leaving the line compacts positions without disturbing the holder", async () => {
    const ev = await fullWithLine();
    await withdraw(ev.eventKey, "waiter-1");
    expect((await rows(ev.id)).map((r) => [r.userId, r.status])).toEqual([["holder", "going"], ["waiter-2", "waitlisted"]]);
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
  });

  it.each(["maybe", "not_going", "waitlisted"])("Going → %s frees a seat to the existing head", async (status) => {
    const ev = await fullWithLine();
    const res = await put(ev.eventKey, "holder", status);
    expect(res.status).toBe(200);
    expect((await answer(res)).status).toBe(status);
    expect((await rows(ev.id)).find((r) => r.userId === "waiter-1")!.status).toBe("going");
    expect(await waitlistPosition(db, ev.id, "holder")).toBe(status === "waitlisted" ? 2 : null);
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
  });

  it("returns the settled Going answer when the former holder is the only waiter", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    const res = await put(ev.eventKey, "holder", "waitlisted");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: "going", synced_to_discord_at: null, waitlist_position: null } });
  });

  it("joining from an older Maybe answer recreates FIFO keys, but re-answering in line preserves them", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    await put(ev.eventKey, "older", "maybe");
    const original = (await rows(ev.id)).find((r) => r.userId === "older")!;
    await put(ev.eventKey, "head");
    await put(ev.eventKey, "older");
    const joined = (await rows(ev.id)).find((r) => r.userId === "older")!;
    expect(joined.id).toBeGreaterThan(original.id);
    expect(await waitlistPosition(db, ev.id, "head")).toBe(1);
    expect(await waitlistPosition(db, ev.id, "older")).toBe(2);
    await put(ev.eventKey, "older", "waitlisted");
    expect((await rows(ev.id)).find((r) => r.userId === "older")!.id).toBe(joined.id);
    expect(await waitlistPosition(db, ev.id, "older")).toBe(2);
  });

  it("uses exact created_at before ID, even for timestamps within one JS millisecond", async () => {
    const ev = await fullWithLine();
    await client`update rsvps set created_at = '2020-01-01T00:00:00.000002Z' where event_id = ${ev.id} and user_id = 'waiter-1'`;
    await client`update rsvps set created_at = '2020-01-01T00:00:00.000001Z' where event_id = ${ev.id} and user_id = 'waiter-2'`;
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
    await withdraw(ev.eventKey, "holder");
    expect((await rows(ev.id)).find((r) => r.userId === "waiter-2")!.status).toBe("going");
  });

  it.each(["json", "admin"])("%s capacity increase deals N heads; unlimited deals the rest", async (surface) => {
    const ev = await fullWithLine(3);
    const increase = surface === "json" ? await patch(ev.eventKey, 3) : await adminEdit(ev, 3);
    expect(increase.status).toBe(surface === "json" ? 200 : 303);
    if (surface === "json") expect((await answer(increase)).going_count).toBe(3);
    let line = await rows(ev.id);
    expect(line.map((r) => r.status)).toEqual(["going", "going", "going", "waitlisted"]);
    expect(line.slice(1, 3).every((r) => r.syncedToDiscordAt === null)).toBe(true);
    expect(line[3]!.syncedToDiscordAt).not.toBeNull();
    const unlimited = surface === "json" ? await patch(ev.eventKey, null) : await adminEdit(ev, null);
    expect(unlimited.status).toBe(surface === "json" ? 200 : 303);
    line = await rows(ev.id);
    expect(line.every((r) => r.status === "going")).toBe(true);
    expect(sent.map((m) => m.action)).toEqual(["event.upsert", "event.upsert"]);
  });

  it.each(["json", "admin"])("%s refuses a cap below Going with a field error and no mutation", async (surface) => {
    const ev = await seed({ capacity: 3 });
    await put(ev.eventKey, "a");
    await put(ev.eventKey, "b");
    await put(ev.eventKey, "maybe", "maybe");
    await put(ev.eventKey, "no", "not_going");
    await put(ev.eventKey, "line", "waitlisted");
    sent.length = 0;
    const res = surface === "json" ? await patch(ev.eventKey, 1) : await adminEdit(ev, 1);
    expect(res.status).toBe(422);
    if (surface === "json") expect(await res.json()).toEqual({ error: "invalid", fields: { capacity: CAPACITY_BELOW_GOING } });
    else expect(await res.text()).toContain(CAPACITY_BELOW_GOING);
    const [stored] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(stored!.capacity).toBe(3);
    expect(await rows(ev.id)).toHaveLength(5);
    expect(sent).toHaveLength(0);
    // Exactly the going count is legal; non-seat statuses do not inflate the floor.
    expect((surface === "json" ? await patch(ev.eventKey, 2) : await adminEdit(ev, 2)).status).toBe(surface === "json" ? 200 : 303);
  });

  it.each([true, [], {}, -1, 1.5, 2147483648])("invalid JSON capacity %j is a field error, never unlimited", async (capacity) => {
    const ev = await seed();
    const res = await request(`/events/${ev.eventKey}`, "moderator", "PATCH", { capacity }, true);
    expect(res.status).toBe(422);
    const [stored] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(stored!.capacity).toBe(1);
  });

  it("title-only JSON PATCH preserves a finite numeric capacity and keeps the line intact", async () => {
    const ev = await fullWithLine();
    const res = await request(`/events/${ev.eventKey}`, "moderator", "PATCH", { title: "Renamed night" }, true);
    expect(res.status).toBe(200);
    expect((await rows(ev.id)).map((r) => r.status)).toEqual(["going", "waitlisted", "waitlisted"]);
    const [stored] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(stored!.capacity).toBe(1);
  });

  it("a limited withdrawal changes neither the holder nor the line", async () => {
    const ev = await fullWithLine();
    await client`insert into web_throttle_hits (bucket, at) select 'rsvp-write:holder', clock_timestamp() from generate_series(1, 12)`;
    expect((await withdraw(ev.eventKey, "holder")).status).toBe(429);
    expect((await rows(ev.id)).map((r) => r.status)).toEqual(["going", "waitlisted", "waitlisted"]);
    expect(sent).toHaveLength(0);
  });

  it.each(["cancelled", "past", "draft", "ended", "paused"])("%s events leave the line frozen on withdraw and capacity edits", async (state) => {
    const ev = await fullWithLine();
    await db.update(events).set(state === "paused" ? { rsvpOpen: false }
      : state === "ended" ? { startsAt: new Date(0), endsAt: new Date(3600_000) } : { status: state }).where(eq(events.id, ev.id));
    expect((await put(ev.eventKey, "newcomer")).status).toBe(403);
    expect((await withdraw(ev.eventKey, "holder")).status).toBe(204);
    expect((await patch(ev.eventKey, 3)).status).toBe(200);
    expect((await rows(ev.id)).every((r) => r.status === "waitlisted" && r.syncedToDiscordAt !== null)).toBe(true);
  });

  it("exposes only the viewer's position to page/JSON, with private caching and position-sensitive ETags", async () => {
    const ev = await fullWithLine();
    const first = await request("/events.json", "waiter-1");
    const data = await collection(first);
    expect(data.find((e) => e.event_key === ev.eventKey)!.waitlist_position).toBe(1);
    const etag = first.headers.get("etag")!;
    const second = await request("/events.json", "waiter-2", "GET", undefined, false, { "if-none-match": etag });
    expect(second.status).toBe(200);
    expect((await collection(second))[0]!.waitlist_position).toBe(2);
    const page = await request(`/e/${ev.eventKey}`, "waiter-2");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("vary")).toBe("Cookie");
    expect(await page.text()).toContain('data-waitlist-position="2"');
    const guest = await request(`/e/${ev.eventKey}`, null);
    expect(guest.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await guest.text()).toContain('data-waitlist-position=""');
    await withdraw(ev.eventKey, "holder");
    const refresh = await request("/events.json", "waiter-2", "GET", undefined, false, { "if-none-match": second.headers.get("etag")! });
    expect(refresh.status).toBe(200);
    expect((await collection(refresh))[0]!.waitlist_position).toBe(1);
  });

  async function waiterBlockedBy(pid: number): Promise<number> {
    const deadline = Date.now() + 5000;
    do {
      const rows = await client`select pid from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and ${pid} = any(pg_blocking_pids(pid))`;
      if (rows[0]) return Number(rows[0].pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`No blocked waiter for backend ${pid}`);
  }

  it("concurrent withdraw + Going cannot steal the head's freed seat or over-allocate", async () => {
    const ev = await fullWithLine();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<number>((resolve) => { ready = resolve; });
    const holder = client.begin(async (tx) => {
      await tx`select id from rsvps where event_id = ${ev.id} and user_id = 'holder' for update`;
      const [backend] = await tx`select pg_backend_pid() as pid`;
      ready(Number(backend!.pid));
      await gate;
    });
    let leaving: Promise<Response> | undefined;
    let joining: Promise<Response> | undefined;
    try {
      const holderPid = await acquired;
      leaving = withdraw(ev.eventKey, "holder");
      // Withdraw owns the event lock while blocked on the holder's RSVP row.
      const withdrawingPid = await waiterBlockedBy(holderPid);
      joining = put(ev.eventKey, "newcomer");
      await waiterBlockedBy(withdrawingPid);
    } finally {
      release();
      await holder;
    }
    expect((await leaving!).status).toBe(204);
    const newcomer = await joining!;
    expect(newcomer.status).toBe(201);
    expect((await answer(newcomer)).status).toBe("waitlisted");
    const line = await rows(ev.id);
    expect(line.filter((r) => r.status === "going").map((r) => r.userId)).toEqual(["waiter-1"]);
    expect(await waitlistPosition(db, ev.id, "newcomer")).toBe(2);
  });
});
