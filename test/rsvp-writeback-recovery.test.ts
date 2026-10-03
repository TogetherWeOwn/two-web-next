// route-inventory: PUT /events/:key/rsvp
// RsvpWriteBackFailureTest, producer to consumer (TOG-11984). test/rsvp-writeback-outage.test.ts
// and test/real-mirror-timing.test.ts drive the consumer with a hand-built QueueMessage; here
// the carrier is the exact SyncMessage the RSVP route enqueued, delivered through the real
// consume() onto real pgEventStore / pgUniqueLock / pgQueueLedger rows. Only the bot transport
// is a fake, and no retry is simulated: each delivery is one consume() call with the attempt
// count the queue would report.
// Live against agent-testdb (skipped without DATABASE_URL). Never point this at anything but
// a test container: every driver is scoped to a disposable schema.
import { and, eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { RSVP_COPY, RSVP_SYNCED_TESTID, RSVP_SYNCING_TESTID } from "../src/islands/contracts";
import { SYNC_EVENT } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { toQueueMessage } from "../src/jobs/envelope";
import { pgEventStore } from "../src/jobs/events";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { BotTransportError, type BotClient } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Only transport and pool construction are substituted: the web producer must
// land its ledger/lock rows in the fixture schema, never the shared public one.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// The member answer as the PUT serializes it (src/events/routes.tsx rsvpBody), read back from
// the persisted row: there is no RSVP read endpoint, and a re-PUT resets the stamp. The island
// copy follows the stamp: null is "saved, syncing", a stamp is "synced". A save failure is a
// non-2xx PUT with no row, never one of these.
const memberAnswer = (row: { status: string; syncedToDiscordAt: Date | null }) => {
  const syncedAt = row.syncedToDiscordAt?.toISOString() ?? null;
  return {
    status: row.status,
    synced_to_discord_at: syncedAt,
    view: syncedAt
      ? { copy: RSVP_COPY.synced, testid: RSVP_SYNCED_TESTID }
      : { copy: RSVP_COPY.syncing, testid: RSVP_SYNCING_TESTID },
  };
};

type SyncCarrier = Extract<QueueMessage, { kind: "sync-event" }>;

// Producers now enqueue the W13 carrier directly; the W8 SyncMessage shape below
// is what in-flight pre-integration carriers look like on the wire. The mapping
// contract (same key, inconsistent carriers refused) is unchanged.
const w8carrier = (
  eventKey: string,
  action: string,
  idempotencyKey = "11111111-1111-4111-8111-111111111111",
) => ({
  dedupeKey: eventKey,
  eventKey,
  action,
  idempotencyKey,
});
const w8upsert = (eventKey: string, idempotencyKey?: string) =>
  w8carrier(eventKey, "event.upsert", idempotencyKey);

describe("W8 write-back carrier reaches the sync-event job", () => {
  it.each(["event.upsert", "event.cancel"])(
    "maps the producer's %s carrier with its idempotency key unchanged",
    (action) => {
      const carrier = w8carrier("01WBCARRIER000000000000000", action);
      expect(toQueueMessage(structuredClone(carrier))).toEqual({
        kind: "sync-event",
        eventKey: carrier.eventKey,
        idempotencyKey: carrier.idempotencyKey,
      });
    },
  );

  it("leaves inconsistent carriers unrecognized", () => {
    const upsert = w8upsert("01WBCARRIER000000000000000");
    expect(toQueueMessage({ ...upsert, action: "event.reopen" })).toBeNull();
    expect(toQueueMessage({ ...upsert, dedupeKey: "another-event" })).toBeNull();
    expect(toQueueMessage({ ...upsert, idempotencyKey: null })).toBeNull();
    // A kind is judged by the W13 shape alone, never re-read as a W8 carrier.
    expect(toQueueMessage({ ...upsert, kind: "private-unsupported-kind" })).toBeNull();
  });

  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "rsvp write-back recovery through the real consumer (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    // Jobs run on native postgres.js Dates; the drizzle-wrapped pool installs date serializers
    // (see test/helpers/jobs-db.ts), so the adapters get their own raw pool on the same schema.
    let jobsSql: postgres.Sql;
    const store = createMemorySessionStore();
    const sent: SyncCarrier[] = [];
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
      SYNC_EVENT_QUEUE: { send: async (m: SyncCarrier) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      db = fixture.db;
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      const options = {
        max: 2,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      };
      const realPostgres = await vi
        .importActual<{ default: typeof postgres }>("postgres")
        .then((m) => m.default);
      vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
        testDatabaseUrl(raw);
        return realPostgres(raw, { ...opts, ...options });
      }) as typeof postgres);
      jobsSql = postgres(url.href, options);
      // The route producer opens its own pool via sqlFor(env): point it at the
      // same fixture schema through the DB binding, never the public schema.
      (env as Record<string, unknown>).DB = { connectionString: url.href };
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`delete from web_throttle_hits`;
      await jobsSql`delete from job_unique_locks`;
      await jobsSql`delete from queue_jobs`;
      sent.length = 0;
    });
    afterEach(() => vi.restoreAllMocks());
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
          eventKey: `01WR${crypto
            .randomUUID()
            .replace(/[^0-9a-f]/g, "")
            .slice(0, 22)
            .toUpperCase()}`,
          title: "Recovery night",
          startsAt: new Date("2099-01-01T20:00:00Z"),
          endsAt: new Date("2099-01-01T22:00:00Z"),
          timezone: "UTC",
          status: "published",
        })
        .returning();
      return ev!;
    }

    const rsvpRow = async (eventId: number, userId: string) =>
      (
        await db
          .select()
          .from(rsvps)
          .where(and(eq(rsvps.eventId, eventId), eq(rsvps.userId, userId)))
      )[0]!;
    const eventRow = async (eventId: number) =>
      (await db.select().from(events).where(eq(events.id, eventId)))[0]!;

    // One queue delivery of `body`. The body is cloned the way the queue serializes it, so
    // nothing the producer held by reference reaches the consumer.
    type Delivery = {
      body: unknown;
      attempts: number;
      acked: boolean;
      retried: number | null;
      ack(): void;
      retry(o?: { delaySeconds?: number }): void;
    };
    const deliver = async (body: SyncCarrier, attempts: number, bot: BotClient) => {
      const m: Delivery = {
        body: structuredClone(body),
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
      await consume(
        { messages: [m] },
        {
          bot,
          events: pgEventStore(jobsSql),
          lock: pgUniqueLock(jobsSql),
          ledger: pgQueueLedger(jobsSql),
        },
      );
      return m;
    };

    const asked: string[] = [];
    const botDown = {
      upsertEvent: async (_p: unknown, key: string) => {
        asked.push(key);
        throw new BotTransportError("bot unreachable");
      },
    } as unknown as BotClient;
    const botUp = {
      upsertEvent: async (_p: unknown, key: string) => {
        asked.push(key);
        return { ok: true, requestId: null, discordEventId: "discord-evt-1" };
      },
    } as unknown as BotClient;
    beforeEach(() => {
      asked.length = 0;
    });

    // Nothing the W8 carrier holds is left behind: no lease, no phantom backlog row.
    const leftovers = async () => ({
      locks: (await jobsSql`select count(*)::int as n from job_unique_locks`)[0]!.n as number,
      jobs: (await jobsSql`select count(*)::int as n from queue_jobs`)[0]!.n as number,
    });

    it("failed transport keeps the RSVP pending; the same carrier's redelivery stamps both rows synced", async () => {
      const ev = await seed();

      const res = await putRsvp(ev.eventKey, "member-1");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        data: { status: "going", synced_to_discord_at: null, waitlist_position: null },
      });
      expect(sent).toHaveLength(1);
      const carrier = sent[0]!;
      expect(carrier).toMatchObject({ eventKey: ev.eventKey, kind: "sync-event" });
      const saved = await rsvpRow(ev.id, "member-1");

      // Delivery 1, bot down: released for the backoff, never failed, never acked.
      const first = await deliver(carrier, 1, botDown);
      expect(asked).toEqual([carrier.idempotencyKey]);
      expect(first.acked).toBe(false);
      expect(first.retried).toBe(SYNC_EVENT.backoffSeconds[0]);

      // Same row, still going, null stamp; no Discord id on the event (no false mirror).
      const mid = await rsvpRow(ev.id, "member-1");
      expect(mid.id).toBe(saved.id);
      expect(mid).toMatchObject({ status: "going", syncedToDiscordAt: null });
      expect((await eventRow(ev.id)).discordEventId).toBeNull();
      // The member sees a confirmed, syncing seat while the retry is outstanding.
      expect(memberAnswer(mid)).toEqual({
        status: "going",
        synced_to_discord_at: null,
        view: { copy: RSVP_COPY.syncing, testid: RSVP_SYNCING_TESTID },
      });
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([ev.eventKey]);

      // Delivery 2, bot back: the queue redelivers after the backoff, so the
      // deferred attempt is due again; the producer's key rides the redelivery.
      await jobsSql`update event_sync_attempts set next_attempt_at = now() - interval '1 second'`;
      const second = await deliver(carrier, 2, botUp);
      expect(asked).toEqual([carrier.idempotencyKey, carrier.idempotencyKey]);
      expect(second.acked).toBe(true);
      expect(second.retried).toBeNull();

      const after = await rsvpRow(ev.id, "member-1");
      expect(after.id).toBe(saved.id);
      expect(after.syncedToDiscordAt).toBeInstanceOf(Date);
      expect(after.syncedToDiscordAt!.getTime()).toBeGreaterThanOrEqual(saved.updatedAt.getTime());
      expect((await eventRow(ev.id)).discordEventId).toBe("discord-evt-1");
      expect(memberAnswer(after)).toEqual({
        status: "going",
        synced_to_discord_at: after.syncedToDiscordAt!.toISOString(),
        view: { copy: RSVP_COPY.synced, testid: RSVP_SYNCED_TESTID },
      });
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([]);
      expect(await leftovers()).toEqual({ locks: 0, jobs: 0 });
    });

    it("pending without a retry: a last-try outage leaves the seat saved and the member answer pending", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const ev = await seed();

      expect((await putRsvp(ev.eventKey, "member-2")).status).toBe(201);
      const carrier = sent[0]!;
      const saved = await rsvpRow(ev.id, "member-2");

      // Out of tries: the consumer gives up and acks. No retry is outstanding.
      const last = await deliver(carrier, SYNC_EVENT.tries, botDown);
      expect(asked).toEqual([carrier.idempotencyKey]);
      expect(last.acked).toBe(true);
      expect(last.retried).toBeNull();
      // The durable failure keeps the unresolved identity (recovery replays it);
      // the queue.failing alert carries the same exception for paging.
      expect(error).toHaveBeenCalledWith(
        "job failed",
        "sync-event",
        "carrier exhausted; unresolved identity retained",
      );
      const critical = vi
        .mocked(console.error)
        .mock.calls.filter(([line]) => String(line).startsWith('{"level":"critical"'));
      expect(critical).toHaveLength(1);
      expect(JSON.parse(String(critical[0]![0]))).toMatchObject({
        event: "queue.failing",
        job: "SyncEventToDiscord",
        attempts: SYNC_EVENT.tries,
        exception: "carrier exhausted; unresolved identity retained",
      });

      // The give-up is the queue's, not the member's: the seat stands, unstamped, unmirrored.
      const row = await rsvpRow(ev.id, "member-2");
      expect(row.id).toBe(saved.id);
      expect(row).toMatchObject({ status: "going", syncedToDiscordAt: null });
      expect((await eventRow(ev.id)).discordEventId).toBeNull();
      // Still the syncing copy, never the save-failure copy.
      const answer = memberAnswer(row);
      expect(answer).toEqual({
        status: "going",
        synced_to_discord_at: null,
        view: { copy: RSVP_COPY.syncing, testid: RSVP_SYNCING_TESTID },
      });
      expect(answer.view.copy).not.toBe(RSVP_COPY.failedTitle);
      // The reconcile pass still owns this row: it is selected for redispatch.
      expect(await pgEventStore(jobsSql).staleEventKeys()).toEqual([ev.eventKey]);
      expect(await leftovers()).toEqual({ locks: 0, jobs: 0 });
    });
  },
);
