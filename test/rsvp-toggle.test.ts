// route-inventory: POST /events/:key/rsvp-pause
// route-inventory: POST /events/:key/rsvp-reopen
// route-inventory: POST /admin/events/:key/rsvp-pause
// route-inventory: POST /admin/events/:key/rsvp-reopen
// Moderator pause/reopen uses the member RSVP lock and the existing sync seam.
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { setRsvpOpen } from "../src/admin/store";
import { newEventKey, ValidationError } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { uniqueKey } from "../src/jobs/sync-event";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Keep the tracked producer real; native clients must stay in the owned schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});
type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const store = createMemorySessionStore();
const baseEnv = {
  APP_URL,
  SESSION_SECRET,
  SESSION_STORE: store,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as Env;
const actor = { id: "100000000000000111", username: "mod" };

async function cookie(moderator = true) {
  const token = newSessionToken();
  const userId = moderator ? actor.id : "toggle-member";
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

const paths = [
  "/events/abc/rsvp-pause",
  "/events/abc/rsvp-reopen",
  "/admin/events/abc/rsvp-pause",
  "/admin/events/abc/rsvp-reopen",
];

describe("RSVP toggle guards (no database)", () => {
  it("keeps guest, member and origin conventions on both route families", async () => {
    for (const path of paths) {
      const guest = await app.request(
        path,
        { method: "POST", headers: { origin: APP_URL } },
        baseEnv,
      );
      expect((await app.request(path, { method: "POST" }, baseEnv)).status, path).toBe(403);
      expect(guest.status, path).toBe(path.startsWith("/admin/") ? 303 : 401);
      if (path.startsWith("/admin/")) {
        expect(guest.headers.get("location")).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
      }
      expect(
        (
          await app.request(
            path,
            { method: "POST", headers: { cookie: await cookie(false), origin: APP_URL } },
            baseEnv,
          )
        ).status,
        path,
      ).toBe(403);
      expect(
        (
          await app.request(
            path,
            { method: "POST", headers: { cookie: await cookie(), origin: "https://evil.test" } },
            baseEnv,
          )
        ).status,
        path,
      ).toBe(403);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "RSVP pause/reopen (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let realPostgres: typeof postgres;
    const sent: SyncEventMessage[] = [];
    const env = {
      ...baseEnv,
      get ADMIN_DB() {
        return fixture.db;
      },
      get DB() {
        return { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href };
      },
      SYNC_EVENT_QUEUE: {
        send: async (m: SyncEventMessage, options?: { delaySeconds?: number }) => {
          expect(options).toEqual({ delaySeconds: 10 });
          sent.push(m);
        },
      },
    } as unknown as Env;
    beforeAll(async () => {
      realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
      vi.mocked(postgres).mockImplementation(realPostgres);
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 10 });
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
      await fixture.client`delete from web_throttle_hits`;
      await completeQueuedDeliveries();
      sent.length = 0;
    });
    afterAll(async () => {
      if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
      await fixture?.dispose();
    });

    async function completeQueuedDeliveries() {
      // Model completed deliveries, not just an empty queue-double capture: the
      // tracked producer's unique lock otherwise absorbs the next logical write.
      await fixture.client`delete from queue_jobs`;
      await fixture.client`delete from job_unique_locks`;
    }

    async function assertTracked(eventKey: string) {
      const delivery = sent.at(-1)!;
      expect(delivery).toEqual({
        kind: "sync-event",
        eventKey,
        idempotencyKey: expect.any(String),
        jobId: expect.any(String),
        leaseToken: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        requestId: expect.any(String),
      });
      const [job] =
        await fixture.client`select job_id, kind, key, available_at > created_at as delayed from queue_jobs`;
      expect(job).toEqual({
        job_id: delivery.jobId,
        kind: "sync-event",
        key: uniqueKey(eventKey),
        delayed: true,
      });
      expect(await fixture.client`select key, owner_token from job_unique_locks`).toEqual([
        { key: uniqueKey(eventKey), owner_token: delivery.leaseToken },
      ]);
    }

    const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
      const [row] = await fixture.db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Toggle night",
          startsAt: new Date("2099-01-01T20:00:00Z"),
          endsAt: new Date("2099-01-01T22:00:00Z"),
          status: "published",
          ...over,
        })
        .returning();
      return row!;
    };
    const request = async (path: string, method = "POST", moderator = true, body?: unknown) =>
      app.request(
        path,
        {
          method,
          headers: {
            cookie: await cookie(moderator),
            origin: APP_URL,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    const audits = () => fixture.db.select().from(activityLog);

    it("pauses idempotently, preserves answers, returns paused, and reopens member writes", async () => {
      const row = await seed();
      const path = `/events/${row.eventKey}`;
      expect((await request(`${path}/rsvp`, "PUT", false, { status: "going" })).status).toBe(201);
      await completeQueuedDeliveries();
      sent.length = 0;
      const pause = await request(`${path}/rsvp-pause`);
      expect(pause.status).toBe(200);
      expect(await pause.json()).toMatchObject({
        data: { event_key: row.eventKey, status: "published", rsvp_open: false, going_count: 1 },
      });
      const paused = await request(`${path}/rsvp`, "PUT", false, { status: "maybe" });
      expect(paused.status).toBe(403);
      expect(await paused.json()).toMatchObject({ reason: "event_not_open", why: "paused" });
      expect((await fixture.db.select().from(rsvps)).map((r) => r.status)).toEqual(["going"]);
      const [beforeRepeat] = await fixture.db.select().from(events);
      const repeatPause = await request(`${path}/rsvp-pause`);
      expect(repeatPause.status).toBe(200);
      expect(await repeatPause.json()).toMatchObject({
        data: { rsvp_open: false, going_count: 1 },
      });
      const [afterRepeat] = await fixture.db.select().from(events);
      expect(afterRepeat!.updatedAt).toEqual(beforeRepeat!.updatedAt);
      expect(sent).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      await assertTracked(row.eventKey);
      await completeQueuedDeliveries();
      const reopen = await request(`${path}/rsvp-reopen`);
      expect(reopen.status).toBe(200);
      expect(await reopen.json()).toMatchObject({
        data: { rsvp_open: true, status: "published", going_count: 1 },
      });
      const repeatReopen = await request(`${path}/rsvp-reopen`);
      expect(repeatReopen.status).toBe(200);
      expect(await repeatReopen.json()).toMatchObject({
        data: { rsvp_open: true, going_count: 1 },
      });
      expect(sent).toHaveLength(2);
      expect(sent.every((m) => m.eventKey === row.eventKey && m.kind === "sync-event")).toBe(true);
      await assertTracked(row.eventKey);
      expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
      expect((await audits()).map((a) => a.properties)).toEqual([
        { rsvpOpen: { before: true, after: false } },
        { rsvpOpen: { before: false, after: true } },
      ]);
      expect((await request(`${path}/rsvp`, "PUT", false, { status: "maybe" })).status).toBe(200);
    });

    it("counts only this event's going answers, including zero, on changed and no-op responses", async () => {
      const row = await seed({ capacity: 2 });
      const other = await seed();
      await fixture.db
        .insert(rsvps)
        .values([
          ...["maybe", "not_going"].map((status) => ({ eventId: row.id, userId: status, status })),
          { eventId: other.id, userId: "other-going", status: "going" },
        ]);
      for (const action of ["rsvp-pause", "rsvp-pause", "rsvp-reopen", "rsvp-reopen"]) {
        const res = await request(`/events/${row.eventKey}/${action}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ data: { going_count: 0 } });
      }
      await fixture.db.insert(rsvps).values([
        { eventId: row.id, userId: "going-1", status: "going" },
        { eventId: row.id, userId: "going-2", status: "going" },
        { eventId: row.id, userId: "waiting", status: "waitlisted" },
      ]);
      for (const action of ["rsvp-pause", "rsvp-pause", "rsvp-reopen", "rsvp-reopen"]) {
        const res = await request(`/events/${row.eventKey}/${action}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ data: { going_count: 2 } });
      }
    });

    it.each(["/events", "/admin/events"])(
      "%s reopens the frozen FIFO line and syncs promoted answers once",
      async (prefix) => {
        const row = await seed({ capacity: 1 });
        const stamp = new Date("2026-01-01T00:00:00Z");
        await fixture.db.insert(rsvps).values([
          { eventId: row.id, userId: "toggle-member", status: "going" },
          {
            eventId: row.id,
            userId: "first",
            status: "waitlisted",
            createdAt: stamp,
            syncedToDiscordAt: stamp,
          },
          {
            eventId: row.id,
            userId: "second",
            status: "waitlisted",
            createdAt: new Date(stamp.getTime() + 1000),
            syncedToDiscordAt: stamp,
          },
        ]);
        expect((await request(`${prefix}/${row.eventKey}/rsvp-pause`)).status).toBe(
          prefix === "/events" ? 200 : 303,
        );
        expect((await request(`/events/${row.eventKey}/rsvp`, "DELETE", false)).status).toBe(204);
        expect(
          (await fixture.db.select().from(rsvps)).every((r) => r.status === "waitlisted"),
        ).toBe(true);
        await completeQueuedDeliveries();
        sent.length = 0;
        const reopen = await request(`${prefix}/${row.eventKey}/rsvp-reopen`);
        expect(reopen.status).toBe(prefix === "/events" ? 200 : 303);
        if (prefix === "/events")
          expect(await reopen.json()).toMatchObject({ data: { going_count: 1, rsvp_open: true } });
        const answers = await fixture.db.select().from(rsvps);
        expect(answers.find((r) => r.userId === "first")).toMatchObject({
          status: "going",
          syncedToDiscordAt: null,
        });
        expect(answers.find((r) => r.userId === "second")).toMatchObject({
          status: "waitlisted",
          syncedToDiscordAt: stamp,
        });
        const repeat = await request(`${prefix}/${row.eventKey}/rsvp-reopen`);
        expect(repeat.status).toBe(prefix === "/events" ? 200 : 303);
        expect(await fixture.db.select().from(rsvps)).toEqual(answers);
        expect(sent).toHaveLength(1);
        await assertTracked(row.eventKey);
        expect(await audits()).toHaveLength(2);
      },
    );

    it("refuses draft, cancelled, past and clock-ended events, including already-satisfied targets", async () => {
      for (const over of [
        { status: "draft" },
        { status: "cancelled" },
        { status: "past" },
        { endsAt: new Date("2020-01-01T22:00:00Z") },
      ]) {
        const row = await seed(over);
        for (const action of ["rsvp-pause", "rsvp-reopen"]) {
          const json = await request(`/events/${row.eventKey}/${action}`);
          expect(json.status).toBe(422);
          expect(await json.json()).toMatchObject({
            error: "invalid",
            fields: { rsvp_open: expect.any(String) },
          });
          const admin = await request(`/admin/events/${row.eventKey}/${action}`);
          expect(admin.status).toBe(422);
          expect(await admin.text()).toContain("Only published events that have not ended");
        }
      }
      const boundary = await seed();
      await expect(
        setRsvpOpen(fixture.db, actor, boundary.eventKey, false, () => boundary.endsAt),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await audits()).toHaveLength(0);
      expect(sent).toHaveLength(0);
      for (const path of paths) expect((await request(path)).status).toBe(404);
    });

    it("refuses reopening when a promotion-row lock wait crosses the event end", async () => {
      const row = await seed({ rsvpOpen: false, capacity: 1 });
      await fixture.db
        .insert(rsvps)
        .values({ eventId: row.id, userId: "waiting", status: "waitlisted" });
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = fixture.client.begin(async (tx) => {
        await tx`select id from rsvps where event_id = ${row.id} for update`;
        const [backend] = await tx`select pg_backend_pid() as pid`;
        ready(Number(backend!.pid));
        await gate;
      });
      let expired = false;
      let pending: Promise<unknown> | undefined;
      try {
        const pid = await acquired;
        pending = setRsvpOpen(fixture.db, actor, row.eventKey, true, () =>
          expired ? row.endsAt : new Date(),
        ).catch((error: unknown) => error);
        const deadline = Date.now() + 5000;
        let blocked = false;
        do {
          const waiting =
            await fixture.client`select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and ${pid} = any(pg_blocking_pids(pid))`;
          if (waiting.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (Date.now() < deadline);
        expect(blocked).toBe(true);
        expired = true;
      } finally {
        release();
        await holder;
        await pending;
      }
      expect(await pending).toBeInstanceOf(ValidationError);
      expect((await fixture.db.select().from(events))[0]!.rsvpOpen).toBe(false);
      expect((await fixture.db.select().from(rsvps))[0]!.status).toBe("waitlisted");
      expect(await audits()).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it("serializes concurrent identical toggles into one audit and one dispatch", async () => {
      const row = await seed();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => request(`/events/${row.eventKey}/rsvp-pause`)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(sent).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
    });

    it("admin actions redirect and both pages show the current action only for eligible events", async () => {
      const row = await seed();
      const get = async (path: string) => (await request(path, "GET")).text();
      expect(await get(`/admin/events/${row.eventKey}`)).toContain(
        `action="/admin/events/${row.eventKey}/rsvp-pause"`,
      );
      expect(await get("/admin/events")).toContain(
        `action="/admin/events/${row.eventKey}/rsvp-pause"`,
      );
      const pause = await request(`/admin/events/${row.eventKey}/rsvp-pause`);
      expect(pause.status).toBe(303);
      expect(pause.headers.get("location")).toBe(`/admin/events/${row.eventKey}`);
      const edit = await get(`/admin/events/${row.eventKey}`);
      expect(edit).toContain("Reopen RSVPs");
      expect(edit).not.toContain("Pause RSVPs");
      expect(await get("/admin/events")).toContain(
        `action="/admin/events/${row.eventKey}/rsvp-reopen"`,
      );
      expect((await request(`/admin/events/${row.eventKey}/rsvp-pause`)).status).toBe(303);
      expect(sent).toHaveLength(1);
      await completeQueuedDeliveries();
      expect((await request(`/admin/events/${row.eventKey}/rsvp-reopen`)).status).toBe(303);
      expect(sent).toHaveLength(2);
      for (const over of [
        { status: "draft" },
        { status: "cancelled" },
        { status: "past" },
        { endsAt: new Date("2020-01-01T22:00:00Z") },
      ]) {
        const hidden = await seed(over);
        expect(await get(`/admin/events/${hidden.eventKey}`)).not.toMatch(/\/rsvp-(pause|reopen)/);
        expect(await get("/admin/events")).not.toMatch(
          new RegExp(`${hidden.eventKey}/rsvp-(pause|reopen)`),
        );
      }
    });

    it("filters open, paused and all, composing RSVP state with search and status", async () => {
      await seed({ title: "Chess open" });
      await seed({ title: "Chess paused", rsvpOpen: false });
      await seed({ title: "Chess draft", status: "draft", rsvpOpen: false });
      await seed({ title: "Poker paused", rsvpOpen: false });
      const titles = async (query: string) => {
        const html = await (await request(`/admin/events${query}`, "GET")).text();
        return {
          html,
          values: [...html.matchAll(/<a href="\/admin\/events\/[^\"]+">([^<]+)<\/a>/g)].map(
            (m) => m[1],
          ),
        };
      };
      expect((await titles("?rsvp_open=1")).values).toEqual(["Chess open"]);
      expect((await titles("?rsvp_open=0")).values.sort()).toEqual([
        "Chess draft",
        "Chess paused",
        "Poker paused",
      ]);
      const combined = await titles("?rsvp_open=0&status=published&q=Chess");
      expect(combined.values).toEqual(["Chess paused"]);
      expect(combined.html).toContain('value="0" selected');
      expect((await titles("?rsvp_open=")).values).toHaveLength(4);
      expect((await titles("?rsvp_open=bogus")).values).toHaveLength(4);
    });
  },
);
