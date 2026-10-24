// Acceptance-owned: the Builder implements the behavior without editing this file.
// Wire contract: ?when=all|24h|7d|30d; omitted/unknown means all recorded time.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { activityLog } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import { listActivityLog } from "../src/admin/reads";
import {
  activityLogEmptyText,
  activityLogUrl,
  parseActivityLogQuery,
} from "../src/admin/table-list";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = "2026-11-01T07:30:00.000Z"; // US fall-back day: windows are elapsed UTC time.
const WINDOWS = [
  { when: "24h", cutoff: "2026-10-31T07:30:00.000Z" },
  { when: "7d", cutoff: "2026-10-25T07:30:00.000Z" },
  { when: "30d", cutoff: "2026-10-02T07:30:00.000Z" },
] as const;

// SQL assertions below inspect emitted statements, never production source text.
// Real PostgreSQL decides membership, inclusivity, conjunction and OFFSET.
describe("activity window query contract", () => {
  it.each(["all", "24h", "7d", "30d"])(
    "retains allowlisted %s through parsing and paging",
    (when) => {
      const query = parseActivityLogQuery({
        when,
        subject: " Event ",
        causer: " 100000000000000201 ",
        page: "2",
      });
      expect(query).toMatchObject({
        when,
        subject: "Event",
        causer: "100000000000000201",
        page: 2,
      });
      const next = new URL(activityLogUrl(query, 3), "https://example.test");
      expect(next.pathname).toBe("/admin/activity-log");
      expect(next.searchParams.get("page")).toBe("3");
      expect(next.searchParams.get("subject")).toBe("Event");
      expect(next.searchParams.get("causer")).toBe("100000000000000201");
      expect(next.searchParams.get("when") ?? "all").toBe(when);
    },
  );

  it.each([undefined, "", "yesterday", "7D", "2026-10-02", "7d OR 1=1", " 24h "])(
    "normalizes unallowlisted %s to the same all-time scope it renders",
    (when) => {
      const query = parseActivityLogQuery({ when });
      expect(query).toMatchObject({ when: "all", page: 1 });
      const url = new URL(activityLogUrl(query, 2), "https://example.test");
      expect(url.searchParams.get("when") ?? "all").toBe("all");
      expect(activityLogEmptyText(query)).toBe("No activity yet.");
    },
  );

  it.each(WINDOWS)("uses filtered empty copy for a $when-only search", ({ when }) => {
    expect(activityLogEmptyText(parseActivityLogQuery({ when }))).toBe(
      "No activity matches these filters.",
    );
  });

  it.each(["0", "-1", "1.5", "1e2", "9007199254740991"])(
    "guards page %s without dropping the window",
    (page) => {
      expect(parseActivityLogQuery({ when: "7d", page })).toMatchObject({ when: "7d", page: 1 });
    },
  );
});

