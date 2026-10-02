// TOG-11704: commit-before-dispatch proof.
//
// Ledger gap (docs/w15-events-acceptance-ledger.md:140,
// Integration/DiscordWriteBackTimingTest.php): the enqueue spies in
// test/events.test.ts and test/rsvp.test.ts cannot show that a real consumer
// observes dispatch only around a real SQL commit — never before it, and never
// for a rolled-back RSVP. This suite drives the real producer
// (dispatchSyncEvent over trackingQueue/pgQueueLedger/pgUniqueLock), the real
// consumer (consume/handleSyncEvent) and a SQL-backed EventStore against
// agent-testdb/CI Postgres, and observes both sides of commit and rollback.
//
// No src change: routes already dispatch after commit; this is the missing
// observation. The store's stale predicate is the reconcile one from
// src/jobs/types.ts: published, with no Discord id or any unstamped answer.
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transitionEvent } from "../src/admin/store";
import { newEventKey } from "../src/admin/validation";
import { events } from "../src/db/admin-schema";
import { writeRsvp } from "../src/events/rsvp";
import { consume } from "../src/jobs/consumer";
import { trackingQueue } from "../src/jobs/ledger";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { dispatchSyncEvent, handleSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import type { BotClient, EventStore } from "../src/jobs/types";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Static containment pin: the guard below refuses non-test URLs before any
// driver exists. Always runs, needs no database.
describe("commit-before-dispatch test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("commit-before-dispatch (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  // Raw jobs pool (test/helpers/jobs-db.ts pattern): drizzle installs
  // transparent date serializers on the fixture client, so Dates go over the
  // wire as strings there. Jobs code binds native Date parameters, so the
  // ledger, locks and SQL store below need their own raw pool in the same
  // schema. Ended before the fixture drops its schema.
  let raw: postgres.Sql;
  // Shared across the suite's bot spies; reset in beforeEach.
  let botCalls: { payload: unknown; idempotencyKey: string }[];

  const bot = () =>
    ({
      upsertEvent: async (payload: unknown, idempotencyKey: string) => {
        botCalls.push({ payload, idempotencyKey });
        return { ok: true as const, requestId: null, discordEventId: "discord-cbd-1" };
      },
    }) as unknown as BotClient;

  function sqlStore(): EventStore {
    const sql = raw;
    type Row = {
      id: number;
      event_key: string;
      title: string;
      starts_at: Date;
      ends_at: Date | null;
      location: string | null;
      description: string | null;
      status: string;
      discord_event_id: string | null;
    };
    return {
      find: async (eventKey) => {
        const [row] = (await sql`select id, event_key, title, starts_at, ends_at, location,
          description, status, discord_event_id from events where event_key = ${eventKey}`) as unknown as Row[];
        if (!row) return null;
        const unsynced = (await sql`select 1 as one from rsvps
          where event_id = ${row.id} and synced_to_discord_at is null limit 1`) as unknown as {
          one: number;
        }[];
        return {
          eventKey: row.event_key,
          payload: {
            eventKey: row.event_key,
            name: row.title,
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at ? row.ends_at.toISOString() : null,
            location: row.location ?? "",
            description: row.description,
          },
          mirrored:
            row.status === "published" && (row.discord_event_id === null || unsynced.length > 0),
        };
      },
      recordMirrored: async (eventKey, discordEventId, mirroredAt) => {
        const [row] =
          (await sql`select id from events where event_key = ${eventKey}`) as unknown as {
            id: number;
          }[];
        if (!row) return;
        await sql`update events set discord_event_id = ${discordEventId} where id = ${row.id}`;
        // The interface stamps only answers written at or before the mirror instant.
        await sql`update rsvps set synced_to_discord_at = ${mirroredAt}
          where event_id = ${row.id} and updated_at <= ${mirroredAt}`;
      },
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    };
  }

  function carrier(body: unknown, attempts = 1) {
    const m = { body, attempts, acked: false, retried: undefined as number | "now" | undefined };
    return Object.assign(m, {
      ack() {
        m.acked = true;
      },
      retry(o?: { delaySeconds?: number }) {
        m.retried = o?.delaySeconds ?? "now";
      },
    });
  }

  // Seeded published rows arrive already mirrored with no answers: not stale,
  // so a stray carrier for them must drop without a bot call.
  async function seed(status: "draft" | "published") {
    const [row] = await fixture.db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: "Commit night",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 2 * 3600_000),
        timezone: "UTC",
        status,
        capacity: 8,
        discordEventId: status === "published" ? "discord-seed-1" : null,
      })
      .returning();
    return { key: row!.eventKey, id: row!.id };
  }

  // The route order: the row transaction commits first, then the real producer
  // enrols the ledger row and lock and hands the transport its carrier.
  async function dispatchAfterCommit(eventKey: string): Promise<unknown[]> {
    const captured: unknown[] = [];
    const dispatched = await dispatchSyncEvent(
      trackingQueue(
        { send: async (body: unknown) => void captured.push(body) },
        pgQueueLedger(raw),
      ),
      pgUniqueLock(raw),
      eventKey,
    );
    expect(dispatched).toBe(true);
    expect(captured).toHaveLength(1);
    return captured;
  }

  async function consumeOnce(body: unknown) {
    const m = carrier(body);
    await consume(
      { messages: [m] },
      { bot: bot(), events: sqlStore(), lock: pgUniqueLock(raw), ledger: pgQueueLedger(raw) },
    );
    return m;
  }

  beforeAll(async () => {
    // Pool width covers a held write transaction plus the racing consumer
    // observation on its own connection (W9 race suites use the same width).
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 20 });
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    raw = postgres(url.href, {
      max: 5,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  });
  beforeEach(async () => {
    await fixture.reset();
    // Tables the member-data reset does not own: the queue ledger, the
    // uniqueness locks and the RSVP write budget.
    await raw`delete from queue_failed_jobs`;
    await raw`delete from queue_jobs`;
    await raw`delete from job_unique_locks`;
    await fixture.client`delete from web_throttle_hits`;
    botCalls = [];
  });
  afterAll(async () => {
    try {
      await raw?.end({ timeout: 1 });
    } finally {
      await fixture?.dispose();
    }
  });

  it("a rolled-back RSVP leaves no row, ledger enrolment or lock; its stray carrier consumes to nothing", async () => {
    const { key, id } = await seed("published");
    const captured: unknown[] = [];
    const transport = { send: async (body: unknown) => void captured.push(body) };
    await expect(
      raw.begin(async (tx) => {
        // postgres.js transaction client: the same tx owns the RSVP write, the
        // ledger enrolment and the uniqueness lock, so all three share fate.
        const txSql = tx as unknown as postgres.Sql;
        await txSql`insert into rsvps (event_id, user_id, status) values (${id}, 'rollback-member', 'going')`;
        const dispatched = await dispatchSyncEvent(
          trackingQueue(transport, pgQueueLedger(txSql)),
          pgUniqueLock(txSql),
          key,
        );
        expect(dispatched).toBe(true);
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");

    // The transport send already fired, but nothing durable escaped the abort.
    expect(captured).toHaveLength(1);
    expect(await raw`select job_id from queue_jobs`).toHaveLength(0);
    expect(await raw`select key from job_unique_locks`).toHaveLength(0);
    expect(await raw`select id from rsvps where event_id = ${id}`).toHaveLength(0);

    // The real consumer drops the stray carrier: the store reports nothing
    // stale, so the bot is never called and the ledger stays empty.
    const m = await consumeOnce(captured[0]);
    expect(m.acked).toBe(true);
    expect(botCalls).toHaveLength(0);
    expect(await raw`select job_id from queue_jobs`).toHaveLength(0);
    expect(await raw`select id from queue_failed_jobs`).toHaveLength(0);
    const [row] =
      (await raw`select discord_event_id from events where event_key = ${key}`) as unknown as {
        discord_event_id: string | null;
      }[];
    expect(row!.discord_event_id).toBe("discord-seed-1");
  });

  it("a committed RSVP dispatches after commit and the real consumer mirrors exactly once", async () => {
    const { key, id } = await seed("published");
    const written = await writeRsvp(fixture.db, key, "commit-member", "going");
    expect(written.ok).toBe(true);

    const captured = await dispatchAfterCommit(key);
    // The enrolment is durable before any consumer runs, under the sync key.
    const jobs = (await raw`select job_id, key from queue_jobs`) as unknown as {
      job_id: string;
      key: string;
    }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.key).toBe(uniqueKey(key));

    const m = await consumeOnce(captured[0]);
    expect(m.acked).toBe(true);
    expect(botCalls).toHaveLength(1);
    expect(botCalls[0]!.payload).toMatchObject({ eventKey: key, name: "Commit night" });
    expect(botCalls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // Terminal success drains the ledger and frees the lock ...
    expect(await raw`select job_id from queue_jobs`).toHaveLength(0);
    expect(await raw`select key from job_unique_locks`).toHaveLength(0);
    // ... and stamps the mirror on the event and its answer.
    const [ev] =
      (await raw`select discord_event_id from events where event_key = ${key}`) as unknown as {
        discord_event_id: string | null;
      }[];
    expect(ev!.discord_event_id).toBe("discord-cbd-1");
    const [answer] =
      (await raw`select synced_to_discord_at from rsvps where event_id = ${id}`) as unknown as {
        synced_to_discord_at: Date | null;
      }[];
    expect(answer!.synced_to_discord_at).not.toBeNull();
  });

  it("a consumer racing the write sees nothing until commit, then mirrors", async () => {
    const { key, id } = await seed("published");
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const txPromise = raw.begin(async (tx) => {
      await tx`insert into rsvps (event_id, user_id, status) values (${id}, 'early-member', 'going')`;
      ready();
      await held;
    });
    await Promise.race([readyPromise, txPromise]);
    try {
      // The uncommitted answer is invisible at READ COMMITTED: nothing is
      // stale, so the handler drops the message without calling the bot.
      expect((await sqlStore().find(key))!.mirrored).toBe(false);
      const outcome = await handleSyncEvent({ eventKey: key, idempotencyKey: "early-key" }, 1, {
        bot: bot(),
        events: sqlStore(),
      });
      expect(outcome).toEqual({ done: true });
      expect(botCalls).toHaveLength(0);
    } finally {
      release();
      await txPromise;
    }
    // After commit the same key is stale and the consumer mirrors it.
    expect((await sqlStore().find(key))!.mirrored).toBe(true);
    const m = await consumeOnce({ kind: "sync-event", eventKey: key, idempotencyKey: "late-key" });
    expect(m.acked).toBe(true);
    expect(botCalls).toHaveLength(1);
    const [answer] =
      (await raw`select synced_to_discord_at from rsvps where event_id = ${id}`) as unknown as {
        synced_to_discord_at: Date | null;
      }[];
    expect(answer!.synced_to_discord_at).not.toBeNull();
  });

  it("a committed publish dispatches after commit and the real consumer mirrors it", async () => {
    const { key } = await seed("draft");
    const { row, writeBack } = await transitionEvent(
      fixture.db,
      { id: "moderator", username: "mod" },
      key,
      "published",
    );
    expect(row.status).toBe("published");
    expect(writeBack).toEqual({ eventKey: key, status: "published" });

    // Routes dispatch the write-back only after this commit; mirror that order.
    const captured = await dispatchAfterCommit(key);
    const m = await consumeOnce(captured[0]);
    expect(m.acked).toBe(true);
    expect(botCalls).toHaveLength(1);
    expect(botCalls[0]!.payload).toMatchObject({ eventKey: key, name: "Commit night" });
    expect(await raw`select job_id from queue_jobs`).toHaveLength(0);
    const [ev] =
      (await raw`select discord_event_id from events where event_key = ${key}`) as unknown as {
        discord_event_id: string | null;
      }[];
    expect(ev!.discord_event_id).toBe("discord-cbd-1");
  });
});
