// Acceptance-owned: Past finds stored-past AND published-ended nights without
// changing stored statuses, other filters, paging, or the inventory read budget.
// The Builder incorporates this file unchanged; corrections return to its author.
//
// RED cases fail until the shared admin read gains elapsed-published eligibility.
// CONTROL cases pin behavior already present. Live cases use only the guarded,
// disposable DATABASE_URL fixture; the read-budget case is hermetic.
// Run: npm test -- test/admin-events-past-filter-acceptance.test.ts
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_PAGE_SIZE, parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView } from "../src/admin/kit-events";
import { listEvents } from "../src/admin/store-event-reads";
import { events } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import { listPast } from "../src/events/reads";
import { insertSavedNight, savedNightRow } from "./helpers/admin-event-find-saved-nights";
import { inventoryDb } from "./helpers/admin-inventory-recovery";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = new Date("2030-06-15T20:00:00.000Z");
const at = (delta: number) => new Date(NOW.getTime() + delta);
const HOUR = 3_600_000;
const keys = (rows: { eventKey: string }[]) => rows.map((row) => row.eventKey).sort();

// Only Date is frozen: Postgres and the timeout/transaction machinery retain
// real timers. A fixed instant distinguishes < from <= and start from end time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("admin Past filter read budget (hermetic)", () => {
  it("CONTROL: keeps one inventory select plus one going-count select", async () => {
    const transport = inventoryDb("events", [
      savedNightRow("budget-stored", {
        id: 1,
        status: "past",
        startsAt: at(-2 * HOUR),
        endsAt: at(-HOUR),
      }),
      savedNightRow("budget-ended", {
        id: 2,
        status: "published",
        startsAt: at(-2 * HOUR),
        endsAt: at(-1),
      }),
    ]);
    await listEvents(transport.db, { status: "past" });
    // Observe real Drizzle execution, not a mock listEvents implementation.
    // The transport also throws if another SELECT is attempted.
    expect(transport.queries).toHaveLength(2);
    expect(transport.transactions).toBe(1);
    expect(transport.executions).toHaveLength(1);
    expect(transport.audits).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin Past filter (disposable SQL fixture)", () => {
  let fixture: MemberDataFixture;
  let countedDb: Db;
  let statements: string[] = [];
  const list = (params: Parameters<typeof listEvents>[1]) => listEvents(fixture.db, params);

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    countedDb = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: { logQuery: (sql) => statements.push(sql) },
    });
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(events).values([
      {
        eventKey: "stored-past",
        title: "Stored night",
        status: "past",
        // Explicit stored-past remains eligible even with a future end/start.
        startsAt: at(HOUR),
        endsAt: at(2 * HOUR),
      },
      {
        eventKey: "published-ended",
        title: "Published ended night",
        status: "published",
        startsAt: at(-2 * HOUR),
        endsAt: at(-1),
      },
      {
        eventKey: "published-ongoing",
        title: "Published ongoing night",
        status: "published",
        startsAt: at(-HOUR),
        endsAt: at(1),
      },
      {
        eventKey: "published-upcoming",
        title: "Published upcoming night",
        status: "published",
        startsAt: at(HOUR),
        endsAt: at(2 * HOUR),
      },
      {
        eventKey: "published-exact-now",
        title: "Published exact-now night",
        status: "published",
        startsAt: at(-HOUR),
        endsAt: NOW,
      },
      {
        eventKey: "draft-ended",
        title: "Draft ended night",
        status: "draft",
        startsAt: at(-2 * HOUR),
        endsAt: at(-HOUR),
      },
      {
        eventKey: "cancelled-ended",
        title: "Cancelled ended night",
        status: "cancelled",
        startsAt: at(-2 * HOUR),
        endsAt: at(-HOUR),
      },
    ]);
    statements = [];
  });

  it("RED: returns exactly stored-past and published-ended, keeping true stored labels", async () => {
    const rows = await list({ status: "past" });
    expect(keys(rows)).toEqual(["published-ended", "stored-past"]);
    expect(rows.find((row) => row.eventKey === "published-ended")?.status).toBe("published");
    expect(rows.find((row) => row.eventKey === "stored-past")?.status).toBe("past");
  });

  it("CONTROL: published still means every stored-published row, regardless of elapsed time", async () => {
    expect(keys(await list({ status: "published" }))).toEqual([
      "published-ended",
      "published-exact-now",
      "published-ongoing",
      "published-upcoming",
    ]);
  });

  it.each([
    ["draft", ["draft-ended"]],
    ["cancelled", ["cancelled-ended"]],
  ])("CONTROL: status=%s keeps stored-status semantics", async (status, expected) => {
    expect(keys(await list({ status }))).toEqual(expected);
  });

  it("CONTROL: no status filter keeps the complete inventory", async () => {
    expect(keys(await list({}))).toEqual([
      "cancelled-ended",
      "draft-ended",
      "published-ended",
      "published-exact-now",
      "published-ongoing",
      "published-upcoming",
      "stored-past",
    ]);
  });

  it("CONTROL: the public archive excludes a published end exactly at now", async () => {
    const archive = await listPast(fixture.db, 1, NOW);
    // Literal oracle, not an expected set computed by the admin implementation.
    expect(keys(archive.rows)).toEqual(["published-ended", "stored-past"]);
    expect(archive).toMatchObject({ totalPages: 1, hasMore: false });
  });

  it("RED: admin and archive share the strict end-time boundary, not a start-time cutoff", async () => {
    const rows = await list({ status: "past", q: "Published" });
    expect(keys(rows)).toEqual(["published-ended"]);
    // Neither the exact-now row nor the already-started ongoing row is past.
    expect(rows.some((row) => row.eventKey === "published-exact-now")).toBe(false);
    expect(rows.some((row) => row.eventKey === "published-ongoing")).toBe(false);
  });

  it.each([
    ["  PUBLISHED  ", ["published-ended"]],
    ["Stored", ["stored-past"]],
    ["does not match", []],
  ])("RED/CONTROL: ANDs q=%j with both branches of past eligibility", async (q, expected) => {
    expect(keys(await list({ status: "past", q }))).toEqual(expected);
  });

  it("RED: applies past eligibility before paging and counts the same visible set", async () => {
    await fixture.reset();
    const expected: string[] = [];
    for (let i = 0; i < 27; i++) {
      const suffix = String(i).padStart(2, "0");
      const eventKey = `page-${suffix}`;
      expected.push(eventKey);
      await insertSavedNight(fixture.db, {
        eventKey,
        title: `Paged night ${suffix}`,
        status: i % 2 === 0 ? "past" : "published",
        startsAt: at(-2 * HOUR),
        endsAt: at(-HOUR),
      });
      // Interleaved by title: filtering after LIMIT creates short/missing pages.
      await insertSavedNight(fixture.db, {
        eventKey: `decoy-${suffix}`,
        title: `Paged night ${suffix} decoy`,
        status: i % 2 === 0 ? "draft" : "published",
        startsAt: at(-HOUR),
        endsAt: i % 2 === 0 ? at(-1) : at(1),
      });
    }
    const params = { status: "past", q: "Paged night", sort: "title", order: "asc" } as const;
    const first = await list(params);
    const second = await list({ ...params, page: "2" });
    expect(first.map((row) => row.eventKey)).toEqual(expected.slice(0, 26));
    expect(second.map((row) => row.eventKey)).toEqual(["page-25", "page-26"]);
    expect(await list({ ...params, page: "3" })).toEqual([]);

    // Admin intentionally has no count query: the total is the disjoint union
    // of visible pages, not the first page's extra lookahead row counted twice.
    const one = buildEventListView(parseEventListQuery(params), first);
    const two = buildEventListView(parseEventListQuery({ ...params, page: "2" }), second);
    expect(one.rows).toHaveLength(EVENT_PAGE_SIZE);
    expect(one.hasNext).toBe(true);
    expect(two.rows).toHaveLength(2);
    expect(two.hasNext).toBe(false);
    const visible = [...one.rows, ...two.rows].map((row) => row.eventKey);
    expect(visible).toEqual(expected);
    expect(new Set(visible).size).toBe(27);

    const archive = await listPast(fixture.db, 1, NOW, "Paged night");
    expect(archive).toMatchObject({ totalPages: 2, hasMore: true });
  });

  it("CONTROL: Past adds no SQL statements compared with a populated published list", async () => {
    await listEvents(countedDb, { status: "published" });
    const publishedCount = statements.length;
    const publishedSelects = statements.filter((sql) => /^select\b/i.test(sql)).length;
    statements = [];
    await listEvents(countedDb, { status: "past" });
    expect(statements.length).toBeLessThanOrEqual(publishedCount);
    expect(statements.filter((sql) => /^select\b/i.test(sql)).length).toBeLessThanOrEqual(
      publishedSelects,
    );
    // Selects include the existing timeout setup; no count/N+1 query is needed.
    expect(statements.length).toBeLessThanOrEqual(3);
  });
});
