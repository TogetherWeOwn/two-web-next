import { eq, sql as querySql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, events, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createEvent, materializeMissingInstances } from "../src/admin/store-event-writes";
import { reconcileEvents } from "../src/jobs/cron";
import { pgEventStore } from "../src/jobs/events";
import { pgSingleFlight } from "../src/jobs/postgres";
import { reconcileWriteTransaction } from "../src/jobs/worker";
import { anonCacheGeneration, readAnonCache, writeAnonCache } from "../src/events/anon-cache";
import {
  apiPublicCacheGeneration,
  readApiPublicCache,
  writeApiPublicCache,
} from "../src/public-data/cache";
import { cachedFeatured } from "../src/home-cache";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";
import {
  expectedCreationProperties,
  SERIES_ACTOR,
  SERIES_CREATOR,
  seriesParent,
} from "./series-materialization-batch.fixture";

type Statement = { text: string; params: unknown[] };
type Client = postgres.Sql | postgres.TransactionSql;
const input = (() => {
  const row = seriesParent();
  return {
    title: row.title,
    game: row.game,
    description: row.description,
    accessibilityNotes: row.accessibilityNotes ?? null,
    startsAtUtc: row.startsAt,
    endsAtUtc: row.endsAt,
    timezone: row.timezone,
    location: row.location,
    organizer_name: row.organizer_name,
    join_url: row.join_url,
    join_instructions: row.join_instructions,
    capacity: row.capacity,
  };
})();

function firstInsertValue(statement: Statement, table: string, column: string): unknown {
  const match = new RegExp(`^insert into "${table}" \\(([^)]+)\\) values \\(([^)]+)\\)`, "i").exec(
    statement.text,
  );
  if (!match) return undefined;
  const columns = match[1]!.split(", ").map((part) => part.replaceAll('"', ""));
  const token = match[2]!.split(", ")[columns.indexOf(column)];
  const parameter = token && /^\$(\d+)$/.exec(token);
  return parameter ? statement.params[Number(parameter[1]) - 1] : undefined;
}
function isChildInsert(statement: Statement): boolean {
  return firstInsertValue(statement, "events", "parent_event_id") != null;
}
function isChildAudit(statement: Statement): boolean {
  const value = firstInsertValue(statement, "activity_log", "properties");
  const props = typeof value === "string" ? JSON.parse(value) : value;
  return (props?.recurrenceIndex?.after ?? 0) > 1;
}

/** Use real SQL/transactions without changing the raw job client's timestamp parsers. */
function dbOn(
  client: Client,
  options: {
    scoped?: boolean;
    corruptChildReturn?: "missing" | "duplicate" | "wrong-key";
    beforeCommit?: () => Promise<void> | void;
  } = {},
): Db {
  const db = drizzle(async (query, params, _method, typings) => {
    const rows = await client
      .unsafe(
        query,
        params.map((value, index) =>
          typings?.[index] === "json" && typeof value === "string" ? JSON.parse(value) : value,
        ) as never[],
      )
      .values();
    if (options.corruptChildReturn && isChildInsert({ text: query, params })) {
      if (options.corruptChildReturn === "missing") return { rows: [] };
      if (options.corruptChildReturn === "duplicate") {
        return { rows: rows.length === 1 ? [rows[0], rows[0]] : rows.map(() => rows[0]) };
      }
      const projection = query.split(" returning ")[1]!.split(", ");
      const keyColumn = projection.indexOf('"event_key"');
      const corrupted = rows.map((row) => [...row]);
      corrupted[0]![keyColumn] = "01K00000000000000000000099";
      return { rows: corrupted };
    }
    return { rows };
  });
  return Object.assign(db, {
    transaction: async (work: (tx: Db) => Promise<unknown>) => {
      if (options.scoped) throw new Error("nested transaction on reserved max:1 client");
      return (client as postgres.Sql).begin(async (tx) => {
        const result = await work(dbOn(tx, { ...options, scoped: true }));
        await options.beforeCommit?.();
        return result;
      });
    },
  }) as unknown as Db;
}

function counts(statements: Statement[]) {
  return {
    child_statements: statements.filter(isChildInsert).length,
    audit_statements: statements.filter(isChildAudit).length,
  };
}

