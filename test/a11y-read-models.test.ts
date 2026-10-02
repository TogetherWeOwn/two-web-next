import { sql } from "drizzle-orm";
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { bufferedMemberText, keyedMemberRead, memberReadBoundary } from "../src/member-reads";
import { memberReadDb } from "../src/db/member-reads";
import { describe, expect, it, vi } from "vitest";
import { auditFixtureState, auditReadDatabase, readCounts } from "../ci/a11y-read-models";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { readMemberStats } from "../src/profiles/stats";

const subject = "100000000000000101";
const other = "100000000000000102";
function fixture() {
  const execute = vi.fn(async (_query: unknown): Promise<Record<string, unknown>[]> => { throw new Error("Shared DB must never receive stats queries"); });
  const prepareQuery = vi.fn((query: unknown) => ({ execute: () => execute(query) }));
  const session = { prepareQuery } as unknown as PgSession;
  const db = new PostgresJsDatabase(new PgDialect(), session, undefined) as Db;
  return { db, execute, prepareQuery };
}

describe("isolated accessibility bot read models", () => {
  it("renders fresh populated counts and retains explicit unavailable state without a database", async () => {
    const counts = await readCounts({} as Env);
    expect(counts.memberCount).toBe(84);
    expect(counts.onlineCount).toBe(12);
    expect(counts.ranks.map((rank) => rank.memberCount)).toEqual([4, 50, 20, 10, 0]);
    counts.ranks[0]!.memberCount = 999;
    expect((await readCounts({} as Env)).ranks[0]!.memberCount).toBe(4);
    expect(await readCounts({ A11Y_READ_STATE: "unavailable" } as Env & { A11Y_READ_STATE: "unavailable" })).toEqual({ memberCount: null, onlineCount: null, ranks: [] });
  });

  it("uses the real stats normalizer and never forwards either qualified query", async () => {
    const { db, execute } = fixture();
    const stats = await readMemberStats(auditReadDatabase(db, "populated"), subject);
    expect(stats).toEqual({
      joinedAt: new Date("2025-01-01T00:00:00Z"), tenureDays: 637, rankKey: "veteran", isCurrentMember: true,
      milestones: [
        { type: "first_event", occurredAt: new Date("2026-09-29T19:00:00Z"), detail: "Synthetic chess night — مرحباً" },
        { type: "joined", occurredAt: new Date("2025-01-01T00:00:00Z"), detail: null },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keys stats to known members and covers former/one-day/no-milestone content", async () => {
    const { db, execute } = fixture();
    const isolated = auditReadDatabase(db, "populated");
    expect(await readMemberStats(isolated, other)).toMatchObject({ tenureDays: 1, rankKey: "prospect", isCurrentMember: false, milestones: [] });
    expect(await readMemberStats(isolated, "999999999999999999")).toBeNull();
    expect(await readMemberStats(auditReadDatabase(db, "unavailable"), subject)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed for new, quoted, uppercase and raw-string bot-view queries", () => {
    const { db, execute } = fixture();
    const isolated = auditReadDatabase(db, "populated");
    for (const query of [sql`select * from web_v1.live_counts`, sql`SELECT * FROM "WEB_V1"."members"`, 'select * from "web_v1" . "member_milestones"']) {
      expect(() => isolated.execute(query)).toThrow("no isolated fixture");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("delegates non-bot work unchanged, retaining the real owned-schema database", async () => {
    const { db, execute, prepareQuery } = fixture();
    execute.mockResolvedValue([{ owned: true }]);
    const isolated = auditReadDatabase(db, "populated");
    expect(await isolated.execute(sql`select 1`)).toEqual([{ owned: true }]);
    expect(prepareQuery).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sql: "select 1", params: [] }));
  });

  it("retains both synthetic owner projections inside the actual read boundary", async () => {
    const { db, execute, prepareQuery } = fixture();
    const sink = vi.fn().mockResolvedValue(true);
    const app = new Hono();
    app.get("/", async (c) => {
      await memberReadBoundary(c, { viewer: other, resource: "profile", action: "view", route: "profiles.show" }, sink, async () => {
        const stats = await readMemberStats(auditReadDatabase(db, "populated"), subject);
        expect(stats?.milestones).toHaveLength(2);
        bufferedMemberText(c, JSON.stringify(stats));
      });
      return c.res;
    });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Synthetic chess night");
    expect(sink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subjectUserIds: [subject], viewerDiscordId: other, route: "profiles.show" }));
    expect(prepareQuery).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unknown bot-view query inside the boundary before borrowing any adapter", async () => {
    const { db, execute, prepareQuery } = fixture();
    const isolated = memberReadDb(auditReadDatabase(db, "populated"));
    const app = new Hono();
    const sink = vi.fn().mockResolvedValue(true);
    app.get("/", async (c) => {
      await memberReadBoundary(c, { viewer: other, resource: "profile", action: "view", route: "profiles.show" }, sink, async () => {
        await keyedMemberRead(() => isolated.execute(sql`select * from web_v1.live_counts`));
        bufferedMemberText(c, "private-bot-content");
      });
      return c.res;
    });
    const response = await app.request("/");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-bot-content");
    expect(prepareQuery).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects unknown fixture states rather than silently losing populated coverage", () => {
    expect(auditFixtureState(null)).toBe("populated");
    expect(auditFixtureState("populated")).toBe("populated");
    expect(auditFixtureState("unavailable")).toBe("unavailable");
    expect(() => auditFixtureState("typo")).toThrow("Unknown accessibility");
  });
});
