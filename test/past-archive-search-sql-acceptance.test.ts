// route-inventory: GET /events/past
// Acceptance-owned SQL controls. Requires the approved disposable DATABASE_URL;
// the existing fixture guard refuses every other target before connecting.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { listCalendarPast, listPast } from "../src/events/reads";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  ARCHIVE_NOW,
  ARCHIVE_QUERY,
  archiveEnv,
  archiveRow,
  archiveRows,
  eventKeys,
  firstMatchKeys,
  lastMatchKeys,
} from "./helpers/past-archive-search-acceptance";

let fixture: MemberDataFixture;
let countedDb: Db;
let statements: string[] = [];
let rowLimits: number[] = [];
beforeAll(async () => {
  fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  countedDb = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: {
      logQuery: (sql, params) => {
        statements.push(sql);
        const limit = /\blimit \$(\d+)/i.exec(sql);
        if (limit) rowLimits.push(Number(params[Number(limit[1]) - 1]));
      },
    },
  });
});
afterAll(() => fixture?.dispose());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
  __resetAnonEventCacheForTests();
  await fixture.reset();
  const excluded = [
    archiveRow(101, { eventKey: "draft-decoy", status: "draft" }),
    archiveRow(102, { eventKey: "cancelled-decoy", status: "cancelled" }),
    archiveRow(103, {
      eventKey: "ongoing-decoy",
      status: "published",
      endsAt: new Date(ARCHIVE_NOW.getTime() + 1),
    }),
    archiveRow(104, {
      eventKey: "future-decoy",
      status: "published",
      startsAt: new Date("2031-01-01T20:00:00Z"),
      endsAt: new Date("2031-01-01T22:00:00Z"),
    }),
  ];
  await fixture.db.insert(events).values([...archiveRows(), ...excluded]);
  statements = [];
  rowLimits = [];
});
afterEach(() => vi.useRealTimers());

describe("real SQL archive-search acceptance controls", () => {
  it("filters both count and rows before LIMIT/OFFSET, including title/description and id ties", async () => {
    const one = await listPast(countedDb, 1, ARCHIVE_NOW, "raid  NIGHT");
    const two = await listPast(countedDb, 2, ARCHIVE_NOW, "raid  NIGHT");
    expect(one.rows.map((row) => row.eventKey)).toEqual(firstMatchKeys);
    expect(two.rows.map((row) => row.eventKey)).toEqual(lastMatchKeys);
    expect(one).toMatchObject({ totalPages: 2, hasMore: true });
    expect(two).toMatchObject({ totalPages: 2, hasMore: false });
    expect(new Set([...one.rows, ...two.rows].map((row) => row.id)).size).toBe(25);
    // Preserve the current maximum (count, rows, two aggregates per page),
    // while allowing equivalent batching to reduce the number of statements.
    expect(statements.length).toBeLessThanOrEqual(8);
    expect(rowLimits).toHaveLength(2);
    expect(
      rowLimits.every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 21),
    ).toBe(true);
  });

  it("orders starts before ids rather than treating a larger id as always newer", async () => {
    await fixture.db.insert(events).values([
      archiveRow(1, {
        eventKey: "newest-low-id",
        startsAt: new Date("2029-01-01T20:00:00Z"),
        endsAt: new Date("2029-01-01T22:00:00Z"),
      }),
      archiveRow(201, {
        eventKey: "older-high-id",
        startsAt: new Date("2028-01-01T20:00:00Z"),
        endsAt: new Date("2028-01-01T22:00:00Z"),
      }),
    ]);
    const result = await listPast(countedDb, 1, ARCHIVE_NOW, ARCHIVE_QUERY);
    expect(result.rows.slice(0, 3).map((row) => row.eventKey)).toEqual([
      "newest-low-id",
      "older-high-id",
      "archive-match-25",
    ]);
  });

  it("retains explicit-past visibility even when the recorded end is still ahead", async () => {
    await fixture.db
      .insert(events)
      .values(
        archiveRow(201, { eventKey: "explicit-past", endsAt: new Date("2031-01-01T22:00:00Z") }),
      );
    const result = await listPast(countedDb, 1, ARCHIVE_NOW, ARCHIVE_QUERY);
    expect(result.rows[0]!.eventKey).toBe("explicit-past");
  });

  it("does not silently collapse internal whitespace into a different search", async () => {
    const result = await listPast(countedDb, 1, ARCHIVE_NOW, "Raid night");
    expect(result).toEqual({ rows: [], hasMore: false, totalPages: 0 });
    expect(statements).toHaveLength(1);
  });

  it.each(["%", "_", "\\"])(
    "treats %j literally in SQL, with positive and wildcard-decoy controls",
    async (literal) => {
      await fixture.db
        .insert(events)
        .values([
          archiveRow(201, { eventKey: "literal-target", title: `Literal ${literal} meeting` }),
          archiveRow(202, { eventKey: "literal-decoy", title: "Literal X meeting" }),
        ]);
      const result = await listPast(countedDb, 1, ARCHIVE_NOW, literal);
      expect(result.rows.map((row) => row.eventKey)).toEqual(["literal-target"]);
      expect(result).toMatchObject({ totalPages: 1, hasMore: false });
    },
  );

  it("retains the twenty-row preview and its existing ended-cancelled visibility", async () => {
    const result = await listCalendarPast(countedDb, ARCHIVE_NOW, { search: ARCHIVE_QUERY });
    // The calendar includes ended cancelled rows; the archive deliberately does not.
    expect(result.map((row) => row.eventKey)).toEqual([
      "cancelled-decoy",
      ...firstMatchKeys.slice(0, 19),
    ]);
  });

  it.each([3, 999, Math.floor(Number.MAX_SAFE_INTEGER / 20) + 1])(
    "answers out-of-range page %s from filtered count alone",
    async (page) => {
      const result = await listPast(countedDb, page, ARCHIVE_NOW, ARCHIVE_QUERY);
      expect(result).toEqual({ rows: [], hasMore: false, totalPages: 2 });
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/\bcount\s*\(/i);
      expect(statements[0]).not.toContain(" offset ");
    },
  );

  it("preserves explicit past visibility and published-ended visibility without drafts or ongoing rows", async () => {
    const pages = await Promise.all(
      [1, 2].map((page) => listPast(fixture.db, page, ARCHIVE_NOW, ARCHIVE_QUERY)),
    );
    const all = pages.flatMap((page) => page.rows);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((row) => row.status))).toEqual(new Set(["past", "published"]));
    expect(all.some((row) => row.eventKey.endsWith("-decoy"))).toBe(false);
  });

  it("the real Hono archive route passes q through to the existing SQL read", async () => {
    const env = archiveEnv(countedDb);
    const response = await app.request(
      `/events/past?${new URLSearchParams({ q: ARCHIVE_QUERY, page: "2" })}`,
      {},
      env,
    );
    expect(response.status).toBe(200);
    expect(eventKeys(await response.text())).toEqual(lastMatchKeys);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
