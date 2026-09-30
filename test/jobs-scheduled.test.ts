import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { uniqueKey } from "../src/jobs/sync-event";
import type { QueueMessage } from "../src/jobs/types";
import { handleScheduled } from "../src/jobs/worker";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

// Partial mocks retain the real scheduling, dispatch and Postgres operations.
// Only the currently unwired event adapter and local queue transport are fakes.
// https://vitest.dev/api/vi.html#vi-mock
const state = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock(import("../src/jobs/cron"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reconcileEvents: (deps: Parameters<typeof actual.reconcileEvents>[0]) => actual.reconcileEvents({
      ...deps,
      events: { ...deps.events, closeFinished: async () => 0, materializeSeries: async () => 0,
        staleEventKeys: async () => state.keys, pendingSyncKey: async () => null },
    }),
  };
});

const controller = (cron: string) => ({ cron, scheduledTime: Date.now(), noRetry() {} });
const envFor = (send: (body: unknown) => Promise<unknown>) => ({
  DATABASE_URL: process.env.DATABASE_URL!,
  SYNC_EVENT_QUEUE: { send },
  INTERNAL_ACTION_QUEUE: { send: async () => {} },
}) as unknown as JobsEnv;

describe.skipIf(!process.env.DATABASE_URL)("scheduled worker (test Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let realPostgres: typeof postgres;

  beforeEach(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
    state.keys = ["first", "second"];
    const schemaName = fixture.schemaName;
    // Redirect only worker-created pools into this owned schema. Every pool
    // still has the worker's max:1 setting and must validate before connecting.
    vi.mocked(postgres).mockImplementation(((raw: string, options: postgres.Options<{}>) => {
      const url = testDatabaseUrl(raw);
      return realPostgres(url.href, {
        ...options, port: 5432, connect_timeout: 5, password: () => url.password,
        connection: { search_path: schemaName }, onnotice: () => {},
      });
    }) as typeof postgres);
  });
  afterEach(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
    fixture = undefined;
  });

  it("keeps accepted ledger rows if a later send rolls back the flight", async () => {
    const accepted: QueueMessage[] = [];
    const env = envFor(async (body) => {
      const message = body as QueueMessage;
      if (message.kind === "sync-event" && message.eventKey === "second") throw new Error("later send failed");
      accepted.push(message);
    });
    await expect(handleScheduled(controller(RECONCILE_CRON), env)).rejects.toThrow("later send failed");
    expect(accepted).toHaveLength(1);
    const rows = await sql`select job_id, key from queue_jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: accepted[0]!.jobId, key: uniqueKey("first") });
    expect(await sql`select key from job_unique_locks where key = ${uniqueKey("first")}`).toHaveLength(1);
    // Flight rollback has released the advisory lock; this accepted job stays
    // observable while the failed send's compensated ledger row does not.
    state.keys = [];
    await handleScheduled(controller(RECONCILE_CRON), env);
    expect(await sql`select job_id from queue_jobs`).toHaveLength(1);
  });

  it("an early consumer sees and settles committed rows before flight completion", async () => {
    state.keys = ["first"];
    let consumed = false;
    const env = envFor(async (body) => {
      const message = body as QueueMessage;
      expect(message.jobId).toBeDefined();
      const [row] = await sql`select job_id from queue_jobs where job_id = ${message.jobId!}::uuid`;
      expect(row).toBeDefined();
      expect(await sql`select key from job_unique_locks where key = ${uniqueKey("first")}`).toHaveLength(1);
      const ledger = pgQueueLedger(sql);
      await ledger.reserved(message.jobId!);
      await ledger.dequeued(message.jobId!);
      await pgUniqueLock(sql).release(uniqueKey("first"));
      consumed = true;
    });
    await handleScheduled(controller(RECONCILE_CRON), env);
    expect(consumed).toBe(true);
    expect(await sql`select job_id from queue_jobs`).toHaveLength(0);
    expect(await sql`select key from job_unique_locks`).toHaveLength(0);
  });

  it("prune uses the reserved pool and creates sessions before the first web request", async () => {
    await sql`insert into join_attempts (outcome, source, request_id, created_at)
      values ('added', 'site', 'expired', now() - interval '91 days')`;
    const send = vi.fn(async (_body: unknown) => {});
    await handleScheduled(controller(PRUNE_CRON), envFor(send));
    expect(await sql`select id from join_attempts`).toHaveLength(0);
    expect(await sql`select token_hash from web_sessions`).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