function receipt(
  caseId: string,
  count: number,
  created: number,
  children: number,
  audits: number,
  statements: Statement[],
  rolledBack: boolean,
) {
  const actual = { created, children, audits, ...counts(statements) };
  const expected = {
    created: count - 1,
    children: count - 1,
    audits: count - 1,
    child_statements: count === 1 ? 0 : 1,
    audit_statements: count === 1 ? 0 : 1,
  };
  const matched = Object.entries(expected).every(
    ([key, value]) => actual[key as keyof typeof actual] === value,
  );
  const result = {
    version: 1,
    suite_id: "weekly-series-materialization",
    case_id: caseId,
    verdict: matched ? "pass" : "fail",
    error_code: matched ? null : "SERIES_BATCH_MISMATCH",
    next_action: matched
      ? "Keep the fixture checks with the implementation."
      : "Batch missing child rows and per-child creation audits, then rerun this fixture.",
    counts: actual,
    expected,
    rolled_back: rolledBack,
  };
  console.info(JSON.stringify(result));
  expect(actual, `${result.error_code ?? caseId}: ${result.next_action}`).toEqual(expected);
}

describe("weekly series bounded materialization — disposable Postgres acceptance", () => {
  let fixture: JobsFixture | undefined;
  let client: postgres.Sql;
  let db: Db;
  let statements: Statement[];
  let peers: postgres.Sql[];

  beforeEach(async () => {
    // Deliberately unconditional: a missing/refused URL is a failure, never a green skipped proof.
    const target = testDatabaseUrl(process.env.DATABASE_URL ?? "");
    fixture = await createJobsFixture(target.href);
    client = fixture.client;
    db = dbOn(client);
    statements = [];
    peers = [];
    client.options.debug = (_connection, text, params) => {
      statements.push({ text, params: [...params] });
    };
  });
  afterEach(async () => {
    for (const peer of peers ?? []) await peer.end({ timeout: 1 });
    await fixture?.dispose();
    fixture = undefined;
  });

  function peer() {
    const url = testDatabaseUrl(process.env.DATABASE_URL ?? "");
    const sql = postgres(url.href, {
      max: 1,
      password: () => url.password,
      connection: { search_path: fixture!.schemaName },
      onnotice: () => {},
    });
    peers.push(sql);
    return sql;
  }
  async function parent(count: number, status = "draft", title = input.title) {
    const [row] = await db
      .insert(events)
      .values({
        title,
        game: input.game,
        description: input.description,
        accessibilityNotes: input.accessibilityNotes,
        startsAt: input.startsAtUtc,
        endsAt: input.endsAtUtc,
        timezone: input.timezone,
        location: input.location,
        organizer_name: input.organizer_name,
        join_url: input.join_url,
        join_instructions: input.join_instructions,
        capacity: input.capacity,
        eventKey: crypto.randomUUID(),
        createdBy: SERIES_CREATOR,
        status,
        recurrenceFrequency: "weekly",
        recurrenceCount: count,
        recurrenceIndex: 1,
      })
      .returning();
    return row!;
  }
  async function rows() {
    return db.select().from(events).orderBy(events.recurrenceIndex);
  }
  async function audits() {
    return db.select().from(activityLog).orderBy(activityLog.id);
  }
  async function assertEmptyQueue() {
    const [row] = await client`select
      (select count(*)::int from queue_jobs) as jobs,
      (select count(*)::int from queue_failed_jobs) as failed,
      (select count(*)::int from event_sync_attempts) as attempts`;
    expect(row).toEqual({ jobs: 0, failed: 0, attempts: 0 });
  }
  function primeCaches() {
    const source = { db, discord: null, appUrl: "https://example.com" };
    const key = "GET /events-series-fixture";
    const apiKey = "GET /api/public/events?limit=20&page=1";
    writeAnonCache(
      key,
      source,
      { status: 200, cacheControl: "public", vary: null, body: "before commit" },
      60_000,
    );
    writeApiPublicCache(apiKey, { status: 200, headers: {}, body: "before commit" });
    return {
      anon: anonCacheGeneration(),
      api: apiPublicCacheGeneration(),
      intact() {
        expect(anonCacheGeneration()).toBe(this.anon);
        expect(apiPublicCacheGeneration()).toBe(this.api);
        expect(readAnonCache(key, source)?.body).toBe("before commit");
        expect(readApiPublicCache(apiKey)?.body).toBe("before commit");
      },
      retired() {
        expect(anonCacheGeneration()).toBe(this.anon + 1);
        expect(apiPublicCacheGeneration()).toBe(this.api + 1);
        expect(readAnonCache(key, source)).toBeNull();
        expect(readApiPublicCache(apiKey)).toBeNull();
      },
    };
  }

  // Break: a long create still pays one child INSERT and one audit INSERT per week.
  it.each([1, 26, 52])(
    "create.%i: moderator draft creation uses bounded batches and accurate audits",
    async (count) => {
      const cache = primeCaches();
      const result = await createEvent(
        dbOn(client, { beforeCommit: () => cache.intact() }),
        SERIES_ACTOR,
        input,
        { frequency: "weekly", count, endsOn: null },
      );
      const observed = [...statements];
      const saved = await rows();
      const logs = await audits();
      expect(result.writeBack).toBeNull();
      expect(saved).toHaveLength(count);
      expect(saved.every((row) => row.status === "draft")).toBe(true);
      expect(logs).toHaveLength(count);
      expect(new Set(saved.map((row) => row.eventKey)).size).toBe(count);
      for (const child of saved.filter((row) => row.parentEventId !== null)) {
        const log = logs.filter((row) => row.subjectId === child.eventKey);
        expect(log).toHaveLength(1);
        expect(child).toMatchObject({ parentEventId: result.row.id, createdBy: SERIES_ACTOR.id });
        expect(log[0]).toMatchObject({
          subjectType: "Event",
          causerId: SERIES_ACTOR.id,
          properties: expectedCreationProperties(child, result.row.id, SERIES_ACTOR.id),
        });
      }
      const budget = observed.findIndex((q) => q.text.includes("set_config"));
      const firstWrite = observed.findIndex((q) => /^insert into/.test(q.text));
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThan(firstWrite);
      expect(observed[budget]!.params).toEqual(["2000ms", "2000ms"]);
      expect(observed[budget]!.text.match(/true/g)).toHaveLength(2);
      cache.retired();
      await assertEmptyQueue();
      receipt(
        `create.${count}`,
        count,
        saved.length - 1,
        saved.length - 1,
        logs.filter((log) => log.subjectId !== result.row.eventKey).length,
        observed,
        false,
      );
    },
  );

  // The existing test runner + JSON reporter is the fixture command surface; each run owns its schema.
  it.each([1, 26, 52])(
    "rollback.%i: receipt check is repeatable and leaves no child or audit behind",
    async (count) => {
      const seed = await parent(count);
      statements.length = 0;
      const rollback = new Error("fixture rollback boundary");
      let snapshot: { created: number; children: number; audits: number } | undefined;
      await expect(
        client.begin(async (tx) => {
          const scoped = dbOn(tx, { scoped: true });
          const created = await materializeMissingInstances(scoped, seed);
          const children = await scoped
            .select()
            .from(events)
            .where(eq(events.parentEventId, seed.id));
          const logs = await scoped.select().from(activityLog);
          expect(await materializeMissingInstances(scoped, seed)).toBe(0);
          snapshot = { created, children: children.length, audits: logs.length };
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      const observed = [...statements];
      expect(await rows()).toEqual([seed]);
      expect(await audits()).toEqual([]);
      await assertEmptyQueue();
      expect(observed.some((q) => /^rollback/i.test(q.text))).toBe(true);
      expect(snapshot).toBeDefined();
      receipt(
        `rollback.${count}`,
        count,
        snapshot!.created,
        snapshot!.children,
        snapshot!.audits,
        observed,
        true,
      );
    },
  );

  // Break: reconcile uses a pool read instead of its reserved transaction, loses FOR UPDATE or emits draft jobs.
  it.each([1, 26, 52])(
    "reconcile.%i: single-flight caller preserves parent locks and returns exact created count",
    async (count) => {
      const seed = await parent(count);
      const sends: unknown[] = [];
      const outer = peer();
      const contender = peer();
      statements.length = 0;
      let result: Awaited<ReturnType<typeof reconcileEvents>> | undefined;
      const flightName = `series-fixture-${fixture!.schemaName}`;
      expect(
        await pgSingleFlight(outer)(flightName, async () => {
          expect(
            await pgSingleFlight(contender)(flightName, async () => {
              throw new Error("overlapping flight ran");
            }),
          ).toBe(false);
          result = await reconcileEvents({
            events: pgEventStore(client),
            writeTransaction: reconcileWriteTransaction(client),
            queue: {
              send: async (body) => {
                sends.push(body);
              },
            },
            lock: {
              acquire: async () => {
                throw new Error("draft requested a queue lease");
              },
              release: async () => {},
            },
            now: () => new Date("2029-12-31T12:00:00Z"),
          });
        }),
      ).toBe(true);
      const observed = [...statements];
      expect(result).toEqual({
        closed: 0,
        materialized: count - 1,
        resynced: 0,
        absorbed: 0,
        failed: 0,
        deferred: 0,
      });
      expect(sends).toEqual([]);
      const saved = await rows();
      const logs = await audits();
      expect(saved).toHaveLength(count);
      expect(saved[0]).toEqual(seed);
      for (const child of saved.slice(1)) {
        expect(child).toMatchObject({
          status: "draft",
          createdBy: SERIES_CREATOR,
          parentEventId: seed.id,
        });
        const log = logs.filter((entry) => entry.subjectId === child.eventKey);
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          causerId: null,
          properties: expectedCreationProperties(child, seed.id),
        });
      }
      const lock = observed.findIndex(
        (q) => /from "events"/.test(q.text) && /for update/i.test(q.text),
      );
      const budget = observed.findIndex((q) => q.text.includes("set_config"));
      expect(lock).toBeGreaterThan(budget);
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(observed[budget]!.params).toEqual(["5000ms", "5000ms"]);
      expect(observed[budget]!.text.match(/true/g)).toHaveLength(2);
      const before = await audits();
      statements.length = 0;
      expect(
        await reconcileWriteTransaction(client)(async (store) => ({
          closed: 0,
          materialized: await store.materializeSeries(),
          stale: [],
        })),
      ).toEqual({ closed: 0, materialized: 0, stale: [] });
      expect(counts(statements)).toEqual({ child_statements: 0, audit_statements: 0 });
      expect(await audits()).toEqual(before);
      expect(await rows()).toEqual(saved);
      await assertEmptyQueue();
      receipt(
        `reconcile.${count}`,
        count,
        result!.materialized,
        saved.length - 1,
        logs.length,
        observed,
        false,
      );
    },
  );

  it("reconcile.partial: cancelled/existing indices and parent data stay untouched", async () => {
    const seed = await parent(6, "published");
    await db
      .update(events)
      .set({ syncedRevision: seed.syncRevision })
      .where(eq(events.id, seed.id));
    for (const [index, status] of [
      [2, "cancelled"],
      [4, "published"],
    ] as const) {
      await db.insert(events).values({
        eventKey: crypto.randomUUID(),
        title: "Individually edited",
        startsAt: new Date("2030-01-13T20:00:00Z"),
        endsAt: new Date("2030-01-13T22:00:00Z"),
        parentEventId: seed.id,
        recurrenceIndex: index,
        status,
        createdBy: "different-host",
      });
    }
    const before = await rows();
    statements.length = 0;
    expect(
      await reconcileWriteTransaction(client)(async (store) => ({
        closed: 0,
        materialized: await store.materializeSeries(),
        stale: [],
      })),
    ).toEqual({ closed: 0, materialized: 3, stale: [] });
    const observed = [...statements];
    const saved = await rows();
    expect(saved.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
    expect(
      saved
        .filter((row) => !before.some((old) => old.id === row.id))
        .map((row) => row.recurrenceIndex),
    ).toEqual([3, 5, 6]);
    expect(counts(observed)).toEqual({ child_statements: 1, audit_statements: 1 });
  });

  it.each(["missing", "duplicate", "wrong-key"] as const)(
    "create.returning.%s: mismatched driver result rolls the real transaction back",
    async (fault) => {
      const cache = primeCaches();
      await expect(
        createEvent(dbOn(client, { corruptChildReturn: fault }), SERIES_ACTOR, input, {
          frequency: "weekly",
          count: 4,
          endsOn: null,
        }),
      ).rejects.toThrow();
      expect(await rows()).toEqual([]);
      expect(await audits()).toEqual([]);
      await assertEmptyQueue();
      cache.intact();
    },
  );

  // Break: inserting children outside the caller transaction, suppressing a failed invariant or swallowing audit failure.
  it.each(["child", "audit"] as const)(
    "create.failure.%s: no parent, child or audit can partially commit",
    async (failure) => {
      if (failure === "child")
        await db.execute(
          querySql`alter table events add constraint series_fixture_child_failure check (recurrence_index is distinct from 4)`,
        );
      else
        await db.execute(
          querySql`alter table activity_log add constraint series_fixture_audit_failure check ((properties->'recurrenceIndex'->>'after')::int is distinct from 4)`,
        );
      const cache = primeCaches();
      await expect(
        createEvent(db, SERIES_ACTOR, input, { frequency: "weekly", count: 4, endsOn: null }),
      ).rejects.toThrow();
      expect(await rows()).toEqual([]);
      expect(await audits()).toEqual([]);
      await assertEmptyQueue();
      cache.intact();
    },
  );

  it.each(["child", "audit"] as const)(
    "reconcile.failure.%s: every parent's work rolls back with the failed prepare",
    async (failure) => {
      await parent(2, "draft", "Earlier healthy series");
      await parent(4);
      const before = await rows();
      if (failure === "child")
        await db.execute(
          querySql`alter table events add constraint series_fixture_child_failure check (recurrence_index is distinct from 4)`,
        );
      else
        await db.execute(
          querySql`alter table activity_log add constraint series_fixture_audit_failure check ((properties->'recurrenceIndex'->>'after')::int is distinct from 4)`,
        );
      await expect(
        reconcileWriteTransaction(client)(async (store) => ({
          closed: 0,
          materialized: await store.materializeSeries(),
          stale: [],
        })),
      ).rejects.toThrow();
      expect(await rows()).toEqual(before);
      expect(await audits()).toEqual([]);
      await assertEmptyQueue();
    },
  );

  it("create.retire: homepage and event cache entries survive the transaction work, then retire after commit", async () => {
    const cache = primeCaches();
    const env = { APP_URL: "https://example.com", ADMIN_DB: db } as unknown as Env;
    let opened = 0;
    const openDb = async () => {
      opened++;
      return db;
    };
    // Empty featured bases intentionally do not cache: warm real content instead.
    const [feature] = await db
      .insert(featuredContents)
      .values({
        title: "Fixture announcement",
        body: "Read the weekly plan",
        url: "/events",
        isPublished: true,
      })
      .returning();
    const visible = [
      {
        id: feature!.id,
        title: "Fixture announcement",
        body: "Read the weekly plan",
        url: "/events",
        imageUrl: null,
        imageAlt: null,
      },
    ];
    expect(await cachedFeatured(env, openDb)).toEqual(visible);
    expect(await cachedFeatured(env, openDb)).toEqual(visible);
    expect(opened).toBe(1);
    await createEvent(
      dbOn(client, {
        beforeCommit: async () => {
          cache.intact();
          expect(await cachedFeatured(env, openDb)).toEqual(visible);
          expect(opened).toBe(1);
        },
      }),
      SERIES_ACTOR,
      input,
      { frequency: "weekly", count: 4, endsOn: null },
    );
    cache.retired();
    expect(await cachedFeatured(env, openDb)).toEqual(visible);
    expect(opened).toBe(2);
  });

  it("reconcile.terminal-parents: cancelled and past series never grow", async () => {
    const cancelled = await parent(4, "cancelled");
    const past = await parent(4, "past");
    statements.length = 0;
    expect(
      await reconcileWriteTransaction(client)(async (store) => ({
        closed: 0,
        materialized: await store.materializeSeries(),
        stale: [],
      })),
    ).toEqual({ closed: 0, materialized: 0, stale: [] });
    expect(counts(statements)).toEqual({ child_statements: 0, audit_statements: 0 });
    expect(await rows()).toEqual([cancelled, past]);
    expect(await audits()).toEqual([]);
  });
});

describe("weekly series fixture target refusal", () => {
  it.each([
    "",
    "not a URL",
    "postgres://agent_test@example.com/two_web_next",
    "postgres://agent_test@agent-testdb/not_disposable",
    "postgres://other@agent-testdb/two_web_next",
    "postgres://agent_test@agent-testdb/two_web_next?options=unsafe",
  ])(
    "target.refuse.%#: reject an unauthorized target before creating a fixture",
    async (target) => {
      await expect(createJobsFixture(target)).rejects.toThrow("refusing before connecting");
    },
  );
});
