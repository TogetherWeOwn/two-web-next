import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { reconcileEvents } from "../src/jobs/cron";
import { pgEventStore } from "../src/jobs/events";
import { trackingQueue } from "../src/jobs/ledger";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { dispatchSyncEvent } from "../src/jobs/sync-event";
import {
  BotTransportError,
  type BotClient,
  type EventStore,
  type QueueMessage,
  type SyncAttempt,
} from "../src/jobs/types";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const delivery = (body: SyncMessage, attempts = 1) => ({
  body,
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});

// Native SQL and canonically migrated, owned schemas only. The bot/queue are
// local doubles; preparation, settlement, claims, ledger and recovery are real.
describe.skipIf(!process.env.DATABASE_URL)("event sync eligibility (native PostgreSQL)", () => {
  let fixture: MemberDataFixture | undefined;
  let sql: postgres.Sql;
  let clients: postgres.Sql[];
  let sent: SyncMessage[];
  let queue: ReturnType<typeof trackingQueue>;
  let events: EventStore;

  function nativeClient() {
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    const client = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture!.schemaName },
      onnotice: () => {},
    });
    clients.push(client);
    return client;
  }
  beforeEach(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    fixture = await createMemberDataFixture(url.href);
    clients = [];
    // Separate native pools avoid the Drizzle-owned client's timestamp parsers.
    sql = nativeClient();
    events = pgEventStore(sql);
    sent = [];
    queue = trackingQueue(
      {
        send: async (body) => {
          sent.push(body as SyncMessage);
        },
      },
      pgQueueLedger(sql),
    );
  });
  afterEach(async () => {
    await Promise.all(clients?.map((client) => client.end({ timeout: 1 })) ?? []);
    await fixture?.dispose();
    fixture = undefined;
  });

  async function seed(status = "published", ended = false) {
    const [row] = await sql`insert into events (event_key, title, starts_at, ends_at, status)
      values (${eventKey}, 'Original immutable title', now() - interval '1 hour',
        now() + ${ended ? -60 : 3600} * interval '1 second', ${status}) returning id`;
    return row!.id as number;
  }
  function botDouble() {
    return {
      upsertEvent: vi.fn<BotClient["upsertEvent"]>(async () => ({
        ok: true,
        requestId: null,
        discordEventId: "discord-1",
      })),
      cancelEvent: vi.fn<BotClient["cancelEvent"]>(async () => ({
        ok: true,
        requestId: null,
        discordEventId: "discord-1",
      })),
      postAnnouncement: vi.fn(),
      assignRole: vi.fn(),
    } satisfies BotClient;
  }
  function deps(bot: BotClient, store = events) {
    return {
      bot,
      events: store,
      ledger: pgQueueLedger(sql),
      lock: pgUniqueLock(sql),
      dispatchPending: (key: string) => dispatchSyncEvent(queue, pgUniqueLock(sql), key),
    };
  }
  async function dispatch() {
    expect(await dispatchSyncEvent(queue, pgUniqueLock(sql), eventKey)).toBe(true);
    return sent.at(-1)!;
  }
  const reconcile = () => reconcileEvents({ events, queue, lock: pgUniqueLock(sql) });
  const makeDue =
    () => sql`update event_sync_attempts set next_attempt_at = clock_timestamp() - interval '1 second'
    where state = 'pending'`;

  for (const settlement of ["success", "refusal"] as const) {
    it(`retires a new-key stale snapshot whose INSERT waited behind ${settlement} settlement`, async () => {
      const id = await seed();
      await sql`insert into rsvps (event_id, user_id, status, updated_at)
        values (${id}, 'test-user', 'going', '2026-01-01T00:00:00Z')`;
      const original = await dispatch();
      const bot = botDouble();
      if (settlement === "refusal")
        bot.upsertEvent.mockResolvedValueOnce({
          ok: false,
          code: "action_not_allowed",
          status: 403,
          requestId: null,
          message: "definitively refused",
          retryable: false,
          retryAfterSeconds: null,
        });
      const holder = nativeClient();
      const observer = nativeClient();
      const handlerPid = (await sql`select pg_backend_pid() as pid`)[0]!.pid as number;
      let holdingPid = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settle = async (work: (txEvents: EventStore) => Promise<void>) => {
        await holder.begin(async (tx) => {
          await work(pgEventStore(tx));
          holdingPid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
          await held;
        });
      };
      const originalStore: EventStore = {
        ...events,
        completeSync: (attempt, discordId) =>
          settle((txEvents) => txEvents.completeSync(attempt, discordId)),
        failSync: (key) => settle((txEvents) => txEvents.failSync(key)),
      };
      let staleSnapshot: SyncAttempt | undefined;
      const newKeyStore: EventStore = {
        ...events,
        prepareSync: async (...args) => {
          const prepared = await events.prepareSync(...args);
          if (prepared && !("waiting" in prepared)) staleSnapshot = prepared;
          return prepared;
        },
      };
      const first = delivery(original);
      let originalConsumption: Promise<void> | undefined;
      let redundantConsumption: Promise<void> | undefined;
      let redundant: ReturnType<typeof delivery> | undefined;
      try {
        originalConsumption = consume({ messages: [first] }, deps(bot, originalStore));
        await vi.waitFor(() => expect(holdingPid).toBeGreaterThan(0), { timeout: 2000 });
        // Expire only this fixture's carrier lock, allowing a distinct carrier/key
        // while the original identity still owns the pending partial unique slot.
        await sql`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second'`;
        const newMessage = await dispatch();
        expect(newMessage.idempotencyKey).not.toBe(original.idempotencyKey);
        redundant = delivery(newMessage);
        redundantConsumption = consume({ messages: [redundant] }, deps(bot, newKeyStore));
        await vi.waitFor(
          async () => {
            const [row] =
              await observer`select pg_blocking_pids(${handlerPid}) as blockers, query, wait_event_type
            from pg_stat_activity where pid = ${handlerPid}`;
            expect(row!.blockers).toContain(holdingPid);
            expect(row!.query).toMatch(/insert into event_sync_attempts/i);
            expect(row!.wait_event_type).toBe("Lock");
          },
          { interval: 10, timeout: 2000 },
        );
        expect(bot.upsertEvent).toHaveBeenCalledOnce();
        release();
        await Promise.all([originalConsumption, redundantConsumption]);
      } finally {
        release();
        await Promise.allSettled([originalConsumption, redundantConsumption]);
      }
      // The waiting INSERT really did return an old dirty snapshot, not a null
      // or conflict result. Its first claim must recheck all current eligibility.
      expect(staleSnapshot).toMatchObject({
        idempotencyKey: redundant!.body.idempotencyKey,
        state: "pending",
        requestAttempts: 0,
      });
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(bot.cancelEvent).not.toHaveBeenCalled();
      expect(first.ack).toHaveBeenCalledOnce();
      expect(redundant!.ack).toHaveBeenCalledOnce();
      expect(redundant!.retry).not.toHaveBeenCalled();
      expect(
        await sql`select state, request_attempts, next_attempt_at from event_sync_attempts
        where idempotency_key = ${redundant!.body.idempotencyKey}::uuid`,
      ).toEqual([{ state: "obsolete", request_attempts: 0, next_attempt_at: null }]);
      expect(
        await sql`select state, request_attempts from event_sync_attempts
        where idempotency_key = ${original.idempotencyKey}::uuid`,
      ).toEqual([
        { state: settlement === "success" ? "succeeded" : "failed", request_attempts: 1 },
      ]);
      expect(
        await sql`select sync_revision = synced_revision as clean, discord_event_id from events`,
      ).toEqual([
        {
          clean: settlement === "success",
          discord_event_id: settlement === "success" ? "discord-1" : null,
        },
      ]);
      const [rsvp] = await sql`select synced_to_discord_at from rsvps`;
      expect(rsvp!.synced_to_discord_at).toEqual(
        settlement === "success" ? expect.any(Date) : null,
      );
      expect(await events.needsSync(eventKey)).toBe(false);
      expect(await events.staleEventKeys()).toEqual([]);
      expect(await events.pendingSync(eventKey)).toBeNull();
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await sql`select job_id from queue_failed_jobs`).toHaveLength(
        settlement === "refusal" ? 1 : 0,
      );
      expect(sent).toHaveLength(2); // retirement never creates another successor
      await consume({ messages: [delivery(redundant!.body, 2)] }, deps(bot));
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
    });
  }

  for (const legacyReason of ["missing mapping", "unmirrored RSVP"] as const) {
    it(`keeps first-request eligibility for a synchronized published revision with ${legacyReason}`, async () => {
      const id = await seed();
      await sql`update events set synced_revision = sync_revision,
        discord_event_id = ${legacyReason === "missing mapping" ? null : "discord-1"} where id = ${id}`;
      if (legacyReason === "unmirrored RSVP")
        await sql`insert into rsvps (event_id, user_id, status)
        values (${id}, 'test-user', 'going')`;
      const bot = botDouble();
      const message = delivery(await dispatch());
      await consume({ messages: [message] }, deps(bot));
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(await events.needsSync(eventKey)).toBe(false);
    });
  }

  for (const eligibility of ["synchronized", "refused"] as const) {
    it(`retains already-attempted replay despite a ${eligibility} current revision`, async () => {
      await seed();
      const original = await dispatch();
      const bot = botDouble();
      bot.upsertEvent.mockRejectedValueOnce(new BotTransportError("remote apply, response lost"));
      await consume({ messages: [delivery(original, 6)] }, deps(bot));
      const pending = (await events.pendingSync(eventKey))!;
      if (eligibility === "synchronized") {
        await sql`update events set synced_revision = sync_revision, discord_event_id = 'discord-1'`;
      } else {
        // Definitive current-revision suppression must not erase ambiguity of
        // an identity already attempted (for example, retained legacy state).
        await sql`insert into event_sync_attempts
          (idempotency_key, event_id, revision, action, payload, mirrored_at, state, request_attempts)
          select ${crypto.randomUUID()}::uuid, event_id, revision, action, payload, mirrored_at, 'failed', 1
          from event_sync_attempts where idempotency_key = ${original.idempotencyKey}::uuid`;
      }
      await makeDue();
      expect(await events.needsSync(eventKey)).toBe(true);
      expect(await reconcile()).toEqual({ closed: 0, materialized: 0, resynced: 1 });
      expect(sent[1]!.idempotencyKey).toBe(original.idempotencyKey);
      await consume({ messages: [delivery(sent[1]!)] }, deps(bot));
      expect(bot.upsertEvent.mock.calls[1]).toEqual([pending.payload, original.idempotencyKey]);
      expect(
        await sql`select state, request_attempts from event_sync_attempts
        where idempotency_key = ${original.idempotencyKey}::uuid`,
      ).toEqual([{ state: "succeeded", request_attempts: 2 }]);
      expect(sent).toHaveLength(2);
      expect(await events.needsSync(eventKey)).toBe(false);
    });
  }

  for (const control of [
    "closed upsert",
    "published upsert",
    "draft upsert",
    "closed cancellation",
  ] as const) {
    it(`recovers an attempted request without a live carrier: ${control}`, async () => {
      const cancellation = control === "closed cancellation";
      const ended = control === "closed upsert" || cancellation;
      await seed(cancellation ? "cancelled" : "published", ended);
      const original = await dispatch();
      const bot = botDouble();
      const action = cancellation ? bot.cancelEvent : bot.upsertEvent;
      action.mockRejectedValueOnce(new BotTransportError("remote apply, response lost"));
      const first = delivery(original);
      const requestClock = new Date();
      const frozenDeps = { ...deps(bot), now: () => requestClock };
      await consume({ messages: [first] }, frozenDeps);
      expect(first.ack).not.toHaveBeenCalled();
      expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
      const pending = (await events.pendingSync(eventKey))!;
      expect(pending).toMatchObject({
        state: "pending",
        requestAttempts: 1,
        idempotencyKey: original.idempotencyKey,
        action: cancellation ? "event.cancel" : "event.upsert",
      });
      // Exhaust the still-early carrier, not the request's remaining five tries.
      const exhaustedCarrier = delivery(original, 6);
      await consume({ messages: [exhaustedCarrier] }, frozenDeps);
      expect(exhaustedCarrier.ack).toHaveBeenCalledOnce();
      expect(exhaustedCarrier.retry).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledOnce();
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await sql`select job_id from queue_failed_jobs`).toHaveLength(1);
      // A changed title/status must not change the original request's action or
      // payload. A cancelled request can also outlive a later publication/close.
      await sql`update events set title = 'Newer title must not replace snapshot',
        status = ${control === "draft upsert" ? "draft" : "published"}`;
      await makeDue();
      expect(await reconcile()).toEqual({ closed: ended ? 1 : 0, materialized: 0, resynced: 1 });
      expect((await sql`select status from events`)[0]!.status).toBe(
        ended ? "past" : control === "draft upsert" ? "draft" : "published",
      );
      expect(sent).toHaveLength(2);
      const recovered = sent[1]!;
      expect(recovered.idempotencyKey).toBe(original.idempotencyKey);
      expect(recovered.jobId).not.toBe(original.jobId);
      expect(await events.needsSync(eventKey)).toBe(true);
      const recovery = delivery(recovered);
      await consume({ messages: [recovery] }, deps(bot));
      expect(recovery.ack).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledTimes(2);
      expect(action.mock.calls[1]).toEqual([pending.payload, original.idempotencyKey]);
      expect(
        await sql`select state, request_attempts from event_sync_attempts
        where idempotency_key = ${original.idempotencyKey}::uuid`,
      ).toEqual([{ state: "succeeded", request_attempts: 2 }]);
      if (ended || control === "draft upsert") {
        expect(await events.needsSync(eventKey)).toBe(false);
        expect(await events.staleEventKeys()).toEqual([]);
        expect(sent).toHaveLength(2); // no fresh past upsert after immutable replay
        expect(await sql`select job_id from queue_jobs`).toEqual([]);
      } else {
        // The live published control still dispatches its newer revision.
        expect(sent).toHaveLength(3);
        expect(sent[2]!.idempotencyKey).not.toBe(original.idempotencyKey);
        await consume({ messages: [delivery(sent[2]!)] }, deps(bot));
        expect(await events.needsSync(eventKey)).toBe(false);
      }
    });
  }

  for (const blocked of ["future deadline", "null deadline", "six requests"] as const) {
    it(`does not automatically recover a closed attempted request with ${blocked}`, async () => {
      await seed("published", true);
      const original = await dispatch();
      const bot = botDouble();
      bot.upsertEvent.mockRejectedValueOnce(new BotTransportError("lost response"));
      await consume({ messages: [delivery(original, 6)] }, deps(bot));
      const pending = (await events.pendingSync(eventKey))!;
      const deadline = new Date(Date.now() + (blocked === "future deadline" ? 3600_000 : -1000));
      await sql`update event_sync_attempts set
        request_attempts = ${blocked === "six requests" ? 6 : 1},
        next_attempt_at = ${blocked === "null deadline" ? null : deadline}
        where idempotency_key = ${original.idempotencyKey}::uuid`;
      expect(await reconcile()).toEqual({ closed: 1, materialized: 0, resynced: 0 });
      // Candidate selection is clock-free; reconciliation owns the exact due
      // check (including injected scheduler clocks). NULL/capped requests have
      // no automatic recovery eligibility at all.
      expect(await events.needsSync(eventKey)).toBe(blocked === "future deadline");
      expect(await events.staleEventKeys()).toEqual(
        blocked === "future deadline" ? [eventKey] : [],
      );
      expect(sent).toHaveLength(1);
      expect(bot.upsertEvent).toHaveBeenCalledOnce();
      expect(await sql`select job_id from queue_jobs`).toEqual([]);
      expect(await events.pendingSync(eventKey)).toMatchObject({
        idempotencyKey: original.idempotencyKey,
        action: pending.action,
        payload: pending.payload,
        requestAttempts: blocked === "six requests" ? 6 : 1,
      });
      if (blocked === "future deadline") {
        // The scheduler's injected clock, not database now(), owns the exact
        // due boundary. No rewrite of the durable deadline is needed to recover.
        expect(
          await reconcileEvents({
            events,
            queue,
            lock: pgUniqueLock(sql),
            now: () => new Date(deadline.getTime() - 1),
          }),
        ).toEqual({ closed: 0, materialized: 0, resynced: 0 });
        expect(sent).toHaveLength(1);
        expect((await events.pendingSync(eventKey))!.nextAttemptAt).toEqual(deadline);
        expect(
          await reconcileEvents({ events, queue, lock: pgUniqueLock(sql), now: () => deadline }),
        ).toEqual({ closed: 0, materialized: 0, resynced: 1 });
        expect(sent[1]!.idempotencyKey).toBe(original.idempotencyKey);
        const dueDeps = { ...deps(bot), now: () => deadline };
        await consume({ messages: [delivery(sent[1]!)] }, dueDeps);
        expect(bot.upsertEvent.mock.calls[1]).toEqual([pending.payload, original.idempotencyKey]);
      }
    });
  }

  for (const status of ["past", "draft"] as const) {
    for (const prepared of [false, true]) {
      it(`never initiates an unattempted ${status} upsert (snapshot=${prepared})`, async () => {
        await seed();
        const original = await dispatch();
        if (prepared)
          expect(
            await events.prepareSync(eventKey, original.idempotencyKey, new Date()),
          ).toMatchObject({ state: "pending", requestAttempts: 0 });
        await sql`update events set status = ${status}`;
        expect(await events.needsSync(eventKey)).toBe(false);
        expect(await events.staleEventKeys()).toEqual([]);
        expect(await reconcile()).toEqual({ closed: 0, materialized: 0, resynced: 0 });
        const bot = botDouble();
        const message = delivery(original);
        await consume({ messages: [message] }, deps(bot));
        expect(message.ack).toHaveBeenCalledOnce();
        expect(message.retry).not.toHaveBeenCalled();
        expect(bot.upsertEvent).not.toHaveBeenCalled();
        expect(bot.cancelEvent).not.toHaveBeenCalled();
        expect(await sql`select synced_revision, discord_event_id from events`).toEqual([
          { synced_revision: "0", discord_event_id: null },
        ]);
        expect(await events.pendingSync(eventKey)).toBeNull();
        if (prepared)
          expect(await sql`select state, request_attempts from event_sync_attempts`).toEqual([
            { state: "obsolete", request_attempts: 0 },
          ]);
        expect(sent).toHaveLength(1);
        expect(await sql`select job_id from queue_jobs`).toEqual([]);
      });
    }
  }
});
