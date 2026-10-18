// Acceptance: the profile milestone read is bounded in SQL.
//
// Contract under test (from the card spec, blind to the implementation):
// - The milestone read caps rows in SQL at a pinned cap of 100 (the same
//   size as the sibling capped reads); members at or under the cap see
//   exactly what they see today.
// - Ordering stays newest-first, and over-cap members see a deterministic
//   newest-100: ties on occurred_at break by milestone name, then detail,
//   so the boundary row never depends on physical row order.
// - Nothing else changes: the member query, the returned stats fields, the
//   bound-parameter discipline, and the two-query shape all stay as-is.
//
// The fixture interprets the emitted SQL's ORDER BY / LIMIT against a local
// dataset (through the real Drizzle compilation + member-read observer, as
// in profile-stats.test.ts), so over-cap behavior is proven against the SQL
// the code actually sends without a live database.
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { readMemberStats } from "../src/profiles/stats";

const MEMBER = "100000000000000001";
const CAP = 100;

const memberRow = {
  member_id: MEMBER,
  joined_at: "2025-01-01T00:00:00Z",
  tenure_days: "637",
  rank_key: "community_regular",
  is_current_member: true,
};

type Row = { member_id: string; milestone: string; occurred_at: string; detail: string | null };
type Query = { sql: string; params: unknown[] };

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

function effectiveLimit(query: Query): number | null {
  const sql = normalize(query.sql);
  const literal = sql.match(/\blimit\s+(\d+)\b/);
  if (literal) return Number(literal[1]);
  const bound = sql.match(/\blimit\s+\$(\d+)\b/);
  if (bound) {
    const value = query.params[Number(bound[1]) - 1];
    return typeof value === "number" ? value : null;
  }
  return null;
}

// Applies the query's ORDER BY keys and LIMIT to the fixture rows the way
// Postgres would (stable input order otherwise, NULLs last on ASC).
function runMilestoneQuery(query: Query, rows: Row[]): Row[] {
  const sql = normalize(query.sql);
  const orderClause = sql.match(/order by (.+?)(?: limit |$)/)?.[1] ?? "";
  const keys = orderClause.split(",").map((part) => part.trim());
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const key of keys) {
      const desc = /\bdesc\b/.test(key);
      let cmp = 0;
      if (key.startsWith("occurred_at")) cmp = a.occurred_at.localeCompare(b.occurred_at);
      else if (key.startsWith("milestone")) cmp = a.milestone.localeCompare(b.milestone);
      else if (key.startsWith("detail")) {
        if (a.detail === null && b.detail === null) cmp = 0;
        else if (a.detail === null) cmp = 1;
        else if (b.detail === null) cmp = -1;
        else cmp = a.detail.localeCompare(b.detail);
        if (desc) cmp = -cmp;
        if (cmp !== 0) return cmp;
        continue;
      } else continue;
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return 0;
  });
  const limit = effectiveLimit(query);
  return limit === null ? sorted : sorted.slice(0, limit);
}

