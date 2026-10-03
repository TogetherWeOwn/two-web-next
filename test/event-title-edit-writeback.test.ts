// A rename of a mirrored event must reach Discord. event-writeback.test.ts pins
// that an edit sends one tracked carrier; event-patch-admission.test.ts pins the
// PATCH field semantics. Neither follows a title-only edit to the bot call, so
// the Discord mirror could drift from a renamed event without a failing row.
// This suite runs the real route, carrier, ledger, unique lock and consumer and
// stops at the bot double.
import postgres from "postgres";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { enqueueSyncEvent } from "../src/jobs/worker";
import { uniqueKey } from "../src/jobs/sync-event";
import type { BotClient, QueueMessage } from "../src/jobs/types";
import { buildSyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Only transport and pool construction are substituted.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function delivery(body: SyncEventMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "title-only event edit write-back (test container)",
  () => {
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
      const options = {
        max: 1,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      };
      sql = realPostgres(url.href, options);
      vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
        testDatabaseUrl(raw);
        return realPostgres(raw, { ...opts, ...options });
      }) as typeof postgres);
      sent = [];
      sessions = createMemorySessionStore();
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "test",
        DISCORD_CLIENT_SECRET: "test",
        DISCORD_BOT_TOKEN: "test",
        DISCORD_GUILD_ID: "test",
        DISCORD_INVITE_URL: "https://discord.gg/test",
        DB: { connectionString: url.href },
        SYNC_EVENT_QUEUE: {
          send: async (body, options) => {
            sent.push({ body: body as SyncEventMessage, options });
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
          },
        },
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      } as Env;
    });
    afterEach(async () => {
      if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
      await sql?.end({ timeout: 1 });
      await fixture?.dispose();
      fixture = undefined;
    });

    async function cookie() {
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "test-user",
        username: "test-user",
        avatar: null,
        member: true,
        moderator: true,
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
    async function request(method: "PATCH" | "POST", path: string, body?: Record<string, unknown>) {
      return app.request(
        path,
        {
          method,
          headers: {
            cookie: await cookie(),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    }
    const rename = (body: Record<string, unknown>) => request("PATCH", `/events/${eventKey}`, body);

    async function seed(status: "draft" | "published" = "published") {
      const [row] =
        await sql`insert into events (event_key, title, starts_at, ends_at, location, status)
      values (${eventKey}, 'Game night', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z', 'Voice', ${status}) returning id`;
      return row!.id as number;
    }
    /** A published event Discord already mirrors: one stamped RSVP, nothing stale. */
    async function seedMirrored() {
      const id = await seed();
      await sql`insert into rsvps (event_id, user_id, status, synced_to_discord_at)
      values (${id}, 'test-user', 'going', '2026-01-01T00:00:00Z')`;
      await sql`update events set discord_event_id = 'discord-1', synced_revision = sync_revision where id = ${id}`;
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
      return id;
    }
    async function mirrorState() {
      const [event] =
        await sql`select title, status, discord_event_id, sync_revision::int as sync_revision,
        synced_revision::int as synced_revision from events where event_key = ${eventKey}`;
      const stamps = await sql`select synced_to_discord_at from rsvps order by id`;
      return {
        event: event!,
        stamps: stamps.map((row) => row.synced_to_discord_at as Date | null),
      };
    }
    function botDouble() {
      return {
        upsertEvent: vi.fn<BotClient["upsertEvent"]>(async (..._args) => ({
          ok: true as const,
          requestId: null,
          discordEventId: "discord-1",
        })),
        cancelEvent: vi.fn<BotClient["cancelEvent"]>(async (..._args) => ({
          ok: true as const,
          requestId: null,
          discordEventId: "discord-1",
        })),
        postAnnouncement: vi.fn(),
        assignRole: vi.fn(),
      } satisfies BotClient;
    }
    const deps = (bot: BotClient) => ({
      bot,
      events: pgEventStore(sql),
      lock: pgUniqueLock(sql),
      ledger: pgQueueLedger(sql),
      dispatchPending: (key: string) => enqueueSyncEvent(env, buildSyncMessage(key, "published")!),
    });
    async function deliver(bot: BotClient) {
      expect(sent).toHaveLength(1);
      const m = delivery(sent[0]!.body);
      await consume({ messages: [m] }, deps(bot));
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
      sent.length = 0;
    }

    it("sends the renamed event to Discord and leaves the mirror stamps to the consumer", async () => {
      await seedMirrored();
      const before = await mirrorState();

      const response = await rename({ title: "Renamed night" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { title: "Renamed night" } });

      // The edit commits the title and marks the revision dirty; it never writes
      // the mirror's own columns, so the consumer is the only thing that clears it.
      const afterEdit = await mirrorState();
      expect(afterEdit.event).toEqual({
        ...before.event,
        title: "Renamed night",
        sync_revision: before.event.sync_revision + 1,
      });
      expect(afterEdit.stamps).toEqual(before.stamps);
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([eventKey]);

      expect(sent).toHaveLength(1);
      const message = sent[0]!.body;
      const bot = botDouble();
      await deliver(bot);
      expect(bot.cancelEvent).not.toHaveBeenCalled();
      expect(bot.upsertEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ eventKey, name: "Renamed night" }),
        message.idempotencyKey,
      );

      const settled = await mirrorState();
      expect(settled.event).toEqual({
        ...afterEdit.event,
        synced_revision: afterEdit.event.sync_revision,
      });
      expect(settled.stamps[0]).toBeInstanceOf(Date);
      expect(await pgEventStore(sql).staleEventKeys()).toEqual([]);
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await sql`select key from job_unique_locks`).toEqual([]);
    });

    it("carries the same tracked carrier shape as publish and cancel", async () => {
      await seed("draft");
      const bot = botDouble();
      const carriers: SyncEventMessage[] = [];
      for (const [method, path, body] of [
        ["POST", `/events/${eventKey}/publish`, undefined],
        ["PATCH", `/events/${eventKey}`, { title: "Renamed night" }],
        ["POST", `/events/${eventKey}/cancel`, undefined],
      ] as const) {
        expect((await request(method, path, body)).status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.options).toEqual({ delaySeconds: 10 });
        const message = sent[0]!.body;
        carriers.push(message);
        expect(message.idempotencyKey).toMatch(UUID_V4);
        expect(message.leaseToken).toMatch(UUID_V4);
        expect(message.requestId).toEqual(expect.any(String));
        expect(await sql`select job_id, key from queue_jobs`).toEqual([
          { job_id: message.jobId, key: uniqueKey(eventKey) },
        ]);
        expect(await sql`select key, owner_token from job_unique_locks`).toEqual([
          { key: uniqueKey(eventKey), owner_token: message.leaseToken },
        ]);
        await deliver(bot);
      }

      const [publish, edit, cancel] = carriers as [
        SyncEventMessage,
        SyncEventMessage,
        SyncEventMessage,
      ];
      expect(Object.keys(edit).sort()).toEqual(Object.keys(publish).sort());
      expect(Object.keys(cancel).sort()).toEqual(Object.keys(publish).sort());
      // One build-time key per mutation: an edit is never folded into a neighbour.
      expect(new Set(carriers.map((m) => m.idempotencyKey)).size).toBe(3);
      expect(bot.upsertEvent.mock.calls.map(([payload]) => payload)).toEqual([
        expect.objectContaining({ eventKey, name: "Game night" }),
        expect.objectContaining({ eventKey, name: "Renamed night" }),
      ]);
      expect(bot.cancelEvent).toHaveBeenCalledExactlyOnceWith({ eventKey }, cancel.idempotencyKey);
    });

    it.each([
      ["an empty object", {}],
      ["the unchanged title", { title: "Game night" }],
    ])("%s as a PATCH never reaches Discord", async (_name, body) => {
      await seedMirrored();
      const before = await mirrorState();

      expect((await rename(body)).status).toBe(200);

      // The revision trigger only advances on a changed Discord-visible field, so
      // whatever carrier the route sends is absorbed as a clean no-op.
      expect(await mirrorState()).toEqual(before);
      const bot = botDouble();
      for (const carrier of sent.splice(0)) {
        const m = delivery(carrier.body);
        await consume({ messages: [m] }, deps(bot));
        expect(m.ack).toHaveBeenCalledOnce();
      }
      expect(bot.upsertEvent).not.toHaveBeenCalled();
      expect(bot.cancelEvent).not.toHaveBeenCalled();
      expect(await mirrorState()).toEqual(before);
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await sql`select key from job_unique_locks`).toEqual([]);
    });

    // CURRENT BEHAVIOUR, NOT A CONTRACT (TOG-12620, CEO decision on the card):
    // updateEvent does not diff the input, so a no-change PATCH of a mirrored
    // event still enqueues one carrier. It is idempotent and harmless (the test
    // above proves Discord is never called). Suppressing it later is a valid
    // change: delete or invert this row; it is not a regression.
    it("currently enqueues one redundant carrier for a no-change PATCH (not a contract)", async () => {
      await seedMirrored();
      expect((await rename({})).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ kind: "sync-event", eventKey });
    });

    it("keeps a renamed cancelled event cancelled instead of re-publishing it", async () => {
      await seedMirrored();
      expect((await request("POST", `/events/${eventKey}/cancel`)).status).toBe(200);
      const bot = botDouble();
      await deliver(bot);
      expect(bot.cancelEvent).toHaveBeenCalledOnce();

      const response = await rename({ title: "Renamed after cancel" });
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      await deliver(bot);

      expect((await mirrorState()).event).toMatchObject({
        title: "Renamed after cancel",
        status: "cancelled",
      });
      expect(bot.upsertEvent).not.toHaveBeenCalled();
      expect(bot.cancelEvent).toHaveBeenCalledTimes(2);
      expect(bot.cancelEvent).toHaveBeenLastCalledWith(
        { eventKey },
        expect.stringMatching(UUID_V4),
      );
    });
  },
);
