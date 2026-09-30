// W9: RSVP PUT/DELETE, the shared 12/min budget, the one-429 shape and the FOR UPDATE races.
// Live against agent-testdb (skipped without DATABASE_URL, like test/events.test.ts). Never point
// this at anything but a test container.
import { serializeSigned } from "hono/utils/cookie";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import * as adminSchema from "../src/db/admin-schema";
import * as baseSchema from "../src/db/schema";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { RSVP_RATE_LIMIT } from "../src/islands/contracts";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

async function cookieFor(store: SessionStore, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)("rsvp routes (agent-testdb)", () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 20 });
  const db = drizzle(client, { schema: { ...baseSchema, ...adminSchema } });
  const store = createMemorySessionStore();
  const sent: SyncMessage[] = [];
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    ADMIN_DB: db,
    SESSION_STORE: store,
    EVENT_SYNC_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) },
  } as unknown as Env;

  // Sessions rotate on each authenticated view, so every request mints a fresh cookie.
  const call = async (method: string, key: string, as: string | null, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(
      `/events/${key}/rsvp`,
      {
        method,
        headers: {
          ...(as ? { cookie: await cookieFor(store, as) } : {}),
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/json",
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const put = (key: string, as: string | null, status: unknown = "going", extra: Record<string, unknown> = {}) => call("PUT", key, as, { status, ...extra });

  const HOUR = 3600_000;
  async function seed(over: Partial<typeof events.$inferInsert> = {}): Promise<{ id: number; key: string }> {
    const key = `01W9${Math.random().toString(36).slice(2, 14).toUpperCase().replace(/[ILOU]/g, "7")}`.padEnd(26, "0").slice(0, 26);
    const [row] = await db
      .insert(events)
      .values({ eventKey: key, title: "Race night", startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + 2 * HOUR), status: "published", ...over })
      .returning();
    return { id: row!.id, key };
  }
  const rows = (eventId: number) => db.select().from(rsvps).where(eq(rsvps.eventId, eventId));

  beforeEach(async () => {
    await client`delete from web_throttle_hits`;
    await db.delete(rsvps);
    await db.delete(events);
    sent.length = 0;
  });
  afterAll(async () => void (await client.end()));

  it("guest 401, foreign origin 403, bad status 422, other verbs 405, someone else's user_id 403", async () => {
    const ev = await seed();
    expect((await put(ev.key, null)).status).toBe(401);
    expect((await call("PUT", ev.key, "u1", { status: "going" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await put(ev.key, "u1", "attending")).status).toBe(422);
    expect((await call("PUT", ev.key, "u1", {})).status).toBe(422);
    for (const m of ["GET", "POST", "PATCH"]) expect((await call(m, ev.key, "u1")).status).toBe(405);
    expect((await put(ev.key, "u1", "going", { user_id: "u2" })).status).toBe(403);
    expect(await rows(ev.id)).toHaveLength(0);
  });

  it("201 first answer, 200 re-answer, 204 withdraw; the mirror stamp resets on every write", async () => {
    const ev = await seed();
    const first = await put(ev.key, "u1", "going");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ data: { status: "going", synced_to_discord_at: null } });
    await db.update(rsvps).set({ syncedToDiscordAt: new Date() });
    const again = await put(ev.key, "u1", "maybe");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ data: { status: "maybe", synced_to_discord_at: null } });
    expect(await rows(ev.id)).toHaveLength(1);
    expect((await call("DELETE", ev.key, "u1")).status).toBe(204);
    expect(await rows(ev.id)).toHaveLength(0);
    expect(sent.map((m) => m.action)).toEqual(["event.upsert", "event.upsert", "event.upsert"]);
  });

  it("withdraw is quiet without a row or an event, and never touches another member's row", async () => {
    const ev = await seed();
    expect((await call("DELETE", ev.key, "u1")).status).toBe(204);
    expect((await call("DELETE", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "u1")).status).toBe(204);
    expect((await call("DELETE", "not-a-key", "u1")).status).toBe(204);
    await put(ev.key, "victim", "going");
    expect((await call("DELETE", ev.key, "attacker")).status).toBe(204);
    expect((await rows(ev.id)).map((r) => r.userId)).toEqual(["victim"]);
  });

  it("draft, cancelled, ended and paused events refuse PUT with 403 and write nothing; withdraw from cancelled stays 204", async () => {
    const cases = {
      draft: await seed({ status: "draft" }),
      cancelled: await seed({ status: "cancelled" }),
      past: await seed({ status: "past", endsAt: new Date(Date.now() - HOUR), startsAt: new Date(Date.now() - 2 * HOUR) }),
      ended: await seed({ endsAt: new Date(Date.now() - HOUR), startsAt: new Date(Date.now() - 2 * HOUR) }),
      paused: await seed({ rsvpOpen: false }),
    };
    for (const [name, ev] of Object.entries(cases)) {
      const r = await put(ev.key, "u1");
      expect(r.status, name).toBe(403);
      expect(await rows(ev.id), name).toHaveLength(0);
    }
    expect((await put("01ARZ3NDEKTSV4RRFFQ69G5FAV", "u1")).status).toBe(404);
    expect((await call("DELETE", cases.cancelled.key, "u1")).status).toBe(204);
    // Refused writes did not spend the budget.
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:u1'`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("honeypot: a filled decoy answers the byte-identical 201 and touches no limiter, auth or table", async () => {
    const ev = await seed();
    const real = await (await put(ev.key, "u1", "going")).text();
    await db.delete(rsvps);
    await client`delete from web_throttle_hits`;
    const decoy = await put(ev.key, null, "going", { website: "http://spam.test" });
    expect(decoy.status).toBe(201);
    expect(await decoy.text()).toBe(real);
    expect(await rows(ev.id)).toHaveLength(0);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits`) as unknown as [{ n: number }];
    expect(n).toBe(0);
    expect((await app.request(`/events/${ev.key}/rsvp?website=x`, { method: "DELETE" }, env)).status).toBe(204);
  });

  it("the 13th write inside a minute is the one 429 shape with Retry-After, for either verb", async () => {
    const ev = await seed();
    for (let i = 0; i < RSVP_RATE_LIMIT.maxAttempts; i++) expect((await put(ev.key, "u1", i % 2 ? "maybe" : "going")).status).toBeLessThan(300);
    const limited = await put(ev.key, "u1");
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await limited.json()).toEqual({ reason: "rate_limited", message: `Too many requests. Try again in ${retry} seconds.`, retry_after: retry });
    expect((await call("DELETE", ev.key, "u1")).status).toBe(429);
    // The budget is per member: someone else is unaffected.
    expect((await put(ev.key, "u2")).status).toBe(201);
  });

  it("switching verb or event does not multiply the budget", async () => {
    const a = await seed();
    const b = await seed();
    for (let i = 0; i < 4; i++) {
      expect((await put(a.key, "u1")).status).toBeLessThan(300);
      expect((await put(b.key, "u1")).status).toBeLessThan(300);
      expect((await call("DELETE", a.key, "u1")).status).toBe(204);
    }
    // 12 spent across two events and both verbs.
    expect((await call("DELETE", b.key, "u1")).status).toBe(429);
    expect((await put(a.key, "u1")).status).toBe(429);
  });

  it("hammering: 40 concurrent writes by one member let exactly 12 through", async () => {
    const ev = await seed();
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 3 ? put(ev.key, "u1") : call("DELETE", ev.key, "u1"))));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 429)).toHaveLength(40 - RSVP_RATE_LIMIT.maxAttempts);
    expect(codes.filter((c) => c !== 429)).toHaveLength(RSVP_RATE_LIMIT.maxAttempts);
    expect((await rows(ev.id)).length).toBeLessThanOrEqual(1);
  });

  it("capacity race: 14 members chase 3 seats, exactly 3 win and the rest get the 409 shape", async () => {
    const ev = await seed({ capacity: 3 });
    const res = await Promise.all(Array.from({ length: 14 }, (_, i) => put(ev.key, `racer-${i}`, "going")));
    const codes = res.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(11);
    const loser = res.find((r) => r.status === 409)!;
    expect(await loser.json()).toEqual({ reason: "event_at_capacity", message: "This event is full.", event_key: ev.key, capacity: 3 });
    expect((await rows(ev.id)).filter((r) => r.status === "going")).toHaveLength(3);
  });

  it("a member already going can re-say going or downgrade when full; a withdrawn seat is takeable", async () => {
    const ev = await seed({ capacity: 1 });
    expect((await put(ev.key, "u1", "going")).status).toBe(201);
    expect((await put(ev.key, "u1", "going")).status).toBe(200);
    expect((await put(ev.key, "u2", "going")).status).toBe(409);
    expect((await put(ev.key, "u2", "maybe")).status).toBe(201);
    expect((await call("DELETE", ev.key, "u1")).status).toBe(204);
    expect((await put(ev.key, "u2", "going")).status).toBe(200);
  });

  it("one member double-submitting concurrently ends with one row and codes from {201, 200}", async () => {
    const ev = await seed();
    const res = await Promise.all(Array.from({ length: 6 }, () => put(ev.key, "u1", "going")));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(await rows(ev.id)).toHaveLength(1);
  });

  it("a cancel racing the last seat never leaves a going row behind a refused 201", async () => {
    const ev = await seed({ capacity: 5 });
    const cancel = client`update events set status = 'cancelled' where id = ${ev.id}`;
    const res = await Promise.all([cancel, ...Array.from({ length: 8 }, (_, i) => put(ev.key, `c-${i}`, "going"))]);
    const writes = res.slice(1) as Response[];
    const ok = writes.filter((r) => r.status === 201).length;
    expect((await rows(ev.id)).length).toBe(ok);
    for (const r of writes) expect([201, 403]).toContain(r.status);
  });
  it("one cookie used by concurrent writes authenticates every request (no destructive rotation)", async () => {
    const ev = await seed();
    const cookie = await cookieFor(store, "same-cookie");
    const go = () =>
      app.request(
        `/events/${ev.key}/rsvp`,
        { method: "PUT", headers: { cookie, origin: APP_URL, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ status: "going" }) },
        env,
      );
    const codes = (await Promise.all([go(), go(), go()])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 200, 201]);
  });

  it("refused writes (event full) spend no budget: a waitlist answer still goes through after 12 refusals", async () => {
    const ev = await seed({ capacity: 1 });
    expect((await put(ev.key, "holder", "going")).status).toBe(201);
    for (let i = 0; i < RSVP_RATE_LIMIT.maxAttempts; i++) expect((await put(ev.key, "u-full", "going")).status).toBe(409);
    expect((await put(ev.key, "u-full", "waitlisted")).status).toBe(201);
  });

  it("expiry is judged after the row lock: an answer queued behind a lock holder is refused once the event ends", async () => {
    const ev = await seed({ endsAt: new Date(Date.now() + 1500) });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select id from events where id = ${ev.id} for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, "late", "going");
    await new Promise((r) => setTimeout(r, 1800));
    release();
    await holder;
    expect((await pending).status).toBe(403);
    expect(await rows(ev.id)).toHaveLength(0);
  });
  it("expiry is also judged after the member lock wait", async () => {
    const ev = await seed({ endsAt: new Date(Date.now() + 1500) });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('rsvp-write:late2'))`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, "late2", "going");
    await new Promise((r) => setTimeout(r, 1800));
    release();
    await holder;
    expect((await pending).status).toBe(403);
    expect(await rows(ev.id)).toHaveLength(0);
  });

  it("the budget hit is stamped after the lock wait, not at transaction start", async () => {
    const ev = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select id from events where id = ${ev.id} for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, "stamp", "going");
    await new Promise((r) => setTimeout(r, 1500));
    const [tr] = await client`select clock_timestamp() as t`;
    const t = tr!.t;
    release();
    await holder;
    expect((await pending).status).toBe(201);
    const [hit] = await client`select at from web_throttle_hits where bucket = 'rsvp-write:stamp'`;
    expect(new Date(hit!.at).getTime()).toBeGreaterThanOrEqual(new Date(t).getTime());
  });
  it("withdrawals queued behind the event lock charge after it: 12 DELETEs + 12 PUTs let exactly 12 through", async () => {
    const ev = await seed();
    const other = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select id from events where id = ${ev.id} for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const dels = Array.from({ length: 12 }, () => call("DELETE", ev.key, "dq"));
    await new Promise((r) => setTimeout(r, 300));
    const puts = Array.from({ length: 12 }, () => put(other.key, "dq"));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const codes = (await Promise.all([...dels, ...puts])).map((r) => r.status);
    expect(codes.filter((c) => c === 429)).toHaveLength(12);
    const [nr] = await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:dq'`;
    const n = nr!.n;
    expect(n).toBe(12);
  });
  it("the budget hit waits for the RSVP row lock (DELETE and PUT on an existing answer)", async () => {
    for (const verb of ["DELETE", "PUT"] as const) {
      const ev = await seed();
      const who = `rowlock-${verb}`;
      expect((await put(ev.key, who, "going")).status).toBe(201);
      await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const holder = client.begin(async (tx) => {
        await tx`select id from rsvps where event_id = ${ev.id} and user_id = ${who} for update`;
        await held;
      });
      await new Promise((r) => setTimeout(r, 200));
      const pending = verb === "DELETE" ? call("DELETE", ev.key, who) : put(ev.key, who, "maybe");
      await new Promise((r) => setTimeout(r, 1200));
      const [tr] = await client`select clock_timestamp() as t`;
      release();
      await holder;
      expect((await pending).status).toBeLessThan(300);
      const [hit] = await client`select at from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`;
      expect(new Date(hit!.at).getTime()).toBeGreaterThanOrEqual(new Date(tr!.t).getTime());
    }
  });
});
