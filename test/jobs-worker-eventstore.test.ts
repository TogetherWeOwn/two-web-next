import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { RECONCILE_CRON } from "../src/jobs/constants";
import { uniqueKey } from "../src/jobs/sync-event";
import { handleQueue, handleScheduled } from "../src/jobs/worker";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

// TOG-12444: worker wiring proof for the pg EventStore (TOG-11660).
//
// src/jobs/worker.ts used to wire all five EventStore methods to notWired
// stubs, so a deployed reconcile closed nothing. Orchestration is proved
// against fakes (test/jobs.test.ts, test/jobs-reconcile-counting.test.ts) and
// the adapter in isolation (test/event-store-pg.test.ts); these suites drive
// the real entry points — handleScheduled and handleQueue — against real
// Postgres on a disposable agent-testdb/CI schema. The bot client is the live
// signed client (#366): with no BOT_* configured a mirrored event ends as a
// terminal, alerting failure — settled failed, acked, never retried.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const controller = (cron: string) => ({ cron, scheduledTime: Date.now(), noRetry() {} });

describe.skipIf(!process.env.DATABASE_URL)("worker pg EventStore wiring (test Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let realPostgres: typeof postgres;
  let seq = 0;

  beforeEach(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
    const schemaName = fixture.schemaName;
    // Redirect only worker-created pools into this owned schema. Every pool
    // still has the worker's max:1 setting and must validate before connecting.
    vi.mocked(postgres).mockImplementation(((raw: string, options: postgres.Options<{}>) => {
      const url = testDatabaseUrl(raw);
      return realPostgres(url.href, {
        ...options,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: schemaName },
        onnotice: () => {},
      });
    }) as typeof postgres);
  });
  afterEach(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
    fixture = undefined;
  });

  async function seedEvent(s: {
    tag: string;
    status?: string;
    startsAt?: Date;
    endsAt?: Date;
  }): Promise<string> {
    const eventKey = `wire-${s.tag}-${Date.now()}-${seq++}`;
    await sql`insert into events (event_key, title, starts_at, ends_at, timezone, location, status)
      values (${eventKey}, ${`event ${s.tag}`},
        ${s.startsAt ?? new Date("2026-10-01T10:00:00Z")},
        ${s.endsAt ?? new Date("2026-10-01T14:00:00Z")},
        'Europe/London', 'hall', ${s.status ?? "published"})`;
    return eventKey;
  }

  const scheduledEnv = (send: (body: unknown) => Promise<unknown>) =>
    ({
      APP_URL: "https://example.test",
      DATABASE_URL: process.env.DATABASE_URL!,
      SYNC_EVENT_QUEUE: { send },
      INTERNAL_ACTION_QUEUE: { send: async () => {} },
    }) as unknown as JobsEnv;

  const queueEnv = () =>
    ({
      APP_URL: "https://example.test",
      DATABASE_URL: process.env.DATABASE_URL!,
    }) as unknown as JobsEnv;

  function carrier(eventKey: string, attempts = 1) {
    const m = {
      body: {
        kind: "sync-event",
        eventKey,
        idempotencyKey: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
      },
      attempts,
      acked: false,
      retried: undefined as number | undefined,
    };
    return Object.assign(m, {
      ack() {
        m.acked = true;
      },
      retry(o?: { delaySeconds?: number }) {
        m.retried = o?.delaySeconds;
      },
    });
  }

  it("reconcile through handleScheduled closes finished rows and dispatches only the stale key", async () => {
    const finishedKey = await seedEvent({
      tag: "finished",
      endsAt: new Date("2026-09-01T12:00:00Z"),
    });
    const liveKey = await seedEvent({
      tag: "live",
      startsAt: new Date("2026-10-01T10:00:00Z"),
      endsAt: new Date("2099-01-01T12:00:00Z"),
    });
    const sent: unknown[] = [];
    await handleScheduled(
      controller(RECONCILE_CRON),
      scheduledEnv(async (body) => void sent.push(body)),
    );
    // Close-before-resync: the ended row is past and never dispatched ...
    const statuses = Object.fromEntries(
      (
        (await sql`select event_key, status from events`) as {
          event_key: string;
          status: string;
        }[]
      ).map((r) => [r.event_key, r.status]),
    );
    expect(statuses).toMatchObject({ [finishedKey]: "past", [liveKey]: "published" });
    // ... while the still-stale key is dispatched exactly once.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: liveKey });
    // Dispatch committed its ledger row and uniqueness lock before the send.
    const jobs = await sql`select job_id, key from queue_jobs`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: uniqueKey(liveKey) });
    expect(await sql`select key from job_unique_locks`).toHaveLength(1);
  });

  it("queue consumer drops unknown keys via the real store and terminally settles mirrored events (unconfigured bot)", async () => {
    const liveKey = await seedEvent({
      tag: "queued",
      startsAt: new Date("2026-10-01T10:00:00Z"),
      endsAt: new Date("2099-01-01T12:00:00Z"),
    });
    // Unknown key: the real find returns null, so the message drops as done.
    // A stubbed find would throw and retry instead.
    const dropped = carrier("no-such-event");
    await handleQueue({ messages: [dropped] } as unknown as MessageBatch, queueEnv());
    expect(dropped.acked).toBe(true);
    expect(dropped.retried).toBeUndefined();
    // Mirrored row: the real find serves it, but the live bot client has no
    // BOT_* configured, so it throws BotTerminalError — a terminal failure
    // that is settled failed, logged, alerted and acked, never retried.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const mirrored = carrier(liveKey);
    await handleQueue({ messages: [mirrored] } as unknown as MessageBatch, queueEnv());
    expect(mirrored.acked).toBe(true);
    expect(mirrored.retried).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("unconfigured DB fails loudly on both entry points before any ack", async () => {
    const env = { APP_URL: "https://example.test" } as unknown as JobsEnv;
    await expect(handleScheduled(controller(RECONCILE_CRON), env)).rejects.toThrow(
      "no database configured",
    );
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: { kind: "alert-probe" }, attempts: 1, ack, retry }],
    } as unknown as MessageBatch;
    await expect(handleQueue(batch, env)).rejects.toThrow("no database configured");
    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
