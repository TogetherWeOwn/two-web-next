import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { createEvent, updateEvent } from "../src/admin/store";
import type { EventFormInput } from "../src/admin/validation";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { buildSyncMessage, enqueueEventSync } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { reconcileEvents } from "../src/jobs/cron";
import { trackingQueue } from "../src/jobs/ledger";
import { BotTransportError } from "../src/jobs/types";
import { pgQueueLedger, pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";
import { uniqueKey } from "../src/jobs/sync-event";
import type { BotClient, QueueMessage } from "../src/jobs/types";
import { enqueueSyncEvent, handleQueue } from "../src/jobs/worker";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

// Only transport and pool construction are substituted. The real web routes,
// dispatch, ledger, unique locks, event-store queries and consumer all execute.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const fields = { title: "Edited night", starts_at: "2099-11-04 20:00", ends_at: "2099-11-04 22:00", timezone: "UTC", location: "Voice" };
type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;

function delivery(body: SyncEventMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe.skipIf(!process.env.DATABASE_URL)("event write-back through W13 (test container)", () => {
  let fixture: MemberDataFixture | undefined;
  let sql: postgres.Sql;
  let realPostgres: typeof postgres;
  let env: Env;
  let sessions: ReturnType<typeof createMemorySessionStore>;
  let sent: { body: SyncEventMessage; options?: { delaySeconds?: number } }[];

  beforeEach(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    fixture = await createMemberDataFixture(url.href);
    const schemaName = fixture.schemaName;
    const options = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password,
      connection: { search_path: schemaName }, onnotice: () => {} };
    // Native job Date serializers, separate from the Drizzle-owned client.
    sql = realPostgres(url.href, options);
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
      testDatabaseUrl(raw);
      return realPostgres(raw, { ...opts, ...options });
    }) as typeof postgres);
    sent = [];
    sessions = createMemorySessionStore();
    env = {
      APP_URL, SESSION_SECRET, DISCORD_CLIENT_ID: "test", DISCORD_CLIENT_SECRET: "test",
      DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: "test", DISCORD_INVITE_URL: "https://discord.gg/test",
      DB: { connectionString: url.href },
      SYNC_EVENT_QUEUE: { send: async (body, options) => { sent.push({ body: body as SyncEventMessage, options }); return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }; } },
      ADMIN_DB: fixture.db, SESSION_STORE: sessions,
    } as Env;
  });
  afterEach(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await sql?.end({ timeout: 1 });
    await fixture?.dispose();
    fixture = undefined;
  });

  async function cookie(moderator = true) {
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId: "test-user", username: "test-user",
      avatar: null, member: true, moderator, expiresAt: new Date(Date.now() + 3600_000) });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET,
      { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  }
  async function seed(status = "published") {
    const [row] = await sql`insert into events (event_key, title, starts_at, ends_at, location, status)
      values (${eventKey}, 'Game night', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z', 'Voice', ${status}) returning id`;
    return row!.id as number;
  }
  async function request(method: string, path: string, body?: Record<string, string>, form = false, moderator = true) {
    return app.request(path, { method, headers: { cookie: await cookie(moderator), origin: APP_URL,
      accept: form ? "text/html" : "application/json",
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) }, env);
  }
  async function assertTracked() {
    expect(sent).toHaveLength(1);
    const { body, options } = sent[0]!;
    expect(body).toEqual({ kind: "sync-event", eventKey, idempotencyKey: expect.any(String), jobId: expect.any(String) });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options).toEqual({ delaySeconds: 10 });
    const rows = await sql`select job_id, key, available_at > created_at as delayed from queue_jobs`;
    expect(rows).toEqual([{ job_id: body.jobId, key: uniqueKey(eventKey), delayed: true }]);
    expect(await sql`select key from job_unique_locks`).toEqual([{ key: uniqueKey(eventKey) }]);
    return body;
  }
  function botDouble() {
    return {
      upsertEvent: vi.fn<BotClient["upsertEvent"]>(async (..._args) => ({ ok: true as const, requestId: null, discordEventId: "discord-1" })),
      cancelEvent: vi.fn<BotClient["cancelEvent"]>(async (..._args) => ({ ok: true as const, requestId: null, discordEventId: "discord-1" })),
      postAnnouncement: vi.fn(), assignRole: vi.fn(),
    } satisfies BotClient;
  }
  const makeDue = () => sql`update event_sync_attempts set next_attempt_at = now() - interval '1 second' where state = 'pending'`;
  const deps = (bot: BotClient) => ({ bot, events: pgEventStore(sql), lock: pgUniqueLock(sql), ledger: pgQueueLedger(sql),
    dispatchPending: (key: string) => enqueueSyncEvent(env, buildSyncMessage(key, "published")!),
  });

  for (const mode of ["admin", "json"] as const) {
    for (const operation of ["publish", "cancel", "edit", "draft-edit"] as const) {
      it(`${mode} ${operation} uses one tracked message (drafts use none)`, async () => {
        await seed(operation === "publish" || operation === "draft-edit" ? "draft" : "published");
        const edit = operation === "edit" || operation === "draft-edit";
        const path = `${mode === "admin" ? "/admin" : ""}/events/${eventKey}${edit ? "" : `/${operation}`}`;
        const response = await request(mode === "admin" || !edit ? "POST" : "PATCH", path,
          edit ? (mode === "admin" ? fields : { title: fields.title }) : undefined, mode === "admin");
        expect(response.status).toBe(mode === "admin" ? 303 : 200);
        if (operation === "draft-edit") {
          expect(sent).toHaveLength(0);
          expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
          expect(await sql`select key from job_unique_locks`).toHaveLength(0);
          return;
        }
        const body = await assertTracked();
        const bot = botDouble();
        const m = delivery(body);
        await consume({ messages: [m] }, deps(bot));
        expect(m.ack).toHaveBeenCalledOnce();
        expect(bot.cancelEvent).toHaveBeenCalledTimes(operation === "cancel" ? 1 : 0);
        expect(bot.upsertEvent).toHaveBeenCalledTimes(operation === "cancel" ? 0 : 1);
      });
    }
  }

  for (const operation of ["answer", "re-answer", "withdraw"] as const) {
    it(`RSVP ${operation} dispatches exactly one tracked message`, async () => {
      const id = await seed();
      if (operation !== "answer") await sql`insert into rsvps (event_id, user_id, status) values (${id}, 'test-user', 'going')`;
      const response = await request(operation === "withdraw" ? "DELETE" : "PUT", `/events/${eventKey}/rsvp`,
        operation === "withdraw" ? undefined : { status: "maybe" }, false, false);
      expect(response.status).toBe(operation === "withdraw" ? 204 : operation === "answer" ? 201 : 200);
      await assertTracked();
    });
  }

  it("a concurrent edit burst collapses to one bot call with the latest row", async () => {
    await seed();
    await Promise.all(Array.from({ length: 12 }, () => enqueueEventSync(env, eventKey, "published")));
    await sql`update events set title = 'Latest edit' where event_key = ${eventKey}`;
    const body = await assertTracked();
    const bot = botDouble();
    await consume({ messages: [delivery(body)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "Latest edit" }), body.idempotencyKey);
    expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
    expect(await sql`select key from job_unique_locks`).toHaveLength(0);
    // A later mutation can dispatch again after terminal consumption.
    await enqueueEventSync(env, eventKey, "published");
    expect(sent).toHaveLength(2);
  });

  it("publish then cancel during debounce selects cancel at send time, with the built key", async () => {
    await seed();
    const built = buildSyncMessage(eventKey, "published")!;
    await enqueueSyncEvent(env, built);
    await sql`update events set status = 'cancelled' where event_key = ${eventKey}`;
    await enqueueEventSync(env, eventKey, "cancelled");
    const body = await assertTracked();
    expect(body.idempotencyKey).toBe(built.idempotencyKey);
    const bot = botDouble();
    await consume({ messages: [delivery(body)] }, deps(bot));
    expect(bot.cancelEvent).toHaveBeenCalledExactlyOnceWith({ eventKey }, built.idempotencyKey);
    expect(bot.upsertEvent).not.toHaveBeenCalled();
  });

  it("the actual worker drops a row changed to draft before consumption", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const body = await assertTracked();
    await sql`update events set status = 'draft' where event_key = ${eventKey}`;
    const m = delivery(body);
    await handleQueue({ messages: [m] } as unknown as MessageBatch<unknown>, env as import("../src/env").JobsEnv);
    // The unwired bot would throw/retry if this reached it.
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
  });

  it("a rejected queue send compensates ledger and unique lock", async () => {
    const send = vi.fn(async () => { throw new Error("transport down"); });
    const failing = { ...env, SYNC_EVENT_QUEUE: { send } };
    await expect(enqueueSyncEvent(failing, buildSyncMessage(eventKey, "published")!)).rejects.toThrow("transport down");
    expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
    expect(await sql`select key from job_unique_locks`).toHaveLength(0);
    await enqueueEventSync(env, eventKey, "published");
    await assertTracked();
  });

  it("cancellation committed during an upsert gets a new successor request", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    const bot = botDouble();
    bot.upsertEvent.mockImplementationOnce(async () => {
      expect((await request("POST", `/events/${eventKey}/cancel`)).status).toBe(200);
      expect(sent).toHaveLength(1); // old unique lock absorbs the notification
      return { ok: true, requestId: null, discordEventId: "discord-1" };
    });
    const first = delivery(original);
    await consume({ messages: [first] }, deps(bot));
    expect(first.ack).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([eventKey]);
    const successor = sent[1]!.body;
    expect(successor.idempotencyKey).not.toBe(original.idempotencyKey);
    await consume({ messages: [delivery(successor)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    expect(bot.cancelEvent).toHaveBeenCalledExactlyOnceWith({ eventKey }, successor.idempotencyKey);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
    await consume({ messages: [delivery(original, 2)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledOnce(); // settled late redelivery is a no-op
  });

  for (const operation of ["edit", "cancel", "withdraw"] as const) {
    it(`reconciliation recovers ${operation} after a carrier failure`, async () => {
      const id = await seed();
      await sql`insert into rsvps (event_id, user_id, status, synced_to_discord_at)
        values (${id}, 'test-user', 'going', now())`;
      await sql`update events set discord_event_id = 'discord-1', synced_revision = sync_revision where id = ${id}`;
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
      const carrier = env.SYNC_EVENT_QUEUE;
      env.SYNC_EVENT_QUEUE = { send: async () => { throw new Error("transport down"); } };
      const response = operation === "edit"
        ? await request("PATCH", `/events/${eventKey}`, { title: "Recovered title" })
        : operation === "cancel" ? await request("POST", `/events/${eventKey}/cancel`)
        : await request("DELETE", `/events/${eventKey}/rsvp`, undefined, false, false);
      expect(response.status).toBe(operation === "withdraw" ? 204 : 200);
      env.SYNC_EVENT_QUEUE = carrier;
      expect(sent).toEqual([]);
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await sql`select key from job_unique_locks`).toEqual([]);
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([eventKey]);
      const reconciled = await reconcileEvents({ events: pgEventStore(sql),
        queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
      expect(reconciled.resynced).toBe(1);
      const bot = botDouble();
      await consume({ messages: [delivery(sent[0]!.body)] }, deps(bot));
      expect(bot.cancelEvent).toHaveBeenCalledTimes(operation === "cancel" ? 1 : 0);
      expect(bot.upsertEvent).toHaveBeenCalledTimes(operation === "cancel" ? 0 : 1);
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
      if (operation === "withdraw") expect(await sql`select id from rsvps`).toEqual([]);
    });
  }

  it("lost-response retries keep the original payload/key, then deliver an edit with a new key", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    const applied: string[] = [];
    const requests: { name: string; key: string }[] = [];
    const seen = new Set<string>();
    const bot: BotClient = { ...botDouble(), upsertEvent: async (payload, key) => {
      requests.push({ name: payload.name, key });
      if (!seen.has(key)) {
        seen.add(key);
        applied.push(payload.name);
        if (key === original.idempotencyKey) throw new BotTransportError("response lost after apply");
      }
      return { ok: true, requestId: null, discordEventId: "discord-1" };
    } };
    const first = delivery(original);
    await consume({ messages: [first] }, deps(bot));
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect((await request("PATCH", `/events/${eventKey}`, { title: "Changed title" })).status).toBe(200);
    expect(sent).toHaveLength(1);
    await makeDue(); // the transport delivers only after the persisted delay
    await consume({ messages: [delivery(original, 2)] }, deps(bot));
    expect(requests).toEqual([{ name: "Game night", key: original.idempotencyKey },
      { name: "Game night", key: original.idempotencyKey }]);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([eventKey]);
    const successor = sent[1]!.body;
    expect(successor.idempotencyKey).not.toBe(original.idempotencyKey);
    await consume({ messages: [delivery(successor)] }, deps(bot));
    expect(applied).toEqual(["Game night", "Changed title"]);
    expect(requests[2]).toEqual({ name: "Changed title", key: successor.idempotencyKey });
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
  });

  it("retries cannot overtake an older pending request after the debounce lock expires", async () => {
    await seed();
    const bot = botDouble();
    bot.upsertEvent.mockImplementationOnce(async () => { throw new BotTransportError("lost response"); });
    await enqueueEventSync(env, eventKey, "published");
    const first = sent[0]!.body;
    await consume({ messages: [delivery(first)] }, deps(bot));
    await sql`update job_unique_locks set expires_at = now() - interval '1 second'`;
    expect((await request("PATCH", `/events/${eventKey}`, { title: "Later title" })).status).toBe(200);
    const second = sent[1]!.body;
    const waiting = delivery(second);
    await consume({ messages: [waiting] }, deps(bot));
    expect(waiting.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    await makeDue();
    await consume({ messages: [delivery(first, 2)] }, deps(bot));
    await consume({ messages: [delivery(second, 2)] }, deps(bot));
    expect(bot.upsertEvent.mock.calls.map((call) => (call[0] as { name: string }).name))
      .toEqual(["Game night", "Game night", "Later title"]);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
  });

  it("reconciliation recovers a stranded pending snapshot with its original key", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    const bot = botDouble();
    bot.upsertEvent.mockImplementationOnce(async () => { throw new BotTransportError("response lost"); });
    await consume({ messages: [delivery(original)] }, deps(bot));
    await sql`update events set title = 'Newer revision' where event_key = ${eventKey}`;
    await makeDue();
    await sql`update job_unique_locks set expires_at = now() - interval '1 second'`;
    await reconcileEvents({ events: pgEventStore(sql),
      queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
    expect(sent[1]!.body.idempotencyKey).toBe(original.idempotencyKey);
    await consume({ messages: [delivery(sent[1]!.body)] }, deps(bot));
    expect(bot.upsertEvent.mock.calls[1]).toEqual([expect.objectContaining({ name: "Game night" }), original.idempotencyKey]);
    await consume({ messages: [delivery(sent[2]!.body)] }, deps(bot));
    expect(bot.upsertEvent.mock.calls[2]).toEqual([expect.objectContaining({ name: "Newer revision" }), sent[2]!.body.idempotencyKey]);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
  });

  for (const failure of ["lost-response", "local-completion"] as const) {
    it(`${failure} exhaustion settles the carrier but preserves the unresolved request and ordering`, async () => {
      await seed();
      await enqueueEventSync(env, eventKey, "published");
      const original = sent[0]!.body;
      const seen = new Set<string>();
      const bot = botDouble();
      bot.upsertEvent.mockImplementation(async (_payload, key) => {
        seen.add(key); // idempotent remote double: one application per key
        if (failure === "lost-response") throw new BotTransportError("applied, response lost");
        return { ok: true, requestId: null, discordEventId: "discord-1" };
      });
      const dependencies = deps(bot);
      if (failure === "local-completion") dependencies.events.completeSync = async () => { throw new Error("local commit unavailable"); };
      for (let attempt = 1; attempt <= 6; attempt++) {
        if (attempt > 1) await makeDue();
        const m = delivery(original, attempt);
        await consume({ messages: [m] }, dependencies);
        expect(m.ack).toHaveBeenCalledTimes(attempt === 6 ? 1 : 0);
      }
      const pending = await pgEventStore(sql).pendingSync(eventKey);
      expect(pending).toMatchObject({ idempotencyKey: original.idempotencyKey, state: "pending", requestAttempts: 6, nextAttemptAt: null });
      expect(seen.size).toBe(1);
      expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
      expect(await sql`select job_id from queue_failed_jobs`).toHaveLength(1);
      await sql`update events set title = 'Newer revision' where event_key = ${eventKey}`;
      for (let pass = 0; pass < 3; pass++) await reconcileEvents({ events: pgEventStore(sql),
        queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
      expect(sent).toHaveLength(1); // neither rekeys the unresolved revision nor overtakes it
      const other = delivery({ ...original, jobId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }, 6);
      await consume({ messages: [other] }, deps(bot));
      expect(other.ack).toHaveBeenCalledOnce();
      expect(bot.upsertEvent).toHaveBeenCalledTimes(6);
      // Explicit operator recovery renews only the budget/eligibility, never
      // action/payload/key. No automatic edit/reconcile performs this reset.
      await sql`update event_sync_attempts set request_attempts = 0, next_attempt_at = now() - interval '1 second'
        where idempotency_key = ${original.idempotencyKey}::uuid`;
      bot.upsertEvent.mockResolvedValue({ ok: true, requestId: null, discordEventId: "discord-1" });
      await reconcileEvents({ events: pgEventStore(sql),
        queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
      expect(sent[1]!.body.idempotencyKey).toBe(original.idempotencyKey);
      await consume({ messages: [delivery(sent[1]!.body)] }, deps(bot));
      expect(bot.upsertEvent.mock.calls[6]).toEqual([pending!.payload, original.idempotencyKey]);
      expect(sent[2]!.body.idempotencyKey).not.toBe(original.idempotencyKey);
      await consume({ messages: [delivery(sent[2]!.body)] }, deps(bot));
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
    });
  }

  it("carrier exhaustion before the request cap recovers with the same key and remaining budget", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    const bot = botDouble();
    bot.upsertEvent.mockImplementationOnce(async () => { throw new BotTransportError("response lost"); });
    await consume({ messages: [delivery(original, 6)] }, deps(bot));
    expect(await pgEventStore(sql).pendingSync(eventKey)).toMatchObject({ idempotencyKey: original.idempotencyKey, requestAttempts: 1 });
    await makeDue();
    await reconcileEvents({ events: pgEventStore(sql),
      queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
    expect(sent[1]!.body.idempotencyKey).toBe(original.idempotencyKey);
    await consume({ messages: [delivery(sent[1]!.body)] }, deps(bot));
    expect(await sql`select request_attempts, state from event_sync_attempts`).toEqual([{ request_attempts: 2, state: "succeeded" }]);
  });

  it("definitive refusal suppresses unchanged revision recovery but permits a later edit", async () => {
    const id = await seed();
    await sql`update events set discord_event_id = 'discord-1', synced_revision = sync_revision where id = ${id}`;
    await request("PATCH", `/events/${eventKey}`, { title: "Rejected edit" });
    const bot = botDouble();
    bot.upsertEvent.mockResolvedValueOnce({ ok: false, code: "action_not_allowed", status: 403, requestId: null,
      message: "not allowed", retryable: false, retryAfterSeconds: null });
    await consume({ messages: [delivery(sent[0]!.body)] }, deps(bot));
    for (let pass = 0; pass < 3; pass++) await reconcileEvents({ events: pgEventStore(sql),
      queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
    await enqueueEventSync(env, eventKey, "published"); // even an unchanged producer notification is a no-op
    await consume({ messages: [delivery(sent[1]!.body)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    await request("PATCH", `/events/${eventKey}`, { title: "Allowed newer edit" });
    await consume({ messages: [delivery(sent[2]!.body)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledTimes(2);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
  });

  for (const attempts of [6, 11]) {
    it(`waiting carrier at delivery ${attempts} settles its ledger without retiring the older request`, async () => {
      await seed();
      await enqueueEventSync(env, eventKey, "published");
      const original = sent[0]!.body;
      const bot = botDouble();
      bot.upsertEvent.mockImplementationOnce(async () => { throw new BotTransportError("lost response"); });
      await consume({ messages: [delivery(original)] }, deps(bot));
      await sql`update job_unique_locks set expires_at = now() - interval '1 second'`;
      await request("PATCH", `/events/${eventKey}`, { title: "Waiting newer edit" });
      const waiting = delivery(sent[1]!.body, attempts);
      await consume({ messages: [waiting] }, deps(bot));
      expect(waiting.ack).toHaveBeenCalledOnce();
      expect(waiting.retry).not.toHaveBeenCalled();
      expect(await sql`select job_id from queue_jobs where job_id = ${waiting.body.jobId!}::uuid`).toHaveLength(0);
      expect(await sql`select job_id from queue_failed_jobs where job_id = ${waiting.body.jobId!}::uuid`).toHaveLength(1);
      expect(await pgEventStore(sql).pendingSync(eventKey)).toMatchObject({ idempotencyKey: original.idempotencyKey });
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      await makeDue();
      await consume({ messages: [delivery(original, 2)] }, deps(bot));
      const successor = sent[2]!.body;
      await consume({ messages: [delivery(successor)] }, deps(bot));
      expect(bot.upsertEvent.mock.calls[2]![0].name).toBe("Waiting newer edit");
      expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
    });
  }

  it("long Retry-After persists eligibility and request accounting across reconciliation and new carriers", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    const bot = botDouble();
    bot.upsertEvent.mockResolvedValue({ ok: false, code: "rate_limited", status: 429, requestId: null,
      message: "slow down", retryable: true, retryAfterSeconds: 3600 });
    const before = Date.now();
    await consume({ messages: [delivery(original)] }, deps(bot));
    const pending = (await pgEventStore(sql).pendingSync(eventKey))!;
    expect(pending.requestAttempts).toBe(1);
    expect(pending.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    await sql`update job_unique_locks set expires_at = now() - interval '1 second'`;
    for (const minutes of [10, 20, 30, 50]) await reconcileEvents({ events: pgEventStore(sql),
      queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql),
      now: () => new Date(before + minutes * 60_000) });
    expect(sent).toHaveLength(1);
    const early = delivery(original, 2);
    await consume({ messages: [early] }, deps(bot));
    expect(early.retry.mock.calls[0]![0]!.delaySeconds).toBeGreaterThan(3500);
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    for (let requestAttempt = 2; requestAttempt <= 6; requestAttempt++) {
      await makeDue();
      await sql`update job_unique_locks set expires_at = now() - interval '1 second'`;
      await reconcileEvents({ events: pgEventStore(sql),
        queue: trackingQueue(env.SYNC_EVENT_QUEUE!, pgQueueLedger(sql)), lock: pgUniqueLock(sql) });
      const recovered = sent.at(-1)!.body;
      expect(recovered.idempotencyKey).toBe(original.idempotencyKey);
      await consume({ messages: [delivery(recovered, 1)] }, deps(bot));
      expect((await pgEventStore(sql).pendingSync(eventKey))!.requestAttempts).toBe(requestAttempt);
    }
    expect(bot.upsertEvent).toHaveBeenCalledTimes(6); // carrier attempts=1 never resets request budget
    const last = delivery(original, 2);
    await consume({ messages: [last] }, deps(bot));
    expect(last.ack).toHaveBeenCalledOnce();
    expect(bot.upsertEvent).toHaveBeenCalledTimes(6);
    expect((await pgEventStore(sql).pendingSync(eventKey))!.nextAttemptAt).toBeNull();
  });

  it("redundant queued keys do not send another bot request for a clean revision", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const bot = botDouble();
    await consume({ messages: [delivery(sent[0]!.body)] }, deps(bot));
    await enqueueEventSync(env, eventKey, "published");
    const redundant = delivery(sent[1]!.body);
    await consume({ messages: [redundant] }, deps(bot));
    expect(redundant.ack).toHaveBeenCalledOnce();
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
  });

  it("concurrent carriers share one durable request claim and cannot contact the bot early", async () => {
    await seed();
    await enqueueEventSync(env, eventKey, "published");
    const original = sent[0]!.body;
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const bot = botDouble();
    bot.upsertEvent.mockImplementationOnce(async () => {
      entered();
      await held;
      return { ok: true, requestId: null, discordEventId: "discord-1" };
    });
    const first = delivery(original);
    const consuming = consume({ messages: [first] }, deps(bot));
    await started;
    const duplicate = delivery(original, 2);
    await consume({ messages: [duplicate] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
    expect(duplicate.retry.mock.calls[0]![0]!.delaySeconds).toBeGreaterThan(290);
    expect((await pgEventStore(sql).pendingSync(eventKey))!.requestAttempts).toBe(1);
    finish();
    await consuming;
    expect(first.ack).toHaveBeenCalledOnce();
    await consume({ messages: [delivery(original, 3)] }, deps(bot));
    expect(bot.upsertEvent).toHaveBeenCalledOnce();
  });

  it("recurrence materialization shares the flight transaction without changing native job parsers", async () => {
    await seed();
    await sql`update events set recurrence_frequency = 'weekly', recurrence_count = 3, recurrence_index = 1`;
    await sql.begin(async (tx) => {
      const events = pgEventStore(tx);
      expect(await events.materializeSeries()).toBe(2);
      expect(await events.materializeSeries()).toBe(0);
      expect(await events.closeFinished(new Date())).toBe(0);
      const [row] = await tx`select starts_at from events limit 1`;
      expect(row!.starts_at).toBeInstanceOf(Date);
    });
    expect(await sql`select id from events where status = 'draft'`).toHaveLength(2);
    expect(await sql`select id from activity_log`).toHaveLength(2);
    expect(await pgEventStore(sql).staleEventKeys()).toEqual([eventKey]);
  });

  for (const order of ["cron then edit", "edit then cron", "cron holds lock", "edit holds lock"] as const) {
    it(`recurrence backfill serializes with moderator edits: ${order}`, async () => {
      const db = fixture!.db;
      const actor = { id: "test-user", username: "test-user" };
      const input: EventFormInput = { title: "Bounded weekly series", game: null, description: null,
        startsAtUtc: new Date("2099-01-11T18:00:00Z"), endsAtUtc: new Date("2099-01-11T19:00:00Z"),
        timezone: "UTC", location: "Voice", capacity: null };
      const { row: parent } = await createEvent(db, actor, input,
        { frequency: "weekly", count: 3, endsOn: new Date("2099-01-18T00:00:00Z") });
      expect(await sql`select recurrence_index from events order by recurrence_index`)
        .toEqual([{ recurrence_index: 1 }, { recurrence_index: 2 }]);
      // A normal date edit permits index 3, but only shifts existing children.
      const earlier = { ...input, startsAtUtc: new Date("2099-01-04T18:00:00Z"), endsAtUtc: new Date("2099-01-04T19:00:00Z") };
      await updateEvent(db, actor, parent.eventKey, earlier);
      expect(await sql`select recurrence_index from events order by recurrence_index`)
        .toEqual([{ recurrence_index: 1 }, { recurrence_index: 2 }]);
      const later = { ...earlier, startsAtUtc: new Date("2099-01-04T20:00:00Z"), endsAtUtc: new Date("2099-01-04T21:00:00Z") };
      const flight = pgSingleFlight(sql);
      let cronPid = 0;
      let moderatorPid = 0;
      let holdingPid = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reconcile = (hold = false) => flight("events:reconcile", async (tx) => {
        cronPid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
        expect(await reconcileEvents({ events: pgEventStore(tx),
          queue: env.SYNC_EVENT_QUEUE!, lock: pgUniqueLock(sql) })).toEqual({ closed: 0, materialized: 1, resynced: 0 });
        if (hold) { holdingPid = cronPid; await held; }
      });
      const edit = (hold = false) => db.transaction(async (tx) => {
        moderatorPid = (await tx.execute<{ pid: number }>(drizzleSql`select pg_backend_pid() as pid`))[0]!.pid;
        // The outer transaction holds updateEvent's real parent/child locks
        // after its savepoint returns, without changing the store's queries.
        await updateEvent(tx as unknown as typeof db, actor, parent.eventKey, later);
        if (hold) { holdingPid = moderatorPid; await held; }
      });
      if (order === "cron then edit") { await reconcile(); await edit(); }
      else if (order === "edit then cron") { await edit(); await reconcile(); }
      else {
        const url = testDatabaseUrl(process.env.DATABASE_URL!);
        const observer = realPostgres(url.href, { max: 1, port: 5432, connect_timeout: 5,
          password: () => url.password, connection: { search_path: fixture!.schemaName }, onnotice: () => {} });
        let first: Promise<unknown> | undefined;
        let second: Promise<unknown> | undefined;
        try {
          first = order === "cron holds lock" ? reconcile(true) : edit(true);
          await vi.waitFor(() => expect(holdingPid).toBeGreaterThan(0));
          second = order === "cron holds lock" ? edit() : reconcile();
          // Observe the actual database lock wait, not a sleep or JS scheduling
          // assumption. Without the parent lock, cron instead waits at the FK
          // insert after caching old times; releasing the edit yields a stale child.
          await vi.waitFor(async () => {
            const waitingPid = order === "cron holds lock" ? moderatorPid : cronPid;
            expect(waitingPid).toBeGreaterThan(0);
            const [row] = await observer`select pg_blocking_pids(${waitingPid}) as blockers`;
            expect(row!.blockers).toContain(holdingPid);
          }, { interval: 10, timeout: 2000 });
          release();
          await Promise.all([first, second]);
        } finally {
          release();
          await Promise.allSettled([first, second]);
          await observer.end({ timeout: 1 });
        }
      }
      const rows = await sql`select id, event_key, recurrence_index, starts_at, ends_at, status from events order by recurrence_index`;
      expect(rows.map((row) => ({ index: row.recurrence_index, starts: row.starts_at.toISOString(),
        ends: row.ends_at.toISOString(), status: row.status }))).toEqual([4, 11, 18].map((day, i) => ({
          index: i + 1, starts: `2099-01-${String(day).padStart(2, "0")}T20:00:00.000Z`,
          ends: `2099-01-${String(day).padStart(2, "0")}T21:00:00.000Z`, status: "draft",
        })));
      expect(sent).toHaveLength(0);
      expect(await sql`select causer_id, properties from activity_log
        where subject_id = ${rows[2]!.event_key} and description like 'created event %'`)
        .toEqual([{ causer_id: null, properties: expect.objectContaining({ startsAt: expect.any(Object) }) }]);
      // Native Date serialization/JSON parsing still works after the proxy;
      // another pass is idempotent and cannot hide a permanently stale child.
      await flight("events:reconcile", async (tx) => {
        expect(await reconcileEvents({ events: pgEventStore(tx),
          queue: env.SYNC_EVENT_QUEUE!, lock: pgUniqueLock(sql) })).toEqual({ closed: 0, materialized: 0, resynced: 0 });
      });
      expect(await sql`select id, event_key, recurrence_index, starts_at, ends_at, status from events order by recurrence_index`).toEqual(rows);
    });
  }

  it("event and RSVP revisions roll back with their mutations", async () => {
    const id = await seed();
    const before = await sql`select sync_revision from events where id = ${id}`;
    await expect(sql.begin(async (tx) => {
      await tx`update events set title = 'Never committed' where id = ${id}`;
      await tx`insert into rsvps (event_id, user_id, status) values (${id}, 'test-user', 'going')`;
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await sql`select sync_revision from events where id = ${id}`).toEqual(before);
    expect(await sql`select id from rsvps`).toEqual([]);
  });

  it("mirror stamping does not mark an RSVP written during the bot call as synced", async () => {
    const id = await seed();
    await sql`insert into rsvps (event_id, user_id, status, updated_at) values (${id}, 'test-user', 'going', '2026-01-01')`;
    const cutoff = new Date("2026-01-02T00:00:00Z");
    const events = pgEventStore(sql);
    const attempt = await events.prepareSync(eventKey, crypto.randomUUID(), cutoff);
    if (!attempt || "waiting" in attempt) throw new Error("missing attempt");
    await sql`update rsvps set updated_at = '2026-01-03' where event_id = ${id}`;
    await events.completeSync(attempt, "discord-1");
    expect((await sql`select synced_to_discord_at from rsvps`)[0]!.synced_to_discord_at).toBeNull();
    expect((await sql`select discord_event_id from events`)[0]!.discord_event_id).toBe("discord-1");
  });
});
