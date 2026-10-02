// RsvpWriteBackFailureTest chain on one real row (TOG-11705): member RSVP over HTTP ->
// failed bot transport -> persisted RSVP with null stamp and pending member answer ->
// retry of the same message -> real mirror stamps -> synced stamp on the same row.
// Real Postgres (agent-testdb / CI service) through the real pg EventStore adapter; only
// the bot transport, lock and ledger are fakes. Every driver is scoped to a disposable schema.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/event-store-pg";
import { BotTransportError } from "../src/jobs/types";
import type { BotClient, QueueLedger, UniqueLock } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const LEASE = "11111111-1111-4111-8111-111111111111";

describe.skipIf(!process.env.DATABASE_URL)(
  "real mirror stamps and sync timing (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let client: MemberDataFixture["client"];
    // Jobs run on native postgres.js Dates; the drizzle-wrapped pool installs date serializers
    // (see test/helpers/jobs-db.ts), so the adapter gets its own raw pool on the same schema.
    let jobsSql: postgres.Sql;
    const store = createMemorySessionStore();
    const sent: SyncMessage[] = [];
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
      EVENT_SYNC_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      db = fixture.db;
      client = fixture.client;
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      jobsSql = postgres(url.href, {
        max: 2,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
    });
    beforeEach(async () => {
      await fixture.reset();
      await client`delete from web_throttle_hits`;
      sent.length = 0;
    });
    afterAll(async () => {
      await jobsSql?.end({ timeout: 1 });
      await fixture?.dispose();
    });

    async function putRsvp(eventKey: string, userId: string) {
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
      const cookie = (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      return app.request(
        `/events/${eventKey}/rsvp`,
        {
          method: "PUT",
          headers: { origin: APP_URL, "content-type": "application/json", cookie },
          body: JSON.stringify({ status: "going" }),
        },
        env,
      );
    }

    async function seed() {
      const [ev] = await db
        .insert(events)
        .values({
          eventKey: `01W1${crypto
            .randomUUID()
            .replace(/[^0-9a-f]/g, "")
            .slice(0, 22)
            .toUpperCase()}`,
          title: "Mirror night",
          startsAt: new Date("2099-01-01T20:00:00Z"),
          endsAt: new Date("2099-01-01T22:00:00Z"),
          timezone: "UTC",
          status: "published",
        })
        .returning();
      return ev!;
    }

    const lock = (): UniqueLock => ({ acquire: async () => LEASE, release: async () => {} });
    const ledger = (): QueueLedger => ({
      enqueued: async () => {},
      reserved: async () => {},
      released: async () => {},
      dequeued: async () => {},
      failed: async () => {},
    });
    type Tracked = {
      body: unknown;
      attempts: number;
      acked: boolean;
      retried: number | null;
      ack(): void;
      retry(o?: { delaySeconds?: number }): void;
    };
    const message = (eventKey: string, attempts: number): Tracked => {
      const m: Tracked = {
        body: { kind: "sync-event", eventKey, idempotencyKey: "same-key", leaseToken: LEASE },
        attempts,
        acked: false,
        retried: null,
        ack() {
          m.acked = true;
        },
        retry(o) {
          m.retried = o?.delaySeconds ?? 0;
        },
      };
      return m;
    };
    const run = (m: Tracked, bot: BotClient) =>
      consume(
        { messages: [m] },
        { bot, events: pgEventStore(jobsSql), lock: lock(), ledger: ledger() },
      );
    const rsvpRow = async (eventId: number) =>
      (await db.select().from(rsvps).where(eq(rsvps.eventId, eventId)))[0]!;

    it("outage keeps the RSVP saved and pending; the retry stamps event + RSVP on the same rows", async () => {
      const ev = await seed();

      // Member write succeeds before any mirror attempt; the pending view is the null stamp.
      const res = await putRsvp(ev.eventKey, "member-1");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
      });
      // Write-back is enqueued once, with the key that every retry must reuse.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ eventKey: ev.eventKey, action: "event.upsert" });
      const before = await rsvpRow(ev.id);

      // Attempt 1: bot down. Transport error is a wait (release), never a failure.
      const calls: string[] = [];
      const down: BotClient = {
        upsertEvent: async (_p: unknown, key: string) => {
          calls.push(key);
          throw new BotTransportError("bot unreachable");
        },
      } as unknown as BotClient;
      const first = message(ev.eventKey, 1);
      await run(first, down);
      expect(first.acked).toBe(false);
      expect(first.retried).toBe(10);

      // Same rows, nothing mirrored: RSVP survives, null stamp, no false Discord id, still answered going.
      const mid = await rsvpRow(ev.id);
      expect(mid.id).toBe(before.id);
      expect(mid.status).toBe("going");
      expect(mid.syncedToDiscordAt).toBeNull();
      const [evMid] = await db.select().from(events).where(eq(events.id, ev.id));
      expect(evMid!.discordEventId).toBeNull();
      // Pending-without-retry: the reconcile pass would still pick this event up.
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([ev.eventKey]);

      // Attempt 2: bot back. The same idempotency key rides the retry.
      const up: BotClient = {
        upsertEvent: async (_p: unknown, key: string) => {
          calls.push(key);
          return { ok: true, requestId: null, discordEventId: "discord-evt-1" };
        },
      } as unknown as BotClient;
      const second = message(ev.eventKey, 2);
      await run(second, up);
      expect(second.acked).toBe(true);
      expect(calls).toEqual(["same-key", "same-key"]);

      // Recovery: event carries the Discord id; the same RSVP row is stamped and the member view is synced.
      const after = await rsvpRow(ev.id);
      expect(after.id).toBe(before.id);
      expect(after.syncedToDiscordAt).toBeInstanceOf(Date);
      expect(after.syncedToDiscordAt!.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      const [evAfter] = await db.select().from(events).where(eq(events.id, ev.id));
      expect(evAfter!.discordEventId).toBe("discord-evt-1");
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([]);
      // The RSVP write path's own view of that row now reports synced (non-null ISO stamp).
      expect(after.syncedToDiscordAt!.toISOString()).toMatch(/^\d{4}-\d\d-\d\dT/);
    });

    it("an answer edited after the mirror ran stays pending and is re-synced next pass", async () => {
      const ev = await seed();
      await putRsvp(ev.eventKey, "member-1");
      const up: BotClient = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "discord-evt-2" }),
      } as unknown as BotClient;
      await run(message(ev.eventKey, 1), up);
      expect((await rsvpRow(ev.id)).syncedToDiscordAt).not.toBeNull();

      // Re-answer: any change makes the mirror stale again (null stamp on the same row).
      const res = await putRsvp(ev.eventKey, "member-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
      });
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([ev.eventKey]);
      await run(message(ev.eventKey, 1), up);
      expect((await rsvpRow(ev.id)).syncedToDiscordAt).not.toBeNull();
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([]);
    });
  },
);
