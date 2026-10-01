import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, updateEvent } from "../src/admin/store";
import type { EventFormInput } from "../src/admin/validation";
import type { JobsEnv } from "../src/env";
import { RECONCILE_CRON } from "../src/jobs/constants";
import { pgEventStore } from "../src/jobs/events";
import { uniqueKey } from "../src/jobs/sync-event";
import type { BotClient, QueueMessage } from "../src/jobs/types";
import { enqueueSyncEvent, handleQueue, handleScheduled } from "../src/jobs/worker";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

// Substitute only pool construction and the unwired bot transport. In particular,
// prepare/claim/complete, consume, reconciliation, locks and ledger are all real.
const transport = vi.hoisted(() => ({ bot: null as BotClient | null }));
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock(import("../src/jobs/sync-event"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, handleSyncEvent: (...[message, attempts, deps]: Parameters<typeof actual.handleSyncEvent>) => {
    if (!transport.bot) throw new Error("test bot not initialized");
    return actual.handleSyncEvent(message, attempts, { ...deps, bot: transport.bot });
  } };
});

const firstKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const secondKey = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;

function safeUrl(raw: string) {
  const url = testDatabaseUrl(raw);
  // Preserve the helper's localhost CI service allowance, which requires both
  // GITHUB_ACTIONS=true and CI=true; restrict the agent lane to its test database.
  if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") {
    throw new Error("jobs isolation requires the agent-testdb two_web_next database");
  }
  return url;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function delivery(body: SyncMessage) {
  return { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}
function botDouble() {
  return {
    upsertEvent: vi.fn<BotClient["upsertEvent"]>(async (payload) => ({
      ok: true, requestId: null, discordEventId: `discord-${payload.eventKey}`,
    })),
    cancelEvent: vi.fn<BotClient["cancelEvent"]>(async (payload) => ({
      ok: true, requestId: null, discordEventId: `discord-${payload.eventKey}`,
    })),
    postAnnouncement: vi.fn<BotClient["postAnnouncement"]>(),
    assignRole: vi.fn<BotClient["assignRole"]>(),
  } satisfies BotClient;
}
const controller = () => ({ cron: RECONCILE_CRON, scheduledTime: Date.now(), noRetry() {} });

// As in event-writeback, opt into actual PostgreSQL explicitly; never fall back
// to a developer, staging or production database, or to mocked SQL.
describe.skipIf(!process.env.DATABASE_URL)("job connection isolation (owned PostgreSQL schema)", () => {
  let fixture: MemberDataFixture | undefined;
  let realPostgres: typeof postgres;
  let control: postgres.Sql;
  let observer: postgres.Sql;
  let workerPools: postgres.Sql[];
  let applicationPrefix: string;
  let sent: SyncMessage[];
  let bot: ReturnType<typeof botDouble>;
  let env: JobsEnv;

  // Attach a rejection handler immediately to concurrent work, but preserve the
  // original promise for assertions and for allSettled in each test's finally.
  function start<T>(promise: Promise<T>) {
    void promise.catch(() => {});
    return promise;
  }
  beforeEach(async () => {
    const url = safeUrl(process.env.DATABASE_URL!);
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    workerPools = [];
    fixture = await createMemberDataFixture(url.href);
    applicationPrefix = `isolation_${fixture.schemaName}`;
    const options = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password,
      connection: { search_path: fixture.schemaName }, onnotice: () => {} };
    // Drizzle changes its own client's parsers. These native pools are separate
    // both from that client and from each other: never query control while its
    // max:1 connection is reserved by a held BEGIN; inspect through observer.
    control = realPostgres(url.href, options);
    observer = realPostgres(url.href, options);
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
      const checked = safeUrl(raw);
      expect(opts.max).toBe(1);
      const client = realPostgres(checked.href, {
        ...opts, port: 5432, password: () => checked.password,
        connection: { ...opts.connection, search_path: fixture!.schemaName,
          application_name: `${applicationPrefix}_${workerPools.length}` },
      });
      workerPools.push(client);
      return client;
    }) as typeof postgres);
    sent = [];
    bot = botDouble();
    transport.bot = bot;
    env = {
      DATABASE_URL: url.href,
      SYNC_EVENT_QUEUE: { send: async (body: unknown) => { sent.push(body as SyncMessage); } },
      INTERNAL_ACTION_QUEUE: { send: async () => {} },
    } as unknown as JobsEnv;
  }, 15_000);
  afterEach(async () => {
    transport.bot = null;
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    // Also dispose worker pools if an assertion made the worker exit early.
    try {
      await Promise.all((workerPools ?? []).map((pool) => pool.end({ timeout: 1 })));
    } finally {
      try {
        await Promise.all([control?.end({ timeout: 1 }), observer?.end({ timeout: 1 })]);
      } finally {
        await fixture?.dispose();
        fixture = undefined;
      }
    }
  }, 15_000);

  async function seedPublished(eventKey: string, title: string) {
    await control`insert into events (event_key, title, starts_at, ends_at, location, status)
      values (${eventKey}, ${title}, '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z', 'Voice', 'published')`;
  }
  async function recurringParent(title: string, missing = false) {
    const actor = { id: "test-user", username: "test-user" };
    const input: EventFormInput = { title, game: null, description: null,
      startsAtUtc: new Date("2099-01-11T18:00:00Z"), endsAtUtc: new Date("2099-01-11T19:00:00Z"),
      timezone: "UTC", location: "Voice", capacity: null };
    const { row: parent } = await createEvent(fixture!.db, actor, input,
      { frequency: "weekly", count: 3, endsOn: new Date("2099-01-18T00:00:00Z") });
    if (missing) {
      // Canonical overlap fixture: a date edit shifts the existing child and
      // makes index 3 eligible, but only reconciliation fills that missing row.
      await updateEvent(fixture!.db, actor, parent.eventKey, { ...input,
        startsAtUtc: new Date("2099-01-04T18:00:00Z"), endsAtUtc: new Date("2099-01-04T19:00:00Z") });
    }
    expect(await control`select recurrence_index from events where id = ${parent.id} or parent_event_id = ${parent.id}
      order by recurrence_index`).toEqual([{ recurrence_index: 1 }, { recurrence_index: 2 }]);
    return parent;
  }

  it("ACKs the next real sync while the first unique-lock DELETE still blocks the cleanup pool (PR68 finding 1)", async () => {
    await seedPublished(firstKey, "First sync");
    await seedPublished(secondKey, "Second sync");
    for (const eventKey of [firstKey, secondKey]) {
      expect(await enqueueSyncEvent(env, { kind: "sync-event", eventKey, idempotencyKey: crypto.randomUUID() })).toBe(true);
    }
    expect(sent).toHaveLength(2);
    expect(await control`select job_id, key from queue_jobs order by key`).toEqual(sent.map((body) => ({
      job_id: body.jobId, key: uniqueKey(body.eventKey),
    })));
    expect(await control`select key from job_unique_locks order by key`)
      .toEqual([firstKey, secondKey].map((key) => ({ key: uniqueKey(key) })));

    const releaseHolder = gate();
    let holdingLock = false;
    let holderPid = 0;
    let cleanupPid = 0;
    let holding: Promise<unknown> | undefined;
    let consuming: Promise<void> | undefined;
    const first = delivery(sent[0]!);
    const second = delivery(sent[1]!);
    try {
      holding = start(control.begin(async (tx) => {
        holderPid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
        expect(await tx`select key from job_unique_locks where key = ${uniqueKey(firstKey)} for update`).toHaveLength(1);
        holdingLock = true;
        await releaseHolder.promise;
      }));
      await vi.waitFor(() => expect(holdingLock).toBe(true), { timeout: 2000 });
      consuming = start(handleQueue({ messages: [first, second] } as unknown as MessageBatch<unknown>, env));
      // Inspect the server, not a timer assumption or a mocked lock promise.
      await vi.waitFor(async () => {
        const rows = await observer`select pid from pg_stat_activity
          where application_name like ${`${applicationPrefix}_%`} and state = 'active'
          and query like '%delete from job_unique_locks%'
          and ${holderPid} = any(pg_blocking_pids(pid))`;
        expect(rows).toHaveLength(1);
        cleanupPid = rows[0]!.pid;
      }, { interval: 10, timeout: 2000 });
      expect(first.ack).not.toHaveBeenCalled();
      // Real 2s release + 2s successor bounds run for each message. A max:1
      // handler contaminated by that DELETE cannot reach this second ACK.
      await vi.waitFor(() => {
        expect(second.ack).toHaveBeenCalledOnce();
        expect(bot.upsertEvent).toHaveBeenCalledTimes(2);
      }, { interval: 20, timeout: 10_000 });
      expect(first.ack).toHaveBeenCalledOnce();
      expect(first.retry).not.toHaveBeenCalled();
      expect(second.retry).not.toHaveBeenCalled();
      expect(bot.upsertEvent.mock.calls).toEqual(sent.map((body, i) => [
        expect.objectContaining({ eventKey: body.eventKey, name: i === 0 ? "First sync" : "Second sync" }),
        body.idempotencyKey,
      ]));
      const [wait] = await observer`select pg_blocking_pids(${cleanupPid}) as blockers`;
      expect(wait!.blockers).toContain(holderPid); // BEFORE releasing the holder
      expect(await observer`select state, request_attempts from event_sync_attempts order by payload->>'eventKey'`)
        .toEqual([{ state: "succeeded", request_attempts: 1 }, { state: "succeeded", request_attempts: 1 }]);
      expect(await observer`select event_key, sync_revision = synced_revision as clean from events order by event_key`)
        .toEqual([firstKey, secondKey].map((event_key) => ({ event_key, clean: true })));
      expect(await observer`select job_id from queue_jobs`).toEqual([]);
      expect(await observer`select job_id from queue_failed_jobs`).toEqual([]);
    } finally {
      releaseHolder.release();
      await Promise.allSettled([holding, consuming]);
    }
    await holding;
    await consuming;
    expect(await pgEventStore(observer).staleEventKeys()).toEqual([]);
  }, 15_000);

  it("commits preparation and frees recurring-parent locks before queue I/O, but keeps scheduler single flight (PR68 finding 3)", async () => {
    const filled = await recurringParent("Filled series");
    const missing = await recurringParent("Backfilled series", true);
    await seedPublished(firstKey, "Unrelated dirty event");
    const sendEntered = gate();
    const releaseSend = gate();
    const releaseEdit = gate();
    let sendHeld = false;
    let edited = false;
    let skipped = false;
    const rollback = new Error("rollback probe parent edit");
    const send = vi.fn(async (body: unknown) => {
      sent.push(body as SyncMessage);
      sendHeld = true;
      sendEntered.release();
      await releaseSend.promise;
      sendHeld = false;
    });
    const scheduledEnv = { ...env, SYNC_EVENT_QUEUE: { send } } as unknown as JobsEnv;
    let scheduled: Promise<void> | undefined;
    let editing: Promise<unknown> | undefined;
    let other: Promise<void> | undefined;
    try {
      scheduled = start(handleScheduled(controller(), scheduledEnv));
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 2000 });
      await sendEntered.promise;
      expect(sendHeld).toBe(true);
      expect(sent[0]).toMatchObject({ eventKey: firstKey, jobId: expect.any(String) });
      expect(await observer`select job_id from queue_jobs`).toEqual([{ job_id: sent[0]!.jobId }]);
      expect(await observer`select key from job_unique_locks`).toEqual([{ key: uniqueKey(firstKey) }]);
      editing = start(control.begin(async (tx) => {
        expect(await tx`update events set title = 'Uncommitted moderator edit' where id = ${filled.id} returning id`)
          .toEqual([{ id: filled.id }]);
        edited = true;
        await releaseEdit.promise;
        throw rollback;
      }));
      await vi.waitFor(() => expect(edited).toBe(true), { interval: 10, timeout: 2000 });
      expect(sendHeld).toBe(true); // UPDATE finished without releasing queue I/O
      // Both the new occurrence and its audit must already be committed while
      // the external send is held, not merely visible to the write transaction.
      const [child] = await observer`select event_key, starts_at, status from events
        where parent_event_id = ${missing.id} and recurrence_index = 3`;
      expect(child).toMatchObject({ starts_at: new Date("2099-01-18T18:00:00Z"), status: "draft" });
      expect(await observer`select causer_id, properties from activity_log where subject_id = ${child!.event_key}`)
        .toEqual([{ causer_id: null, properties: expect.objectContaining({ startsAt: expect.any(Object) }) }]);
      const advisoryLocks = () => observer`select l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and l.granted and a.application_name like ${`${applicationPrefix}_%`}`;
      expect(await advisoryLocks()).toHaveLength(1);
      other = start(handleScheduled(controller(), scheduledEnv).then(() => { skipped = true; }));
      // Keep the moderator's parent row locked too. A second pass that actually
      // reconciled (rather than skipping single flight) would block on it.
      await vi.waitFor(() => expect(skipped).toBe(true), { interval: 10, timeout: 2000 });
      expect(send).toHaveBeenCalledOnce();
      expect(sendHeld).toBe(true);
      expect(await advisoryLocks()).toHaveLength(1);
      releaseEdit.release();
      await expect(editing).rejects.toBe(rollback);
      expect(await observer`select title from events where id = ${filled.id}`).toEqual([{ title: "Filled series" }]);
    } finally {
      releaseEdit.release();
      releaseSend.release();
      await Promise.allSettled([scheduled, editing, other]);
    }
    await scheduled;
    await other;
    expect(await observer`select recurrence_index from events where parent_event_id = ${missing.id} order by recurrence_index`)
      .toEqual([{ recurrence_index: 2 }, { recurrence_index: 3 }]);
    expect(await observer`select recurrence_index from events where parent_event_id = ${filled.id}`)
      .toEqual([{ recurrence_index: 2 }]);
    expect(await observer`select job_id from queue_jobs`).toEqual([{ job_id: sent[0]!.jobId }]);
  }, 15_000);

  it("rolls back closeFinished and materialization together if the real preparation transaction fails", async () => {
    const parent = await recurringParent("Rollback series", true);
    await seedPublished(firstKey, "Finished event");
    await control`update events set starts_at = '2020-01-01T18:00:00Z', ends_at = '2020-01-01T19:00:00Z'
      where event_key = ${firstKey}`;
    const before = await control`select id from activity_log order by id`;
    // An actual database failure after inserting the missing child, not an
    // EventStore mock: its creation audit must fail in that same transaction.
    await control`create function reject_reconcile_audit() returns trigger language plpgsql as $$
      begin
        if new.causer_id is null and new.description like 'created event %' then
          raise exception 'test rejects recurrence audit';
        end if;
        return new;
      end;
    $$`;
    await control`create trigger reject_reconcile_audit before insert on activity_log
      for each row execute function reject_reconcile_audit()`;
    await expect(handleScheduled(controller(), env)).rejects.toMatchObject({
      cause: { message: "test rejects recurrence audit", code: "P0001" },
    });
    expect(await observer`select status from events where event_key = ${firstKey}`).toEqual([{ status: "published" }]);
    expect(await observer`select recurrence_index from events where parent_event_id = ${parent.id}`)
      .toEqual([{ recurrence_index: 2 }]);
    expect(await observer`select id from activity_log order by id`).toEqual(before);
    expect(sent).toEqual([]);
    expect(await observer`select job_id from queue_jobs`).toEqual([]);
    expect(await observer`select key from job_unique_locks`).toEqual([]);
  }, 15_000);
});
