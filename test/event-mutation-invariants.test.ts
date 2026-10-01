// W15 A1/A2: legacy EndedDraftPublicationTest + EventCapacityFloorTest.
// A per-run schema inside the test container owns all rows and lock holders.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { getEvent, updateEvent } from "../src/admin/store";
import { type EventFormInput, newEventKey, parseEventForm, ValidationError } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const NOW = new Date("2026-09-30T12:00:00Z");
const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const ENDED = "An event that has already ended cannot be published. Update its dates first.";
const FLOOR = "Capacity cannot be lower than the number of members already going. Occupied seats: 5.";
const ACTOR = { id: "moderator", username: "mod" };

describe("event mutation test containment", () => {
  it("refuses a non-test database before constructing a driver", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/events", {})).toThrow("refusing before connecting");
  });
});

describe("JSON capacity parsing", () => {
  const fields = { title: "Game night", starts_at: "2026-09-30 11:00", ends_at: "2026-09-30 13:00", timezone: "UTC" };
  it.each([5, "5"])("keeps finite capacity %s rather than treating it as unlimited", (capacity) => {
    expect(parseEventForm({ ...fields, capacity }).capacity).toBe(5);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("refuses invalid numeric capacity %s", (capacity) => {
    expect(() => parseEventForm({ ...fields, capacity })).toThrow(ValidationError);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event mutation invariants (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore(() => Date.now());
  type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;
  const sent: SyncMessage[] = [];
  let realPostgres: typeof postgres;
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    get ADMIN_DB() { return fixture.db; },
    SESSION_STORE: store,
    get DB() { return { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href }; },
    SYNC_EVENT_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) },
  } as unknown as Env;

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
    // Producer clients must stay inside the owned schema and test-URL guard.
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
      const safe = testDatabaseUrl(raw);
      return realPostgres(safe.href, {
        ...opts, password: () => safe.password,
        connection: { ...opts.connection, search_path: fixture.schemaName },
      });
    }) as typeof postgres);
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    await fixture.client`delete from queue_jobs`;
    await fixture.client`delete from job_unique_locks`;
    sent.length = 0;
    // Keep socket/lock-observer timers real while pinning the decision clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });

  async function cookieFor(userId = ACTOR.id, moderator = true): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId, username: userId, avatar: null,
      member: true, moderator, expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  }

  async function json(method: string, path: string, body?: unknown, member?: string): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        cookie: await cookieFor(member, member === undefined), origin: APP_URL,
        accept: "application/json", "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
  }
  async function browser(path: string, values?: Record<string, string>): Promise<Response> {
    return adminApp({ sessionStore: store, db: fixture.db }).request(path, {
      method: "POST",
      headers: { cookie: await cookieFor(), origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: values === undefined ? undefined : new URLSearchParams(values),
    }, env);
  }
  async function seed(over: Partial<typeof events.$inferInsert> = {}) {
    const [row] = await fixture.db.insert(events).values({
      eventKey: newEventKey(), title: "Game night", startsAt: new Date(NOW.getTime() - 3600_000),
      endsAt: new Date(NOW.getTime() + 3600_000), timezone: "UTC", status: "draft", capacity: 8,
      createdAt: NOW, updatedAt: NOW, ...over,
    }).returning();
    return row!;
  }
  async function occupied(capacity: number | null = 8) {
    const row = await seed({ status: "published", capacity });
    const statuses = ["going", "going", "going", "going", "going", "maybe", "not_going", "waitlisted"];
    await fixture.db.insert(rsvps).values(statuses.map((status, i) => ({ eventId: row.id, userId: `member-${i}`, status })));
    return row;
  }
  const state = async (key: string) => ({
    row: await getEvent(fixture.db, key),
    answers: await fixture.db.select().from(rsvps).orderBy(rsvps.id),
    audits: await fixture.db.select().from(activityLog).orderBy(activityLog.id),
  });
  const form = (capacity: string) => ({
    title: "Edited title", starts_at: "2026-09-30 11:00", ends_at: "2026-09-30 13:00", timezone: "UTC", capacity,
  });
  const input = (row: typeof events.$inferSelect, capacity: number | null): EventFormInput => ({
    title: "Edited title", game: row.game, description: row.description,
    startsAtUtc: row.startsAt, endsAtUtc: row.endsAt, timezone: row.timezone, location: row.location, capacity,
  });

  it("POST publish refuses an ended draft with the legacy ends_at message and no mutations or announcement", async () => {
    const row = await seed({ endsAt: new Date(NOW.getTime() - 1) });
    const before = await state(row.eventKey);
    const response = await json("POST", `/events/${row.eventKey}/publish`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid", fields: { ends_at: ENDED } });
    expect(await state(row.eventKey)).toEqual(before);
    expect(sent).toEqual([]);
  });

  it.each([0, 1, 3600_000])("allows an ongoing draft ending in %i ms (strict boundary)", async (untilEnd) => {
    const row = await seed({ endsAt: new Date(NOW.getTime() + untilEnd) });
    const response = await json("POST", `/events/${row.eventKey}/publish`);
    expect(response.status).toBe(200);
    expect((await getEvent(fixture.db, row.eventKey))?.status).toBe("published");
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: row.eventKey });
  });

  it("still allows POST cancel of an ended draft", async () => {
    const row = await seed({ endsAt: new Date(NOW.getTime() - 1) });
    expect((await json("POST", `/events/${row.eventKey}/cancel`)).status).toBe(200);
    expect((await getEvent(fixture.db, row.eventKey))?.status).toBe("cancelled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: row.eventKey });
  });

  it("admin POST publish renders the expiry reason; admin cancel of that draft remains legal", async () => {
    const row = await seed({ endsAt: new Date(NOW.getTime() - 1) });
    const before = await state(row.eventKey);
    const response = await browser(`/events/${row.eventKey}/publish`);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(ENDED);
    expect(await state(row.eventKey)).toEqual(before);
    expect(sent).toEqual([]);
    expect((await browser(`/events/${row.eventKey}/cancel`)).status).toBe(303);
    expect((await getEvent(fixture.db, row.eventKey))?.status).toBe("cancelled");
  });

  it.each(["json", "admin"] as const)("%s edit refuses below occupied seats from both finite and unlimited capacity", async (path) => {
    for (const capacity of [8, null]) {
      await fixture.reset();
      const row = await occupied(capacity);
      const before = await state(row.eventKey);
      const response = path === "json"
        ? await json("PATCH", `/events/${row.eventKey}`, { title: "Edited title", capacity: 2 })
        : await browser(`/events/${row.eventKey}`, form("2"));
      expect(response.status).toBe(422);
      if (path === "json") expect(await response.json()).toEqual({ error: "invalid", fields: { capacity: FLOOR } });
      else {
        const html = await response.text();
        expect(html).toContain(FLOOR);
        expect(html).toContain("Edited title"); // Keep submitted values for correction.
      }
      expect(await state(row.eventKey)).toEqual(before);
      expect(sent).toEqual([]);
    }
  });

  it.each(["json", "admin"] as const)("%s edit permits equal, higher and unlimited capacity; non-going answers do not raise the floor", async (path) => {
    for (const capacity of [5, 10, null]) {
      await fixture.reset();
      const row = await occupied();
      const answers = (await state(row.eventKey)).answers;
      const response = path === "json"
        ? await json("PATCH", `/events/${row.eventKey}`, { title: "Edited title", capacity })
        : await browser(`/events/${row.eventKey}`, form(capacity === null ? "" : String(capacity)));
      expect(response.status).toBe(path === "json" ? 200 : 303);
      expect(await getEvent(fixture.db, row.eventKey)).toMatchObject({ title: "Edited title", capacity });
      // Main settles the waitlist after accepted edits; only free seats promote.
      expect((await state(row.eventKey)).answers).toEqual(answers.map((answer) =>
        answer.status === "waitlisted" && capacity !== 5
          ? { ...answer, status: "going", syncedToDiscordAt: null, updatedAt: NOW }
          : answer,
      ));
      expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
      expect(sent.at(-1)).toMatchObject({ kind: "sync-event", eventKey: row.eventKey });
    }
  });

  it("a title-only JSON PATCH preserves finite capacity", async () => {
    const row = await occupied();
    expect((await json("PATCH", `/events/${row.eventKey}`, { title: "Renamed" })).status).toBe(200);
    expect(await getEvent(fixture.db, row.eventKey)).toMatchObject({ title: "Renamed", capacity: 8 });
  });

  it("recounts the floor for a form opened before a member joined", async () => {
    const row = await occupied();
    const staleInput = input(row, 5);
    expect((await json("PUT", `/events/${row.eventKey}/rsvp`, { status: "going" }, "late-member")).status).toBe(201);
    sent.length = 0;
    const before = await state(row.eventKey);
    // The join also settles the waiting head: five original seats plus two new Going.
    expect(before.answers.filter((answer) => answer.status === "going")).toHaveLength(7);
    await expect(updateEvent(fixture.db, ACTOR, row.eventKey, staleInput)).rejects.toMatchObject({
      fields: { capacity: "Capacity cannot be lower than the number of members already going. Occupied seats: 7." },
    });
    expect(await state(row.eventKey)).toEqual(before);
    expect(sent).toEqual([]);
  });

  // Observe actual blocking rather than guessing with a sleep. performance's
  // real clock bounds failure even while the application Date is frozen.
  async function waitForEventLock(): Promise<void> {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const [waiting] = await fixture.client<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from "events"%for update%'`;
      if (waiting!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("event mutation did not wait on the event row lock");
  }
  async function holdEvent(id: number) {
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const holder = fixture.client.begin(async (tx) => {
      await tx`select id from events where id = ${id} for update`;
      ready();
      await held;
    });
    await Promise.race([locked, holder]);
    return { release, holder };
  }

  it("checks the clock after waiting for the event lock, not at request entry", async () => {
    const row = await seed({ endsAt: new Date(NOW.getTime() + 1) });
    const before = await state(row.eventKey);
    const lock = await holdEvent(row.id);
    const pending = json("POST", `/events/${row.eventKey}/publish`);
    try {
      await waitForEventLock();
      vi.setSystemTime(new Date(NOW.getTime() + 2));
    } finally { lock.release(); await lock.holder; }
    const response = await pending;
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid", fields: { ends_at: ENDED } });
    expect(await state(row.eventKey)).toEqual(before);
    expect(sent).toEqual([]);
  });

  it("reads persisted end time after a concurrent edit commits, not a stale draft snapshot", async () => {
    const row = await seed();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const holder = fixture.client.begin(async (tx) => {
      await tx`update events set ends_at = ${new Date(NOW.getTime() - 1).toISOString()}::timestamptz where id = ${row.id}`;
      ready();
      await held;
    });
    await Promise.race([readyPromise, holder]);
    const pending = json("POST", `/events/${row.eventKey}/publish`);
    try { await waitForEventLock(); } finally { release(); await holder; }
    expect((await pending).status).toBe(422);
    expect(await getEvent(fixture.db, row.eventKey)).toMatchObject({ status: "draft", updatedAt: row.updatedAt });
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("locks before counting: an edit queued behind a new going answer cannot strand the seat", async () => {
    const row = await occupied();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const holder = fixture.client.begin(async (tx) => {
      // The same lock/order as RSVP: commit a seat while the edit is queued.
      await tx`select id from events where id = ${row.id} for update`;
      await tx`insert into rsvps (event_id, user_id, status) values (${row.id}, 'concurrent-member', 'going')`;
      ready();
      await held;
    });
    await Promise.race([readyPromise, holder]);
    // Attach the rejection handler immediately so a failed lock assertion still
    // releases the holder and cannot produce an unhandled promise rejection.
    const pending = updateEvent(fixture.db, ACTOR, row.eventKey, input(row, 5)).catch((error: unknown) => error);
    try { await waitForEventLock(); } finally { release(); await holder; }
    const result = await pending;
    expect(result).toBeInstanceOf(ValidationError);
    expect(result).toMatchObject({ fields: { capacity: "Capacity cannot be lower than the number of members already going. Occupied seats: 6." } });
    // The concurrent RSVP legitimately dirties the sync revision and ICS sequence; the refused edit changed nothing else.
    const { syncRevision: _r, syncedRevision: _s, icsSequence: _i, ...unchanged } = row;
    expect(await getEvent(fixture.db, row.eventKey)).toMatchObject(unchanged);
    expect(await fixture.db.select().from(rsvps).where(eq(rsvps.eventId, row.id))).toHaveLength(9);
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(sent).toEqual([]);
  });
});