describe("activity window bounded SQL acceptance", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const statements: { sql: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set DATABASE_URL to an approved disposable test database");
    fixture = await createMemberDataFixture(url);
    db = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery: (sql, params) => {
          statements.push({ sql, params });
        },
      },
    });
  });
  beforeEach(async () => {
    await fixture.reset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    statements.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  async function seedRows(
    rows: { id: number; at: string; subject?: string; causer?: string | null }[],
  ) {
    await fixture.db.insert(activityLog).values(
      rows.map((row) => ({
        id: row.id,
        description: `Recorded change ${row.id}`,
        subjectType: row.subject ?? "Event",
        subjectId: `${(row.subject ?? "Event").toLowerCase()}-fixture`,
        causerId: row.causer === undefined ? "100000000000000201" : row.causer,
        event: "updated",
        createdAt: new Date(row.at),
      })),
    );
    statements.length = 0;
  }

  it.each(WINDOWS)(
    "includes the exact $when cutoff but excludes one millisecond older",
    async ({ when, cutoff }) => {
      await seedRows([
        { id: 1, at: new Date(Date.parse(cutoff) - 1).toISOString() },
        { id: 2, at: cutoff },
        { id: 3, at: new Date(Date.parse(cutoff) + 1).toISOString() },
      ]);
      const opts = { when, page: 1 };
      const rows = await listActivityLog(db, opts);
      expect(rows.map((r) => r.id)).toEqual([3, 2]);
      const read = statements.find((s) => s.sql.includes('from "activity_log"'))!;
      expect(read.sql).toMatch(/"created_at"\s*>=\s*\$/);
      expect(
        read.params.filter((p) => typeof p === "string" && Date.parse(p) === Date.parse(cutoff)),
      ).toHaveLength(1);
    },
  );

  it.each(["UTC", "America/New_York", "Pacific/Auckland"])(
    "uses elapsed server time, not the %s calendar day",
    async (timezone) => {
      const previous = process.env.TZ;
      process.env.TZ = timezone;
      try {
        // At this instant New York is on the OTHER side of its DST transition.
        await seedRows([
          { id: 1, at: "2026-10-31T07:29:59.999Z" },
          { id: 2, at: "2026-10-31T07:30:00.000Z" },
        ]);
        const opts = { when: "24h", page: 1 };
        expect((await listActivityLog(db, opts)).map((r) => r.id)).toEqual([2]);
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it("ANDs subject and causer with time before paging", async () => {
    await seedRows([
      { id: 1, at: "2026-10-25T07:29:59.999Z" },
      { id: 2, at: NOW, subject: "Featured" },
      { id: 3, at: NOW, causer: "100000000000000202" },
      { id: 4, at: "2026-10-25T07:30:00.000Z" },
    ]);
    const opts = { when: "7d", subject: "Event", causer: "100000000000000201" };
    expect((await listActivityLog(db, opts)).map((r) => r.id)).toEqual([4]);
  });

  it.each(["all", "unrecognized", "2026-10-02"])(
    "CONTROL: %s adds no cutoff and retains old recorded rows",
    async (when) => {
      await seedRows([
        { id: 1, at: "2020-01-01T00:00:00.000Z" },
        { id: 2, at: NOW },
      ]);
      const opts = { when, page: 1 };
      expect((await listActivityLog(db, opts)).map((r) => r.id)).toEqual([2, 1]);
      expect(statements.find((s) => s.sql.includes('from "activity_log"'))!.sql).not.toMatch(
        /"created_at"\s*>=/,
      );
    },
  );

  it("CONTROL: bounds one transaction-local read to 50+1 and orders ties by descending id", async () => {
    await seedRows(Array.from({ length: 103 }, (_, i) => ({ id: i + 1, at: NOW })));
    const transaction = vi.spyOn(db, "transaction");
    const opts = { when: "7d", page: 2 };
    const rows = await listActivityLog(db, opts);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 51 }, (_, i) => 53 - i));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sql).toContain("set_config('lock_timeout'");
    expect(statements[0]!.sql).toContain("set_config('statement_timeout'");
    expect(statements[0]!.sql.match(/, true\)/g)).toHaveLength(2);
    expect(statements[0]!.params).toEqual(["2000ms", "2000ms"]);
    const read = statements[1]!;
    expect(read.sql).toContain('from "activity_log"');
    expect(read.sql).toMatch(/limit \$\d+ offset \$\d+/);
    expect(read.params.slice(-2)).toEqual([51, 50]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "causerId",
      "createdAt",
      "description",
      "event",
      "id",
      "subjectId",
      "subjectType",
    ]);
    expect(read.sql.split(/\bfrom\b/i)[0]!).not.toMatch(/properties|username|avatar|email|bio/i);
  });

  it("filters before OFFSET, rather than hiding rows from an all-time page after reading", async () => {
    await seedRows([
      ...Array.from({ length: 52 }, (_, i) => ({ id: i + 1, at: NOW })),
      ...Array.from({ length: 52 }, (_, i) => ({ id: i + 53, at: "2020-01-01T00:00:00.000Z" })),
    ]);
    const opts = { when: "7d", page: 2 };
    expect((await listActivityLog(db, opts)).map((r) => r.id)).toEqual([2, 1]);
  });

  it("CONTROL: createdAt outranks the id tie-break when insertion order differs", async () => {
    await seedRows([
      { id: 99, at: "2026-10-31T08:00:00.000Z" },
      { id: 1, at: NOW },
    ]);
    const opts = { when: "24h", page: 1 };
    expect((await listActivityLog(db, opts)).map((r) => r.id)).toEqual([1, 99]);
  });

  it("CONTROL: direct callers cannot create an unsafe OFFSET or turn literal wildcards into a broad read", async () => {
    await seedRows([{ id: 1, at: NOW }]);
    const unsafe = { when: "all", page: Number.MAX_SAFE_INTEGER };
    expect((await listActivityLog(db, unsafe)).map((r) => r.id)).toEqual([1]);
    const literal = { when: "7d", subject: "%_" };
    expect(await listActivityLog(db, literal)).toEqual([]);
  });
});
