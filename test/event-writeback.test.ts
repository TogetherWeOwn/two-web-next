import postgres from "postgres";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { buildSyncMessage, enqueueEventSync } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
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
      upsertEvent: vi.fn(async () => ({ ok: true as const, requestId: null, discordEventId: "discord-1" })),
      cancelEvent: vi.fn(async () => ({ ok: true as const, requestId: null, discordEventId: "discord-1" })),
      postAnnouncement: vi.fn(), assignRole: vi.fn(),
    } satisfies BotClient;
  }
  const deps = (bot: BotClient) => ({ bot, events: pgEventStore(sql), lock: pgUniqueLock(sql), ledger: pgQueueLedger(sql) });

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

  it("mirror stamping does not mark an RSVP written during the bot call as synced", async () => {
    const id = await seed();
    await sql`insert into rsvps (event_id, user_id, status, updated_at) values (${id}, 'test-user', 'going', '2026-01-01')`;
    const cutoff = new Date("2026-01-02T00:00:00Z");
    await sql`update rsvps set updated_at = '2026-01-03' where event_id = ${id}`;
    await pgEventStore(sql).recordMirrored(eventKey, "discord-1", cutoff);
    expect((await sql`select synced_to_discord_at from rsvps`)[0]!.synced_to_discord_at).toBeNull();
    expect((await sql`select discord_event_id from events`)[0]!.discord_event_id).toBe("discord-1");
  });
});