function fixture(milestoneRows: Row[]) {
  const queries: Query[] = [];
  const execute = vi.fn((query: Query) => {
    queries.push(query);
    const sql = normalize(query.sql);
    if (sql.includes("from web_v1.members")) return Promise.resolve([{ ...memberRow }]);
    if (sql.includes("from web_v1.member_milestones"))
      return Promise.resolve(runMilestoneQuery(query, milestoneRows));
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  const session = {
    prepareQuery: (query: unknown) => ({ execute: () => execute(query as Query) }),
  } as unknown as PgSession;
  const db = new PostgresJsDatabase(new PgDialect(), session, undefined) as Db;
  db.execute = db.execute.bind(db);
  return { db, queries };
}

// Deterministic non-sorted input order, so only the SQL can produce order.
const shuffled = (rows: Row[]): Row[] =>
  rows
    .map((row, i) => ({ row, k: (i * 37 + 11) % 101 }))
    .sort((x, y) => x.k - y.k)
    .map(({ row }) => row);

const dayMs = 86_400_000;
const rowAt = (i: number, base = Date.UTC(2025, 0, 1)): Row => ({
  member_id: MEMBER,
  milestone: `m${String(i).padStart(3, "0")}`,
  occurred_at: new Date(base + i * dayMs).toISOString(),
  detail: null,
});

describe("milestone read SQL bound (acceptance)", () => {
  it("caps the milestone query in SQL at the pinned cap with a deterministic order", async () => {
    const { db, queries } = fixture([rowAt(1), rowAt(0)]);
    await readMemberStats(db, MEMBER);
    expect(queries).toHaveLength(2);
    const milestoneQuery = queries[1]!;
    const sql = normalize(milestoneQuery.sql);
    expect(sql).toMatch(
      /from web_v1\.member_milestones where member_id = \$1 order by occurred_at desc, milestone(?: asc)?, detail(?: asc)?(?: nulls last)? limit (?:\d+|\$\d+)/,
    );
    expect(effectiveLimit(milestoneQuery)).toBe(CAP);
    // The member id stays a bound parameter, never interpolated text.
    expect(sql).not.toContain(MEMBER);
    expect(milestoneQuery.params[0]).toBe(MEMBER);
  });

  it("returns only the newest 100 milestones for an over-cap member, newest-first", async () => {
    const rows = shuffled(Array.from({ length: CAP + 5 }, (_, i) => rowAt(i)));
    const { db } = fixture(rows);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats?.milestones).toHaveLength(CAP);
    expect(stats?.milestones.map((m) => m.type)).toEqual(
      Array.from({ length: CAP }, (_, j) => `m${String(CAP + 4 - j).padStart(3, "0")}`),
    );
    const times = stats!.milestones.map((m) => m.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("breaks occurred_at ties by milestone name so the over-cap set is deterministic", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const rows = shuffled(
      Array.from({ length: CAP + 5 }, (_, i) => ({
        member_id: MEMBER,
        milestone: `m${String(i).padStart(3, "0")}`,
        occurred_at: at,
        detail: null,
      })),
    );
    const { db } = fixture(rows);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats?.milestones.map((m) => m.type)).toEqual(
      Array.from({ length: CAP }, (_, j) => `m${String(j).padStart(3, "0")}`),
    );
  });

  it("breaks full ties by detail at the cap boundary, nulls last", async () => {
    // 99 strictly newer rows, then three rows tied on time + type at the
    // boundary: only the first by detail (nulls last) fits under the cap.
    const newer = Array.from({ length: CAP - 1 }, (_, i) => rowAt(200 + i));
    const tiedAt = "2025-06-01T00:00:00.000Z";
    const tied: Row[] = [
      { member_id: MEMBER, milestone: "tied", occurred_at: tiedAt, detail: "b-detail" },
      { member_id: MEMBER, milestone: "tied", occurred_at: tiedAt, detail: null },
      { member_id: MEMBER, milestone: "tied", occurred_at: tiedAt, detail: "a-detail" },
    ];
    // Adverse input order: without a detail tiebreak the stable physical
    // order would put "b-detail" at the boundary instead of "a-detail".
    const { db } = fixture([...[...newer].reverse(), ...tied]);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats?.milestones).toHaveLength(CAP);
    expect(stats?.milestones.at(-1)).toEqual({
      type: "tied",
      occurredAt: new Date(tiedAt),
      detail: "a-detail",
    });
  });

  // Positive controls: these pass before and after the bound lands.

  it("leaves an under-cap member's milestones and stats fields unchanged", async () => {
    const rows = shuffled([rowAt(0), rowAt(2), rowAt(1)]);
    const { db } = fixture(rows);
    expect(await readMemberStats(db, MEMBER)).toEqual({
      joinedAt: new Date(memberRow.joined_at),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
      milestones: [2, 1, 0].map((i) => ({
        type: `m${String(i).padStart(3, "0")}`,
        occurredAt: new Date(rowAt(i).occurred_at),
        detail: null,
      })),
    });
  });

  it("returns every milestone for a member exactly at the cap", async () => {
    const rows = shuffled(Array.from({ length: CAP }, (_, i) => rowAt(i)));
    const { db } = fixture(rows);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats?.milestones.map((m) => m.type)).toEqual(
      Array.from({ length: CAP }, (_, j) => `m${String(CAP - 1 - j).padStart(3, "0")}`),
    );
  });

  it("returns no milestones for a member with none", async () => {
    const { db } = fixture([]);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats?.milestones).toEqual([]);
  });

  it("keeps the member query and the two-query shape unchanged", async () => {
    const { db, queries } = fixture([rowAt(0)]);
    await readMemberStats(db, MEMBER);
    expect(queries).toHaveLength(2);
    expect(normalize(queries[0]!.sql)).toContain(
      "select member_id, joined_at, tenure_days, rank_key, is_current_member from web_v1.members where member_id = $1 limit 1",
    );
    expect(queries[0]!.params).toEqual([MEMBER]);
    expect(normalize(queries[1]!.sql)).toContain(
      "select member_id, milestone, occurred_at, detail from web_v1.member_milestones where member_id = $1",
    );
  });
});
