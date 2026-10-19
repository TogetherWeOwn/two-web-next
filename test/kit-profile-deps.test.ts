// Kit profile production wiring: kitProfileDeps in src/profiles/kit.ts.
// Covers the store/stats factory that the read-model tests pin only by
// source text. Hermetic: injected ADMIN_DB fixtures and postgres/drizzle
// doubles, no network, no real database.
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { EnvWithAdminDb } from "../src/admin/db";
import { kitProfileDeps } from "../src/profiles/kit";
import { MEMBER_STATS_BUDGET_MS } from "../src/profiles/stats";

const { makeSql, makeDb } = vi.hoisted(() => ({ makeSql: vi.fn(), makeDb: vi.fn() }));
vi.mock("postgres", () => ({ default: makeSql }));
vi.mock("drizzle-orm/postgres-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm/postgres-js")>()),
  drizzle: makeDb,
}));

const MEMBER = "100000000000000001";
const fullMember = {
  member_id: MEMBER,
  joined_at: "2025-01-01T00:00:00Z",
  tenure_days: "637",
  rank_key: "community_regular",
  is_current_member: true,
};
const milestones = [
  {
    member_id: MEMBER,
    milestone: "first_event",
    occurred_at: "2026-09-29T19:00:00Z",
    detail: "Chess night",
  },
];

function fixtureDb(
  memberRows: Record<string, unknown>[] = [fullMember],
  milestoneRows: Record<string, unknown>[] = milestones,
): { db: Db; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValueOnce(memberRows).mockResolvedValueOnce(milestoneRows);
  const session = {
    prepareQuery: (query: unknown) => ({ execute: () => execute(query) }),
  } as unknown as PgSession;
  const db = new PostgresJsDatabase(new PgDialect(), session, undefined) as Db;
  db.execute = db.execute.bind(db);
  return { db, execute };
}

const baseEnv = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "kit-profile-deps-fixture-secret-32-bytes!!",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
} as unknown as EnvWithAdminDb;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("kitProfileDeps store wiring", () => {
  it("fails closed without any database source", async () => {
    const { storeFor } = kitProfileDeps({ ...baseEnv });
    await expect(storeFor()).resolves.toBeNull();
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("returns a profile store for an injected ADMIN_DB", async () => {
    const { db } = fixtureDb([], []);
    const env = { ...baseEnv, ADMIN_DB: db };
    const { storeFor } = kitProfileDeps(env);
    const store = await storeFor();
    expect(store).not.toBeNull();
    expect(typeof store!.find).toBe("function");
  });
});

describe("kitProfileDeps stats wiring", () => {
  it("hides the stats block without a bot database", async () => {
    const { statsFor } = kitProfileDeps({ ...baseEnv });
    await expect(statsFor(MEMBER)).resolves.toBeNull();
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("reads the injected ADMIN_DB through the shared budget", async () => {
    const { db } = fixtureDb();
    const env = { ...baseEnv, ADMIN_DB: db };
    const { statsFor } = kitProfileDeps(env);
    const stats = await statsFor(MEMBER);
    expect(stats).toEqual({
      joinedAt: new Date(fullMember.joined_at),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
      milestonesTruncated: false,
      milestones: milestones.map((row) => ({
        type: row.milestone,
        occurredAt: new Date(row.occurred_at),
        detail: row.detail,
      })),
    });
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("reads the explicit bot database with a bounded client", async () => {
    const { db } = fixtureDb([], []);
    makeSql.mockReturnValue({ fakeClient: true });
    makeDb.mockReturnValue(db);
    const url = "postgres://bot.test/db";
    const { statsFor } = kitProfileDeps({ ...baseEnv, BOT_DATABASE_URL: url });
    // No member row: the block hides instead of failing the read.
    await expect(statsFor(MEMBER)).resolves.toBeNull();
    expect(makeSql).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({
        connection: { statement_timeout: MEMBER_STATS_BUDGET_MS },
      }),
    );
    expect(makeDb).toHaveBeenCalledOnce();
  });
});
