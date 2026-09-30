// W9: RSVP PUT/DELETE, the shared 12/min budget, the one-429 shape and the FOR UPDATE races.
// Live against agent-testdb (skipped without DATABASE_URL, like test/events.test.ts). Never point
// this at anything but a test container.
import { randomUUID } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";

// RSVP transaction/race tests isolate dispatch; event-writeback.test.ts proves
// the real W13 producer, ledger and unique lock with a queue double.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { RSVP_RATE_LIMIT } from "../src/islands/contracts";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

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

// Static containment pin: the guard this file wires below refuses non-test
// URLs before any driver exists. Always runs, needs no database.
describe("rsvp test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rsvp routes (agent-testdb)", () => {
  // Owned disposable schema (W15 fixture): every pool and driver below resolves
  // unqualified names inside `w9_<uuid>`, so the deletes, raw throttle SQL and
  // lock holders in this file can never reach the caller's tables. The guard
  // runs before any driver exists: a non-test DATABASE_URL throws in beforeAll
  // (and in the static containment pin above), and dispose() drops the schema.
  // Pool width 20: race tests hold a lock transaction open while concurrent
  // requests and the pg_stat_activity observer need their own connections.
  let fixture: MemberDataFixture;
  let client: ReturnType<typeof postgres>;
  let db: MemberDataFixture["db"];
  const store = createMemorySessionStore();
  const sent: QueueMessage[] = [];
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    get ADMIN_DB() { return db; },
    SESSION_STORE: store,
    SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
  } as unknown as Env;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 20 });
    client = fixture.client;
    db = fixture.db;
  });

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
  const state = async (eventId: number) => {
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits`) as unknown as [{ n: number }];
    return { rows: (await rows(eventId)).length, hits: n };
  };

  // Sentinel OUTSIDE the owned schema: the suite must never create, reuse or
  // drop the shared fixed name `w9_sentinel_proof`. Setup only snapshots it
  // (existence + rows via to_regclass, no DDL), the z_sentinel test asserts it
  // is byte-identical at the end, and teardown never drops it. The proof the
  // suite DOES own is a per-run UUID table: plain CREATE (no IF NOT EXISTS,
  // so a collision fails loudly instead of reusing another run's object),
  // dropped only when this run created it. A separate connection without the
  // fixture search_path reaches both; the fixture pools cannot even see them.
  const ownedSentinel = `w9_sentinel_${randomUUID().replaceAll("-", "")}`;
  let sentinelAdmin!: ReturnType<typeof postgres>;
  let ownedSentinelCreated = false;
  let fixedExisted = false;
  let fixedRows: { id: number; note: string | null }[] = [];
  const fixedExists = async () => {
    const [r] = (await sentinelAdmin`select to_regclass('public.w9_sentinel_proof') as r`) as unknown as { r: string | null }[];
    return r!.r !== null;
  };
  beforeAll(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    sentinelAdmin = postgres(url.href, { max: 1, port: 5432, connect_timeout: 5, password: () => url.password });
    fixedExisted = await fixedExists();
    if (fixedExisted) fixedRows = (await sentinelAdmin`select id, note from w9_sentinel_proof order by id`) as unknown as typeof fixedRows;
    await sentinelAdmin.unsafe(`CREATE TABLE "${ownedSentinel}" (id int primary key, note text)`);
    ownedSentinelCreated = true;
    await sentinelAdmin.unsafe(`INSERT INTO "${ownedSentinel}" VALUES (1, 'untouched')`);
  });

  beforeEach(async () => {
    await client`delete from web_throttle_hits`;
    await fixture.reset();
    sent.length = 0;
  });
  afterAll(async () => {
    try {
      // Only the per-run object this run created; the fixed shared name is
      // never dropped, even if it exists.
      if (ownedSentinelCreated) await sentinelAdmin.unsafe(`DROP TABLE "${ownedSentinel}"`);
    } finally {
      await sentinelAdmin?.end();
      await fixture?.dispose();
    }
  });

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
    expect(sent.map((m) => m.kind)).toEqual(["sync-event", "sync-event", "sync-event"]);
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

  it("honeypot fail-closed: a present non-string PUT decoy writes no row and spends no hit", async () => {
    const ev = await seed();
    const real = await (await put(ev.key, "u1", "going")).text();
    await db.delete(rsvps);
    await client`delete from web_throttle_hits`;
    const decoy = await put(ev.key, null, "going", { website: true });
    expect(decoy.status).toBe(201);
    expect(await decoy.text()).toBe(real);
    expect(await rows(ev.id)).toHaveLength(0);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits`) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it("honeypot: an empty DELETE query cannot mask a filled body decoy (row kept, no hit)", async () => {
    const ev = await seed();
    expect((await put(ev.key, "u1", "going")).status).toBe(201);
    await client`delete from web_throttle_hits`;
    const res = await app.request(
      `/events/${ev.key}/rsvp?website=`,
      {
        method: "DELETE",
        headers: { cookie: await cookieFor(store, "u1"), origin: APP_URL, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ website: "spam" }),
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(await rows(ev.id)).toHaveLength(1);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits`) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it("honeypot: a filled duplicate DELETE query cannot hide behind an empty first value", async () => {
    const ev = await seed();
    expect((await put(ev.key, "u1", "going")).status).toBe(201);
    await client`delete from web_throttle_hits`;
    // query() is first-wins (?website=&website=spam reads ""); the trap must
    // see every value.
    const res = await app.request(
      `/events/${ev.key}/rsvp?website=&website=spam`,
      {
        method: "DELETE",
        headers: { cookie: await cookieFor(store, "u1"), origin: APP_URL, accept: "application/json", "content-type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(await state(ev.id)).toEqual({ rows: 1, hits: 0 });
  });

  it("honeypot: a filled duplicate PUT form cannot hide behind an empty last value", async () => {
    const ev = await seed();
    // parseBody() is last-wins (website=spam&website= reads ""); the trap
    // must see every value.
    const res = await app.request(
      `/events/${ev.key}/rsvp`,
      {
        method: "PUT",
        headers: { cookie: await cookieFor(store, "u1"), origin: APP_URL, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: "status=going&website=spam&website=",
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(await state(ev.id)).toEqual({ rows: 0, hits: 0 });
  });

  it("honeypot: a mixed-case JSON media type cannot hide a DELETE body trap", async () => {
    const ev = await seed();
    expect((await put(ev.key, "u1", "going")).status).toBe(201);
    await client`delete from web_throttle_hits`;
    const res = await app.request(
      `/events/${ev.key}/rsvp?website=`,
      {
        method: "DELETE",
        headers: { cookie: await cookieFor(store, "u1"), origin: APP_URL, accept: "application/json", "content-type": "Application/Json" },
        body: JSON.stringify({ website: true }),
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(await state(ev.id)).toEqual({ rows: 1, hits: 0 });
  });

  it("honeypot: absent/empty inputs stay genuine (PUT writes, DELETE removes + charges)", async () => {
    const ev = await seed();
    expect((await put(ev.key, "u1", "going", { website: "" })).status).toBe(201);
    expect(await rows(ev.id)).toHaveLength(1);
    expect((await call("DELETE", ev.key, "u1")).status).toBe(204);
    expect(await rows(ev.id)).toHaveLength(0);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits`) as unknown as [{ n: number }];
    expect(n).toBe(2);
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
  // Poll pg_stat_activity until the pending request visibly waits on the lock pattern.
  const waitForLock = async (pattern: string): Promise<boolean> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const [w] = (await client`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like ${pattern}`) as unknown as [{ n: number }];
      if (w!.n > 0) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("expiry is judged after the RSVP-row wait: an existing answer queued behind a stamp writer is refused once the event ends", async () => {
    const ev = await seed();
    const who = "expire-rowlock";
    expect((await put(ev.key, who, "going")).status).toBe(201);
    await client`delete from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`;
    await client`update events set ends_at = clock_timestamp() + interval '3 seconds' where id = ${ev.id}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`update rsvps set synced_to_discord_at = clock_timestamp() where event_id = ${ev.id} and user_id = ${who}`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, who, "maybe");
    expect(await waitForLock('%from "rsvps"%for update%')).toBe(true);
    // Let the event end while the write is still queued behind the row lock.
    await client`select pg_sleep(greatest(0, extract(epoch from (ends_at - clock_timestamp())) + 0.2)) from events where id = ${ev.id}`;
    release();
    await holder;
    expect((await pending).status).toBe(403);
    expect((await rows(ev.id)).map((r) => r.status)).toEqual(["going"]);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });
  it("the global prune runs before the hit is stamped: a write queued behind prune keeps a fresh budget", async () => {
    const ev = await seed();
    const who = "prune-rowlock";
    await client`insert into web_throttle_hits (bucket, at) values ('unrelated-expired-bucket', clock_timestamp() - interval '10 minutes')`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select * from web_throttle_hits where bucket = 'unrelated-expired-bucket' for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, who, "going");
    expect(await waitForLock("%delete from web_throttle_hits%")).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    const [tr] = await client`select clock_timestamp() as t`;
    release();
    await holder;
    expect((await pending).status).toBe(201);
    const [hit] = await client`select at from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`;
    expect(new Date(hit!.at).getTime()).toBeGreaterThanOrEqual(new Date(tr!.t).getTime());
    await client`delete from web_throttle_hits where bucket = 'unrelated-expired-bucket'`;
  });
  it("expiry is judged after the prune wait: a PUT queued behind prune is refused once the event ends", async () => {
    const ev = await seed();
    const who = "expire-prunelock";
    await client`insert into web_throttle_hits (bucket, at) values ('unrelated-expired-hold', clock_timestamp() - interval '10 minutes')`;
    await client`update events set ends_at = clock_timestamp() + interval '3 seconds' where id = ${ev.id}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = client.begin(async (tx) => {
      await tx`select * from web_throttle_hits where bucket = 'unrelated-expired-hold' for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = put(ev.key, who, "going");
    expect(await waitForLock("%delete from web_throttle_hits%")).toBe(true);
    // Let the event end while the write is still queued behind the prune.
    await client`select pg_sleep(greatest(0, extract(epoch from (ends_at - clock_timestamp())) + 0.2)) from events where id = ${ev.id}`;
    release();
    await holder;
    expect((await pending).status).toBe(403);
    expect(await rows(ev.id)).toHaveLength(0);
    const [{ n }] = (await client`select count(*)::int as n from web_throttle_hits where bucket = ${`rsvp-write:${who}`}`) as unknown as [{ n: number }];
    expect(n).toBe(0);
    await client`delete from web_throttle_hits where bucket = 'unrelated-expired-hold'`;
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
  // Runs last (named zz_): after every delete, raw throttle statement and
  // lock holder in this file, the objects outside the owned schema must be
  // intact — the executable proof that cleanup stayed scoped. Two halves:
  // (1) the suite's own per-run UUID table is untouched; (2) the shared
  // fixed name is byte-identical to the no-DDL snapshot from setup — whether
  // or not it existed — so a pre-seeded unrelated row survives and no
  // concurrent run's table is dropped. The fixture pools pin search_path to
  // the owned schema (they cannot even resolve a public-schema table:
  // verified with a negative control), so the only pool that can reach
  // either object is the unscoped admin one, which the suite uses solely to
  // snapshot and read. Vitest runs tests in file order, so this is the final
  // DB test.
  it("zz_sentinel: the owned proof and any pre-existing fixed table survive the whole suite", async () => {
    const orows = (await sentinelAdmin.unsafe(`SELECT note FROM "${ownedSentinel}" WHERE id = 1`)) as unknown as { note: string }[];
    expect(orows[0]!.note).toBe("untouched");
    // The suite did its work inside the owned schema: its tables exist there.
    const srows = (await sentinelAdmin`select count(*)::int as n from pg_tables where schemaname = ${fixture.schemaName} and tablename in ('events', 'rsvps', 'web_throttle_hits')`) as unknown as { n: number }[];
    expect(srows[0]!.n).toBe(3);
    // The fixed shared name is exactly as setup found it — never created,
    // reused or dropped by this suite.
    expect(await fixedExists()).toBe(fixedExisted);
    if (fixedExisted) {
      const now = (await sentinelAdmin`select id, note from w9_sentinel_proof order by id`) as unknown as typeof fixedRows;
      expect(now).toEqual(fixedRows);
    }
  });
});
