// WaitlistTest.php service/HTTP pins, plus real Postgres promotion races.
// Every driver is guarded and scoped to its own disposable schema.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { uniqueKey } from "../src/jobs/sync-event";
import type { QueueMessage } from "../src/jobs/types";
import { writeRsvp } from "../src/events/rsvp";
import { CAPACITY_BELOW_GOING, waitlistPosition } from "../src/events/waitlist";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Keep the tracked producer real; only its native pools are pinned to our test schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;
const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const PAGE_MEMBER_KEYS = ["100000000000000101", "100000000000000102", "100000000000000103"];
type JsonRow = {
  event_key: string;
  status: string;
  going_count: number;
  waitlist_position: number | null;
};
const answer = async (res: Response) => ((await res.json()) as { data: JsonRow }).data;
const collection = async (res: Response) => ((await res.json()) as { data: JsonRow[] }).data;

describe("waitlist test containment", () => {
  it("rejects production/staging URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("RSVP waitlist (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let client: MemberDataFixture["client"];
  let realPostgres: typeof postgres;
  const store = createMemorySessionStore();
  const sent: { body: SyncEventMessage; options?: { delaySeconds?: number } }[] = [];
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_STORE: store,
    get ADMIN_DB() {
      return db;
    },
    get DB() {
      return { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href };
    },
    SYNC_EVENT_QUEUE: {
      send: async (body: SyncEventMessage, options?: { delaySeconds?: number }) => {
        sent.push({ body, options });
      },
    },
  } as unknown as Env;

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 20 });
    db = fixture.db;
    client = fixture.client;
    // Create the fixture first: producer clients must be native, not Drizzle's
    // serializer-mutated client, and cannot escape the owned schema or URL guard.
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
      const safe = testDatabaseUrl(raw);
      return realPostgres(safe.href, {
        ...opts,
        password: () => safe.password,
        connection: { ...opts.connection, search_path: fixture.schemaName },
      });
    }) as typeof postgres);
  });
  beforeEach(async () => {
    await fixture.reset();
    await client`delete from web_throttle_hits`;
    await completeQueuedDeliveries();
  });
  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });

  async function completeQueuedDeliveries() {
    // Model completion of prior deliveries before a separate logical dispatch.
    // Clearing only `sent` would leave W13's uniqueness lock absorbing that write.
    await client`delete from queue_jobs`;
    await client`delete from job_unique_locks`;
    sent.length = 0;
  }

  async function assertTracked(eventKeys: string[], requestId?: string) {
    // The carrier contains identity only; action/payload are chosen at consumption.
    // requestId is optional route correlation (#89): HTTP routes stamp it,
    // while adminApp and direct dispatches omit it (pass undefined).
    expect(sent).toEqual(
      eventKeys.map((eventKey) => ({
        body: {
          kind: "sync-event",
          eventKey,
          idempotencyKey: expect.any(String),
          jobId: expect.any(String),
          leaseToken: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          requestId,
        },
        options: { delaySeconds: 10 },
      })),
    );
    for (const { body } of sent) {
      expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const tracked =
      await client`select job_id, kind, key, available_at > created_at as delayed from queue_jobs`;
    expect(tracked).toHaveLength(eventKeys.length);
    expect(tracked).toEqual(
      expect.arrayContaining(
        sent.map(({ body }) => ({
          job_id: body.jobId,
          kind: "sync-event",
          key: uniqueKey(body.eventKey),
          delayed: true,
        })),
      ),
    );
    const locks = await client`select key, owner_token from job_unique_locks`;
    expect(locks.map((row) => row.key).sort()).toEqual(eventKeys.map(uniqueKey).sort());
    for (const { body } of sent) {
      expect(locks.find((row) => row.key === uniqueKey(body.eventKey))).toEqual({
        key: uniqueKey(body.eventKey),
        owner_token: body.leaseToken,
      });
    }
    return sent.map(({ body }) => body);
  }

  async function cookieFor(userId: string, moderator = false): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId,
      username: userId,
      avatar: null,
      member: true,
      moderator,
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
  async function request(
    path: string,
    userId: string | null,
    method = "GET",
    body?: unknown,
    moderator = false,
    extra: Record<string, string> = {},
  ) {
    // Every HTTP write carries a cf-ray so the tracked carrier pins the
    // request correlation (#89); direct dispatches omit it.
    return app.request(
      path,
      {
        method,
        headers: {
          origin: APP_URL,
          "content-type": "application/json",
          "cf-ray": "0123456789abcdef-LHR",
          ...(userId ? { cookie: await cookieFor(userId, moderator) } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  }
  const put = (key: string, userId: string, status = "going") =>
    request(`/events/${key}/rsvp`, userId, "PUT", { status });
  const withdraw = (key: string, userId: string) =>
    request(`/events/${key}/rsvp`, userId, "DELETE");
  const patch = (key: string, capacity: number | null) =>
    request(`/events/${key}`, "moderator", "PATCH", { capacity }, true);
  const rows = (eventId: number) =>
    db.select().from(rsvps).where(eq(rsvps.eventId, eventId)).orderBy(rsvps.id);

  async function seed(over: Partial<typeof events.$inferInsert> = {}) {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: `01W1${crypto
          .randomUUID()
          .replace(/[^0-9a-f]/g, "")
          .slice(0, 22)
          .toUpperCase()}`,
        title: "Waitlist night",
        startsAt: new Date("2099-01-01T20:00:00Z"),
        endsAt: new Date("2099-01-01T22:00:00Z"),
        timezone: "UTC",
        status: "published",
        capacity: 1,
        ...over,
      })
      .returning();
    return ev!;
  }
  async function fullWithLine(count = 2, memberKeys: string[] = []) {
    const ev = await seed();
    await put(ev.eventKey, memberKeys[0] ?? "holder");
    for (let i = 1; i <= count; i++) await put(ev.eventKey, memberKeys[i] ?? `waiter-${i}`);
    // Pin same-instant FIFO so ID, not wall time, breaks the tie.
    await client`update rsvps set created_at = '2020-01-01T00:00:00Z', synced_to_discord_at = now() where event_id = ${ev.id}`;
    await completeQueuedDeliveries();
    return ev;
  }
  async function adminEdit(ev: typeof events.$inferSelect, capacity: number | null) {
    // Standalone adminApp mounts no requestLog, so c.get("requestId") is
    // undefined and the dispatch omits correlation (safeRequestId(undefined)
    // is undefined). Live-mounted /admin inherits the outer requestLog.
    return adminApp({ sessionStore: store, db }).request(
      `/events/${ev.eventKey}`,
      {
        method: "POST",
        headers: { cookie: await cookieFor("moderator", true), origin: APP_URL },
        body: new URLSearchParams({
          title: ev.title,
          timezone: "UTC",
          starts_at: "2099-01-01T20:00",
          ends_at: "2099-01-01T22:00",
          capacity: capacity === null ? "" : String(capacity),
        }),
      },
      env,
    );
  }

  it("full Going writes/re-answers are 201/200 waitlisted with position and no seat", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    for (const code of [201, 200]) {
      const res = await put(ev.eventKey, "waiter");
      expect(res.status).toBe(code);
      expect(await res.json()).toEqual({
        data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 1 },
      });
    }
    const line = await rows(ev.id);
    expect(line.filter((r) => r.status === "going")).toHaveLength(1);
    expect(line.filter((r) => r.status === "waitlisted")).toHaveLength(1);
    expect(await waitlistPosition(db, ev.id, "holder")).toBeNull();
    expect(await waitlistPosition(db, ev.id, "absent")).toBeNull();
    const [hit] =
      await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:waiter'`;
    expect(hit!.n).toBe(2);
    await assertTracked([ev.eventKey], "0123456789abcdef-LHR"); // Re-answers in one burst share a tracked carrier.
  });

  // Legacy WaitlistTest.php:322-351 at 2eaefb8d: the first five rows are its
  // non-seat answer matrix; the rest cover the complementary Maybe/NotGoing cases.
  it.each([
    { before: "going", after: "going" },
    { before: "maybe", after: "not_going" },
    { before: "not_going", after: "maybe" },
    { before: "waitlisted", after: "maybe" },
    { before: null, after: "maybe" },
    { before: "maybe", after: "maybe" },
    { before: "not_going", after: "not_going" },
    { before: "waitlisted", after: "not_going" },
    { before: null, after: "not_going" },
  ] as const)(
    "$before → $after preserves a stamped waiter beside a vacancy",
    async ({ before, after }) => {
      const ev = await fullWithLine(1);
      const userId = before === "going" ? "holder" : "answering";
      if (before !== null && before !== "going") await put(ev.eventKey, userId, before);
      await client`update rsvps set legacy_id = 4242,
      created_at = '2020-01-01T00:00:00.000001Z', updated_at = '2020-01-02T00:00:00.000002Z',
      synced_to_discord_at = '2020-01-03T00:00:00.000003Z'
      where event_id = ${ev.id} and user_id = 'waiter-1'`;
      const snapshot = () => client`select id, legacy_id, status, created_at::text,
      updated_at::text, synced_to_discord_at::text from rsvps
      where event_id = ${ev.id} and user_id = 'waiter-1'`;
      const stamped = await snapshot();
      // Bypass the capacity-edit service deliberately: normal increases settle the
      // line. One holder and one waiter beside a gap expose unconditional promotion.
      await db.update(events).set({ capacity: 2 }).where(eq(events.id, ev.id));
      await completeQueuedDeliveries();

      const res = await put(ev.eventKey, userId, after);
      expect(res.status).toBe(before === null ? 201 : 200);
      expect(await res.json()).toEqual({
        data: { status: after, synced_to_discord_at: null, waitlist_position: null },
      });
      expect(await snapshot()).toEqual(stamped);
      expect(await waitlistPosition(db, ev.id, "waiter-1")).toBe(1);
      expect(
        (await rows(ev.id)).filter((row) => row.status === "going").map((row) => row.userId),
      ).toEqual(["holder"]);
      await assertTracked([ev.eventKey], "0123456789abcdef-LHR");
    },
  );

  it.each([
    { before: null, request: "going" },
    { before: null, request: "waitlisted" },
    { before: "maybe", request: "going" },
    { before: "maybe", request: "waitlisted" },
    { before: "not_going", request: "going" },
    { before: "not_going", request: "waitlisted" },
    { before: "waitlisted", request: "going" },
    { before: "waitlisted", request: "waitlisted" },
  ] as const)(
    "$before → $request settles an earlier waiter before the caller",
    async ({ before, request: status }) => {
      const ev = await fullWithLine(1);
      if (before !== null) await put(ev.eventKey, "answering", before);
      const head = (await rows(ev.id)).find((row) => row.userId === "waiter-1")!;
      await db.update(events).set({ capacity: 2 }).where(eq(events.id, ev.id));
      await completeQueuedDeliveries();

      const res = await put(ev.eventKey, "answering", status);
      expect(res.status).toBe(before === null ? 201 : 200);
      expect(await res.json()).toEqual({
        data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 1 },
      });
      const line = await rows(ev.id);
      const promoted = line.find((row) => row.userId === "waiter-1")!;
      expect(promoted).toMatchObject({
        id: head.id,
        createdAt: head.createdAt,
        status: "going",
        syncedToDiscordAt: null,
      });
      expect(line.filter((row) => row.status === "going").map((row) => row.userId)).toEqual([
        "holder",
        "waiter-1",
      ]);
      await assertTracked([ev.eventKey], "0123456789abcdef-LHR");
    },
  );

  it("a stale-view explicit waitlist answer takes a vacant seat before a newcomer", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    await withdraw(ev.eventKey, "holder");
    const head = await put(ev.eventKey, "head", "waitlisted");
    expect(head.status).toBe(201);
    expect((await answer(head)).status).toBe("going");
    const newcomer = await put(ev.eventKey, "newcomer");
    expect(newcomer.status).toBe(201);
    expect((await answer(newcomer)).status).toBe("waitlisted");
    expect((await rows(ev.id)).map((r) => [r.userId, r.status])).toEqual([
      ["head", "going"],
      ["newcomer", "waitlisted"],
    ]);
    const [hit] =
      await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:head'`;
    expect(hit!.n).toBe(1);
  });

  it("a Going newcomer cannot bypass an accepted queue left beside a vacancy", async () => {
    const ev = await seed();
    await db.insert(rsvps).values({
      eventId: ev.id,
      userId: "head",
      status: "waitlisted",
      syncedToDiscordAt: new Date(),
    });
    const newcomer = await put(ev.eventKey, "newcomer");
    expect((await answer(newcomer)).status).toBe("waitlisted");
    const line = await rows(ev.id);
    expect(line.map((r) => [r.userId, r.status])).toEqual([
      ["head", "going"],
      ["newcomer", "waitlisted"],
    ]);
    expect(line[0]!.syncedToDiscordAt).toBeNull();
    await assertTracked([ev.eventKey], "0123456789abcdef-LHR");
  });

  it.each(["new", "older-maybe"])(
    "%s waiter uses the DB clock rather than a skewed/truncated Worker clock",
    async (kind) => {
      const ev = await seed();
      await put(ev.eventKey, "holder");
      if (kind === "older-maybe") await put(ev.eventKey, "later", "maybe");
      // Keep the database's microseconds, then make the injected Worker clock earlier
      // within that millisecond. A Date-based fresh FIFO key would jump this head.
      const [time] = await client`insert into rsvps (event_id, user_id, status, created_at)
      values (${ev.id}, 'head', 'waitlisted', date_trunc('milliseconds', clock_timestamp()) + interval '456 microseconds')
      returning created_at`;
      const workerTime = new Date(time!.created_at);
      await writeRsvp(db, ev.eventKey, "later", "going", () => workerTime);
      expect(await waitlistPosition(db, ev.id, "head")).toBe(1);
      expect(await waitlistPosition(db, ev.id, "later")).toBe(2);
    },
  );

  it("withdraw promotes the FIFO head in its commit, clears its mirror stamp and queues write-back", async () => {
    const ev = await fullWithLine();
    const before = await rows(ev.id);
    expect(await waitlistPosition(db, ev.id, "waiter-1")).toBe(1);
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(2);
    expect((await withdraw(ev.eventKey, "holder")).status).toBe(204);
    const after = await rows(ev.id);
    expect(after.map((r) => [r.userId, r.status])).toEqual([
      ["waiter-1", "going"],
      ["waiter-2", "waitlisted"],
    ]);
    expect(after[0]!.syncedToDiscordAt).toBeNull();
    expect(after[1]!.syncedToDiscordAt).toEqual(before[2]!.syncedToDiscordAt);
    expect(await waitlistPosition(db, ev.id, "waiter-1")).toBeNull();
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
    await assertTracked([ev.eventKey], "0123456789abcdef-LHR");
    const [hit] =
      await client`select count(*)::int as n from web_throttle_hits where bucket = 'rsvp-write:waiter-1'`;
    expect(hit!.n).toBe(1); // Automatic promotion spends no member attempt.
  });

  it("leaving the line compacts positions without disturbing the holder", async () => {
    const ev = await fullWithLine();
    await withdraw(ev.eventKey, "waiter-1");
    expect((await rows(ev.id)).map((r) => [r.userId, r.status])).toEqual([
      ["holder", "going"],
      ["waiter-2", "waitlisted"],
    ]);
    expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
  });

  it.each(["maybe", "not_going", "waitlisted"])(
    "Going → %s frees a seat to the existing head",
    async (status) => {
      const ev = await fullWithLine();
      const before = await rows(ev.id);
      const res = await put(ev.eventKey, "holder", status);
      expect(res.status).toBe(200);
      expect((await answer(res)).status).toBe(status);
      const line = await rows(ev.id);
      expect(line.find((r) => r.userId === "waiter-1")).toMatchObject({
        id: before[1]!.id,
        createdAt: before[1]!.createdAt,
        status: "going",
        syncedToDiscordAt: null,
      });
      expect(line.find((r) => r.userId === "waiter-2")).toEqual(before[2]);
      expect(await waitlistPosition(db, ev.id, "holder")).toBe(status === "waitlisted" ? 2 : null);
      expect(await waitlistPosition(db, ev.id, "waiter-2")).toBe(1);
    },
  );

  it("returns the settled Going answer when the former holder is the only waiter", async () => {
    const ev = await seed();
    await put(ev.eventKey, "holder");
    const res = await put(ev.eventKey, "holder", "waitlisted");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
    });
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

  it.each(["json", "admin"])(
    "%s capacity increase deals N heads; unlimited deals the rest",
    async (surface) => {
      const ev = await fullWithLine(3);
      const increase = surface === "json" ? await patch(ev.eventKey, 3) : await adminEdit(ev, 3);
      expect(increase.status).toBe(surface === "json" ? 200 : 303);
      if (surface === "json") expect((await answer(increase)).going_count).toBe(3);
      let line = await rows(ev.id);
      expect(line.map((r) => r.status)).toEqual(["going", "going", "going", "waitlisted"]);
      expect(line.slice(1, 3).every((r) => r.syncedToDiscordAt === null)).toBe(true);
      expect(line[3]!.syncedToDiscordAt).not.toBeNull();
      const [firstDelivery] = await assertTracked(
        [ev.eventKey],
        surface === "admin" ? undefined : "0123456789abcdef-LHR",
      );
      await completeQueuedDeliveries();
      const unlimited =
        surface === "json" ? await patch(ev.eventKey, null) : await adminEdit(ev, null);
      expect(unlimited.status).toBe(surface === "json" ? 200 : 303);
      line = await rows(ev.id);
      expect(line.every((r) => r.status === "going")).toBe(true);
      const [nextDelivery] = await assertTracked(
        [ev.eventKey],
        surface === "admin" ? undefined : "0123456789abcdef-LHR",
      );
      expect(nextDelivery!.jobId).not.toBe(firstDelivery!.jobId);
      expect(nextDelivery!.idempotencyKey).not.toBe(firstDelivery!.idempotencyKey);
    },
  );

  it("a JSON parent time/capacity edit promotes FIFO and dispatches shifted child write-backs", async () => {
    const ev = await fullWithLine();
    await db
      .update(events)
      .set({ recurrenceFrequency: "weekly", recurrenceCount: 2 })
      .where(eq(events.id, ev.id));
    const child = await seed({
      parentEventId: ev.id,
      recurrenceIndex: 2,
      startsAt: new Date("2099-01-08T20:00:00Z"),
      endsAt: new Date("2099-01-08T22:00:00Z"),
    });
    const res = await request(
      `/events/${ev.eventKey}`,
      "moderator",
      "PATCH",
      {
        capacity: 3,
        starts_at: "2099-01-02T20:00",
        ends_at: "2099-01-02T22:00",
      },
      true,
    );
    expect(res.status).toBe(200);
    expect((await answer(res)).going_count).toBe(3);
    expect((await rows(ev.id)).map((r) => r.status)).toEqual(["going", "going", "going"]);
    const [shifted] = await db.select().from(events).where(eq(events.id, child.id));
    expect(shifted!.startsAt.toISOString()).toBe("2099-01-09T20:00:00.000Z");
    expect(shifted!.endsAt.toISOString()).toBe("2099-01-09T22:00:00.000Z");
    expect(shifted!.capacity).toBe(1);
    await assertTracked([ev.eventKey, child.eventKey], "0123456789abcdef-LHR");
  });

  it.each(["json", "admin"])(
    "%s refuses a cap below Going with a field error and no mutation",
    async (surface) => {
      const ev = await seed({ capacity: 2 });
      await put(ev.eventKey, "a");
      await put(ev.eventKey, "b");
      await put(ev.eventKey, "maybe", "maybe");
      await put(ev.eventKey, "no", "not_going");
      await put(ev.eventKey, "line", "waitlisted");
      await completeQueuedDeliveries();
      const res = surface === "json" ? await patch(ev.eventKey, 1) : await adminEdit(ev, 1);
      expect(res.status).toBe(422);
      const capacityError = `${CAPACITY_BELOW_GOING} Occupied seats: 2.`;
      if (surface === "json")
        expect(await res.json()).toEqual({ error: "invalid", fields: { capacity: capacityError } });
      else expect(await res.text()).toContain(capacityError);
      const [stored] = await db.select().from(events).where(eq(events.id, ev.id));
      expect(stored!.capacity).toBe(2);
      expect(await rows(ev.id)).toHaveLength(5);
      expect(sent).toHaveLength(0);
      // Exactly the going count is legal; non-seat statuses do not inflate the floor.
      expect(
        (surface === "json" ? await patch(ev.eventKey, 2) : await adminEdit(ev, 2)).status,
      ).toBe(surface === "json" ? 200 : 303);
    },
  );

  it.each([true, [], {}, -1, 1.5, 2147483648])(
    "invalid JSON capacity %j is a field error, never unlimited",
    async (capacity) => {
      const ev = await seed();
      const res = await request(`/events/${ev.eventKey}`, "moderator", "PATCH", { capacity }, true);
      expect(res.status).toBe(422);
      const [stored] = await db.select().from(events).where(eq(events.id, ev.id));
      expect(stored!.capacity).toBe(1);
    },
  );

  it("title-only JSON PATCH preserves a finite numeric capacity and keeps the line intact", async () => {
    const ev = await fullWithLine();
    const res = await request(
      `/events/${ev.eventKey}`,
      "moderator",
      "PATCH",
      { title: "Renamed night" },
      true,
    );
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

  it.each(["cancelled", "past", "draft", "ended", "paused"])(
    "%s events leave the line frozen on withdraw and capacity edits",
    async (state) => {
      const ev = await fullWithLine();
      await db
        .update(events)
        .set(
          state === "paused"
            ? { rsvpOpen: false }
            : state === "ended"
              ? { startsAt: new Date(0), endsAt: new Date(3600_000) }
              : { status: state },
        )
        .where(eq(events.id, ev.id));
      expect((await put(ev.eventKey, "newcomer")).status).toBe(403);
      expect((await withdraw(ev.eventKey, "holder")).status).toBe(204);
      expect((await patch(ev.eventKey, 3)).status).toBe(200);
      expect(
        (await rows(ev.id)).every((r) => r.status === "waitlisted" && r.syncedToDiscordAt !== null),
      ).toBe(true);
    },
  );

  it("exposes only the viewer's position beside Going attendees, with private caching and position-sensitive ETags", async () => {
    const ev = await fullWithLine(2, PAGE_MEMBER_KEYS);
    await client`insert into users (id, username) values (${PAGE_MEMBER_KEYS[0]!}, 'Current holder'), (${PAGE_MEMBER_KEYS[1]!}, 'First waiter'), (${PAGE_MEMBER_KEYS[2]!}, 'Second waiter')`;
    const first = await request("/events.json", PAGE_MEMBER_KEYS[1]!);
    const data = await collection(first);
    expect(data.find((e) => e.event_key === ev.eventKey)!.waitlist_position).toBe(1);
    const etag = first.headers.get("etag")!;
    const second = await request("/events.json", PAGE_MEMBER_KEYS[2]!, "GET", undefined, false, {
      "if-none-match": etag,
    });
    expect(second.status).toBe(200);
    expect((await collection(second))[0]!.waitlist_position).toBe(2);
    const page = await request(`/e/${ev.eventKey}`, PAGE_MEMBER_KEYS[2]!);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("vary")).toBe("Cookie");
    const memberHtml = await page.text();
    expect(memberHtml).toContain('data-waitlist-position="2"');
    expect(memberHtml).toContain(`href="/members/${PAGE_MEMBER_KEYS[0]}">Current holder</a>`);
    expect(memberHtml).not.toContain("First waiter");
    expect(memberHtml).not.toContain("Second waiter");
    expect(memberHtml).not.toContain('data-testid="event-join-pitch"');
    const guest = await request(`/e/${ev.eventKey}`, null);
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect(guest.headers.get("vary")).toBe("Cookie");
    const guestHtml = await guest.text();
    expect(guestHtml).toContain('data-waitlist-position=""');
    expect(guestHtml).toContain('data-testid="event-join-pitch"');
    expect(guestHtml).not.toContain("Current holder");
    expect(guestHtml).not.toContain('data-testid="event-attendees"');
    await withdraw(ev.eventKey, PAGE_MEMBER_KEYS[0]!);
    const refresh = await request("/events.json", PAGE_MEMBER_KEYS[2]!, "GET", undefined, false, {
      "if-none-match": second.headers.get("etag")!,
    });
    expect(refresh.status).toBe(200);
    expect((await collection(refresh))[0]!.waitlist_position).toBe(1);
    const promotedHtml = await (await request(`/e/${ev.eventKey}`, PAGE_MEMBER_KEYS[2]!)).text();
    expect(promotedHtml).toContain('data-waitlist-position="1"');
    expect(promotedHtml).toContain(`href="/members/${PAGE_MEMBER_KEYS[1]}">First waiter</a>`);
    expect(promotedHtml).not.toContain("Current holder");
  });

  it("composes private waitlist positions and promoted attendees with navigation and offset-labelled related events", async () => {
    const ev = await fullWithLine(2, PAGE_MEMBER_KEYS);
    await client`insert into users (id, username) values (${PAGE_MEMBER_KEYS[0]!}, 'Current holder'), (${PAGE_MEMBER_KEYS[1]!}, 'First waiter')`;
    const previous = await seed({
      startsAt: new Date("2098-12-31T20:00:00Z"),
      endsAt: new Date("2098-12-31T22:00:00Z"),
    });
    const next = await seed({
      startsAt: new Date("2099-01-02T01:00:00Z"),
      endsAt: new Date("2099-01-02T03:00:00Z"),
      timezone: "America/New_York",
    });
    const page = await request(`/e/${ev.eventKey}`, PAGE_MEMBER_KEYS[2]!);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("vary")).toBe("Cookie");
    const html = await page.text();
    expect(html).toContain('data-waitlist-position="2"');
    expect(html).toContain(`href="/members/${PAGE_MEMBER_KEYS[0]}">Current holder</a>`);
    expect(html).toContain(`href="/e/${previous.eventKey}" rel="prev"`);
    expect(html).toContain(`href="/e/${next.eventKey}" rel="next"`);
    expect(html).toContain(
      'datetime="2099-01-02T01:00:00.000Z">Thursday, 1 January 2099 at 20:00 GMT-05:00',
    );
    expect(html).not.toContain('data-testid="event-related-join"');
    const guest = await (await request(`/e/${ev.eventKey}`, null)).text();
    expect(guest).toContain('data-waitlist-position=""');
    expect(guest).toContain(
      `href="/join?next=%2Fe%2F${ev.eventKey}" data-testid="event-related-join"`,
    );
    expect(guest).not.toContain("Current holder");
    await withdraw(ev.eventKey, PAGE_MEMBER_KEYS[0]!);
    const promoted = await (await request(`/e/${ev.eventKey}`, PAGE_MEMBER_KEYS[2]!)).text();
    expect(promoted).toContain('data-waitlist-position="1"');
    expect(promoted).toContain(`href="/members/${PAGE_MEMBER_KEYS[1]}">First waiter</a>`);
    expect(promoted).not.toContain("Current holder");
    expect(promoted).toContain(`href="/e/${next.eventKey}" rel="next"`);
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

  it.each(["withdraw", "downgrade"])(
    "%s stamps its one budget debit after a promotion-row wait",
    async (verb) => {
      const ev = await fullWithLine();
      await client`delete from web_throttle_hits where bucket = 'rsvp-write:holder'`;
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = client.begin(async (tx) => {
        await tx`select id from rsvps where event_id = ${ev.id} and user_id = 'waiter-1' for update`;
        const [backend] = await tx`select pg_backend_pid() as pid`;
        ready(Number(backend!.pid));
        await gate;
      });
      let pending: Promise<Response> | undefined;
      let releasedAt!: Date;
      try {
        const pid = await acquired;
        pending =
          verb === "withdraw"
            ? withdraw(ev.eventKey, "holder")
            : put(ev.eventKey, "holder", "maybe");
        await waiterBlockedBy(pid);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [time] = await client`select clock_timestamp() as t`;
        releasedAt = new Date(time!.t);
      } finally {
        release();
        await holder;
        await pending;
      }
      expect((await pending!).status).toBe(verb === "withdraw" ? 204 : 200);
      const hits =
        await client`select at from web_throttle_hits where bucket = 'rsvp-write:holder'`;
      expect(hits).toHaveLength(1);
      expect(new Date(hits[0]!.at).getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
      expect((await rows(ev.id)).find((r) => r.userId === "waiter-1")!.status).toBe("going");
    },
  );

  it("PUT judges expiry after the promotion-row wait without charging or mutating", async () => {
    const ev = await fullWithLine();
    await client`delete from web_throttle_hits where bucket = 'rsvp-write:holder'`;
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = client.begin(async (tx) => {
      await tx`select id from rsvps where event_id = ${ev.id} and user_id = 'waiter-1' for update`;
      const [backend] = await tx`select pg_backend_pid() as pid`;
      ready(Number(backend!.pid));
      await gate;
    });
    let pending: ReturnType<typeof writeRsvp> | undefined;
    let expired = false;
    try {
      const pid = await acquired;
      pending = writeRsvp(db, ev.eventKey, "holder", "maybe", () =>
        expired ? ev.endsAt : new Date(),
      );
      await waiterBlockedBy(pid);
      expired = true;
    } finally {
      release();
      await holder;
      await pending;
    }
    expect(await pending!).toEqual({ ok: false, reason: "closed", why: "past" });
    expect((await rows(ev.id)).map((r) => r.status)).toEqual(["going", "waitlisted", "waitlisted"]);
    const hits = await client`select at from web_throttle_hits where bucket = 'rsvp-write:holder'`;
    expect(hits).toHaveLength(0);
  });

  it.each(["going", "waitlisted", "maybe"])(
    "a limited %s write does not settle an existing queue",
    async (status) => {
      const ev = await seed();
      await db.insert(rsvps).values({
        eventId: ev.id,
        userId: "head",
        status: "waitlisted",
        syncedToDiscordAt: new Date(),
      });
      await client`insert into web_throttle_hits (bucket, at) select 'rsvp-write:limited', clock_timestamp() from generate_series(1, 12)`;
      const before = await rows(ev.id);
      expect((await put(ev.eventKey, "limited", status)).status).toBe(429);
      expect(await rows(ev.id)).toEqual(before);
      expect(sent).toHaveLength(0);
    },
  );

  it("ordinary draft navigation rotates and renews the moderator's session", async () => {
    const ev = await seed({ status: "draft" });
    let now = Date.now();
    const sessions = createMemorySessionStore(() => now);
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await sessions.create({
      tokenHash,
      userId: "100000000000000111",
      username: "moderator",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(now + 1000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const res = await app.request(
      `/e/${ev.eventKey}`,
      { headers: { cookie } },
      { ...env, SESSION_STORE: sessions },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // The status hash is liveness-only; select the actual rotating login cookie.
    const replacements = res.headers
      .getSetCookie()
      .filter((value) => value.startsWith("__Host-two_session="));
    expect(replacements).toHaveLength(1);
    const replacement = replacements[0]!.split(";")[0]!;
    expect(replacement).not.toBe(cookie);
    expect(await sessions.get(tokenHash)).toBeNull();
    now += 1100;
    const again = await app.request(
      `/e/${ev.eventKey}`,
      { headers: { cookie: replacement } },
      { ...env, SESSION_STORE: sessions },
    );
    expect(again.status).toBe(200);
  });

  it("concurrent withdraw + Going cannot steal the head's freed seat or over-allocate", async () => {
    const ev = await fullWithLine();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
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
