import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { JobsEnv } from "../src/env";
import { RECONCILE_CRON } from "../src/jobs/constants";
import { pgEventStore } from "../src/jobs/events";
import { uniqueKey } from "../src/jobs/sync-event";
import type { BotClient, QueueMessage } from "../src/jobs/types";
import { enqueueSyncEvent, handleQueue, handleScheduled } from "../src/jobs/worker";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Only pool construction (to pin owned schemas) and the unwired bot transport
// are substituted. Worker lifetime, dispatch, SQL, consumer and cron are real.
const transport = vi.hoisted(() => ({ bot: null as BotClient | null }));
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock(import("../src/jobs/sync-event"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    handleSyncEvent: (...[message, attempts, deps]: Parameters<typeof actual.handleSyncEvent>) => {
      if (!transport.bot) throw new Error("test bot not initialized");
      return actual.handleSyncEvent(message, attempts, { ...deps, bot: transport.bot });
    },
  };
});

type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;
const firstKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const secondKey = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
function approvedUrl(raw: string) {
  const url = testDatabaseUrl(raw);
  if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") {
    throw new Error("worker lifetime tests require agent-testdb/two_web_next");
  }
  return url;
}
function gate() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, release, reject };
}
function delivery(body: SyncMessage) {
  return { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}
const controller = () => ({ cron: RECONCILE_CRON, scheduledTime: Date.now(), noRetry() {} });

describe.skipIf(!process.env.DATABASE_URL)(
  "actual worker successor lifetime (owned native PostgreSQL)",
  () => {
    let fixture: JobsFixture | undefined;
    let observer: postgres.Sql;
    let control: postgres.Sql;
    let realPostgres: typeof postgres;
    let pools: { sql: postgres.Sql; ended: boolean }[];
    let applicationPrefix: string;
    let sent: SyncMessage[];
    let env: JobsEnv;
    let background: Promise<unknown>[];
    let ctx: ExecutionContext;
    let warnings: MockInstance<typeof console.warn>;

    beforeEach(async () => {
      const url = approvedUrl(process.env.DATABASE_URL!);
      realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
      vi.mocked(postgres).mockImplementation(realPostgres);
      fixture = await createJobsFixture(url.href);
      observer = fixture.client; // Native Date codecs, not Drizzle's mutated pool.
      control = realPostgres(url.href, {
        max: 1,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      pools = [];
      applicationPrefix = `lifetime_${fixture.schemaName}`;
      vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
        const checked = approvedUrl(raw);
        expect(checked.href).toBe(url.href);
        expect(opts.max).toBe(1);
        const sql = realPostgres(checked.href, {
          ...opts,
          port: 5432,
          password: () => checked.password,
          connection: {
            ...opts.connection,
            search_path: fixture!.schemaName,
            application_name: `${applicationPrefix}_${pools.length}`,
          },
          onnotice: () => {},
        });
        const state = { sql, ended: false };
        const end = sql.end.bind(sql);
        sql.end = async (...args: Parameters<typeof sql.end>) => {
          await end(...args);
          state.ended = true;
        };
        pools.push(state);
        return sql;
      }) as typeof postgres);
      sent = [];
      env = {
        DATABASE_URL: url.href,
        SYNC_EVENT_QUEUE: {
          send: async (body: unknown) => {
            sent.push(body as SyncMessage);
          },
        },
        INTERNAL_ACTION_QUEUE: { send: async () => {} },
      } as unknown as JobsEnv;
      background = [];
      ctx = {
        waitUntil: vi.fn((work: Promise<unknown>) => {
          void work.catch(() => {});
          background.push(work);
        }),
      } as unknown as ExecutionContext;
      warnings = vi.spyOn(console, "warn");
    }, 15_000);

    afterEach(async () => {
      transport.bot = null;
      warnings?.mockRestore();
      if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
      try {
        await Promise.all((pools ?? []).map(({ sql }) => sql.end({ timeout: 1 })));
      } finally {
        try {
          await control?.end({ timeout: 1 });
        } finally {
          await fixture?.dispose();
          fixture = undefined;
        }
      }
    }, 15_000);

    async function prepare() {
      for (const [key, title] of [
        [firstKey, "First snapshot"],
        [secondKey, "Unrelated snapshot"],
      ]) {
        await observer`insert into events (event_key, title, starts_at, ends_at, location, status)
        values (${key!}, ${title!}, '2099-01-01T00:00:00Z', '2099-01-01T01:00:00Z', 'Voice', 'published')`;
        expect(
          await enqueueSyncEvent(env, {
            kind: "sync-event",
            eventKey: key!,
            idempotencyKey: crypto.randomUUID(),
          }),
        ).toBe(true);
      }
      expect(sent).toHaveLength(2);
      transport.bot = {
        upsertEvent: vi.fn<BotClient["upsertEvent"]>(async (payload) => {
          if (payload.eventKey === firstKey) {
            // Edit after the bot receives the immutable request; completion must
            // acknowledge only its old revision and dispatch the dirty successor.
            await observer`update events set title = 'Later revision' where event_key = ${firstKey}`;
          }
          return { ok: true, requestId: null, discordEventId: `discord-${payload.eventKey}` };
        }),
        cancelEvent: vi.fn(),
        postAnnouncement: vi.fn(),
        assignRole: vi.fn(),
      };
      const messages = sent.map(delivery);
      pools = []; // Subsequent records are precisely this handleQueue invocation.
      return messages;
    }
    function start(batch: ReturnType<typeof delivery>[]) {
      // Exercise the production entry with an actual waitUntil-shaped context.
      const work = handleQueue({ messages: batch } as unknown as MessageBatch<unknown>, env, ctx);
      void work.catch(() => {});
      return work;
    }
    async function expectAckAndShutdown(
      messages: ReturnType<typeof delivery>[],
      work: Promise<void>,
    ) {
      await vi.waitFor(
        () => {
          for (const message of messages) {
            expect(message.ack).toHaveBeenCalledOnce();
            expect(message.retry).not.toHaveBeenCalled();
          }
        },
        { interval: 10, timeout: 4000 },
      );
      await work;
      // The three existing handler, ledger and cleanup pools really ended. A
      // source-only consume test cannot detect a compensator using an ended pool.
      expect(pools.slice(0, 3)).toHaveLength(3);
      expect(pools.slice(0, 3).every(({ ended }) => ended)).toBe(true);
      expect(background).toHaveLength(1); // Production ctx owns the late continuation.
      expect(await observer`select state from event_sync_attempts order by event_id`).toEqual([
        { state: "succeeded" },
        { state: "succeeded" },
      ]);
    }
    async function awaitDispatchFailure() {
      await vi.waitFor(
        () =>
          expect(
            warnings.mock.calls.some(
              ([text]) => text === "sync successor dispatch failed; reconcile will retry",
            ),
          ).toBe(true),
        { timeout: 3000 },
      );
      await Promise.all(background);
    }
    async function recover() {
      transport.bot = {
        upsertEvent: vi.fn<BotClient["upsertEvent"]>(async (payload) => ({
          ok: true,
          requestId: null,
          discordEventId: `discord-${payload.eventKey}`,
        })),
        cancelEvent: vi.fn(),
        postAnnouncement: vi.fn(),
        assignRole: vi.fn(),
      };
      env.SYNC_EVENT_QUEUE = {
        send: async (body: unknown) => {
          sent.push(body as SyncMessage);
        },
      } as unknown as Queue;
      // TTL expiry is legitimate recovery, not age-based ledger deletion. Also
      // works on the red baseline whose late lock DELETE used an ended pool.
      await observer`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second'
      where key = ${uniqueKey(firstKey)}`;
      const before = sent.length;
      await handleScheduled(controller(), env);
      expect(sent).toHaveLength(before + 1);
      const message = delivery(sent.at(-1)!);
      await handleQueue({ messages: [message] } as unknown as MessageBatch<unknown>, env, ctx);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(await pgEventStore(observer).needsSync(firstKey)).toBe(false);
      expect(await observer`select job_id from queue_failed_jobs`).toEqual([]);
      expect(await observer`select job_id from queue_jobs`).toEqual([]);
    }

    for (const late of [false, true]) {
      it(`${late ? "late" : "immediate control"} rejected successor is compensated, including after pool shutdown and cron recovery`, async () => {
        const messages = await prepare();
        const held = gate();
        let successor: SyncMessage | undefined;
        env.SYNC_EVENT_QUEUE = {
          send: async (body: unknown) => {
            successor = body as SyncMessage;
            if (late) await held.promise;
            else throw new Error("local transport rejected successor");
          },
        } as unknown as Queue;
        const work = start(messages);
        try {
          await vi.waitFor(() => expect(successor).toBeDefined(), { timeout: 2000 });
          await expectAckAndShutdown(messages, work);
          expect(pools.every(({ ended }) => ended)).toBe(true);
          if (late) {
            expect(await observer`select job_id from queue_jobs`).toEqual([
              { job_id: successor!.jobId },
            ]);
            held.reject(new Error("local late transport rejection")); // AFTER actual pool end
          }
          await awaitDispatchFailure();
          expect.soft(await observer`select job_id from queue_jobs`).toEqual([]);
          expect(await pgEventStore(observer).needsSync(firstKey)).toBe(true);
          await recover(); // A clean revision must not hide the old orphan jobId.
        } finally {
          held.reject(new Error("test cleanup"));
          await Promise.allSettled([work, ...background]);
        }
      }, 20_000);
    }

    for (const expireGrace of [false, true]) {
      it(`accepted-late successor keeps its exact row and lock until its real consumer settles it (grace expired=${expireGrace})`, async () => {
        const messages = await prepare();
        const held = gate();
        let successor: SyncMessage | undefined;
        let accepted = false;
        env.SYNC_EVENT_QUEUE = {
          send: async (body: unknown) => {
            successor = body as SyncMessage;
            await held.promise;
            accepted = true;
          },
        } as unknown as Queue;
        // Control only the 30s extension callback. The consumer's actual 2s timer,
        // native SQL, ACK and pool shutdown still run on real wall-clock time.
        let expireLifetime: (() => void) | undefined;
        const realSetTimeout = globalThis.setTimeout;
        const timers = expireGrace
          ? vi.spyOn(globalThis, "setTimeout").mockImplementation(((
              ...args: Parameters<typeof setTimeout>
            ) => {
              if (args[1] === 30_000) expireLifetime = () => args[0](...args.slice(2));
              return realSetTimeout(...args);
            }) as typeof setTimeout)
          : undefined;
        const work = start(messages);
        try {
          await vi.waitFor(() => expect(successor).toBeDefined(), { timeout: 2000 });
          await expectAckAndShutdown(messages, work);
          expect(pools.every(({ ended }) => ended)).toBe(true);
          expect(await observer`select job_id from queue_jobs`).toEqual([
            { job_id: successor!.jobId },
          ]);
          if (expireGrace) {
            expect(expireLifetime).toBeTypeOf("function");
            expireLifetime!();
            await Promise.all(background); // Does not wait for the still-held send.
            expect(accepted).toBe(false);
            expect(
              warnings.mock.calls.some(
                ([text]) =>
                  text ===
                  "sync successor settlement lifetime expired; unsettled ledger rows remain tracked",
              ),
            ).toBe(true);
            expect(await observer`select job_id from queue_jobs`).toEqual([
              { job_id: successor!.jobId },
            ]);
          }
          held.release();
          await vi.waitFor(() => expect(accepted).toBe(true), { timeout: 2000 });
          await Promise.all(background);
          expect(await observer`select job_id from queue_jobs`).toEqual([
            { job_id: successor!.jobId },
          ]);
          expect(await observer`select key from job_unique_locks`).toEqual([
            { key: uniqueKey(firstKey) },
          ]);
          transport.bot = {
            upsertEvent: vi.fn<BotClient["upsertEvent"]>(async () => ({
              ok: true,
              requestId: null,
              discordEventId: "discord-late",
            })),
            cancelEvent: vi.fn(),
            postAnnouncement: vi.fn(),
            assignRole: vi.fn(),
          };
          const message = delivery(successor!);
          await handleQueue({ messages: [message] } as unknown as MessageBatch<unknown>, env, ctx);
          expect(message.ack).toHaveBeenCalledOnce();
          expect(message.retry).not.toHaveBeenCalled();
          expect(await pgEventStore(observer).needsSync(firstKey)).toBe(false);
          expect(await observer`select job_id from queue_jobs`).toEqual([]);
          expect(await observer`select key from job_unique_locks`).toEqual([]);
        } finally {
          held.release();
          await Promise.allSettled([work, ...background]);
          timers?.mockRestore();
        }
      }, 20_000);
    }

    for (const statementTimeout of [false, true]) {
      it(statementTimeout
        ? "a still-blocked native INSERT reaches its database timeout without holding ACK or leaking its pool"
        : "a native INSERT that commits after handler pool shutdown is cancelled before send and compensated", async () => {
        const messages = await prepare();
        // A server-side trigger holds only the successor INSERT, not handler SQL.
        // Its receipt proves a late COMMIT actually happened, not just a rolled
        // back statement or a fake ledger promise returning after a timer.
        await observer`create table successor_insert_receipts (job_id uuid primary key)`;
        await observer`create function hold_successor_insert() returns trigger language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA || ':successor-insert', 0));
          insert into successor_insert_receipts values (new.job_id);
          return new;
        end;
      $$`;
        await observer`create trigger hold_successor_insert after insert on queue_jobs
        for each row execute function hold_successor_insert()`;
        const held = gate();
        let holderPid = 0;
        let holderReady = false;
        const holding = control.begin(async (tx) => {
          holderPid = (await tx`select pg_backend_pid() as pid`)[0]!.pid;
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${fixture!.schemaName}:successor-insert`}, 0))`;
          holderReady = true;
          await held.promise;
        });
        void holding.catch(() => {});
        const send = vi.fn(async (_body: unknown) => {});
        env.SYNC_EVENT_QUEUE = { send } as unknown as Queue;
        let work: Promise<void> | undefined;
        try {
          await vi.waitFor(() => expect(holderReady).toBe(true), { timeout: 2000 });
          work = start(messages);
          const blocked = () => observer`select pid from pg_stat_activity
          where application_name like ${`${applicationPrefix}_%`} and state = 'active'
          and query like '%insert into queue_jobs%' and ${holderPid} = any(pg_blocking_pids(pid))`;
          await vi.waitFor(async () => expect(await blocked()).toHaveLength(1), {
            interval: 10,
            timeout: 2000,
          });
          await expectAckAndShutdown(messages, work);
          expect(send).not.toHaveBeenCalled();
          expect(await blocked()).toHaveLength(1); // Still server-side, AFTER shutdown.
          if (statementTimeout) {
            // Keep the actual server lock held until statement_timeout cancels the
            // query. waitUntil settlement is bounded independently of this holder.
            await Promise.all(background);
            expect(
              warnings.mock.calls.some((call) => String(call[1]).includes("statement timeout")),
            ).toBe(true);
            expect(await blocked()).toHaveLength(0);
            expect(pools.every(({ ended }) => ended)).toBe(true);
          }
          held.release();
          await holding;
          await awaitDispatchFailure();
          expect(send).not.toHaveBeenCalled(); // Deadline abort prevents a late send.
          expect(await observer`select job_id from successor_insert_receipts`).toHaveLength(
            statementTimeout ? 0 : 1,
          );
          expect(await observer`select job_id from queue_jobs`).toEqual([]);
          expect(await observer`select key from job_unique_locks`).toEqual([]);
          await observer`drop trigger hold_successor_insert on queue_jobs`;
          await recover();
        } finally {
          held.release();
          await Promise.allSettled([holding, work, ...background]);
        }
      }, 20_000);
    }
  },
);
