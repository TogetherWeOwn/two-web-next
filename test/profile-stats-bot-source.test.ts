// Profile stats must read the bot-owned `web_v1` views through the bot
// database (BOT_DATABASE_URL then BOT_DB), never the web database — the same
// source rule as homepage counts. The web DB holds no `web_v1` views, so a
// web-DB read fails and the stats block stays hidden in production.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const MEMBER = "100000000000000001";
const REQUEST_ID = "01K9N8Q2R5T7V3W4X6Y8Z0A2B4";
const MEMBER_STATS = "Member stats unavailable; showing the unavailable state.";

const state = vi.hoisted(() => ({
  urls: [] as string[],
  options: [] as Record<string, unknown>[],
  calls: 0,
  connectionError: undefined as Error | undefined,
  executeError: undefined as Error | undefined,
}));

vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    state.urls.push(url);
    state.options.push(options);
    if (state.connectionError) throw state.connectionError;
    return { end: async () => {} };
  },
}));

const memberRow = {
  member_id: MEMBER,
  joined_at: "2025-01-01T00:00:00Z",
  tenure_days: "637",
  rank_key: "community_regular",
  is_current_member: true,
};
const milestoneRows = [
  { member_id: MEMBER, milestone: "joined", occurred_at: "2025-01-01T00:00:00Z", detail: null },
];

vi.mock("drizzle-orm/postgres-js", async (importOriginal) => {
  // Keep the real exports (PostgresJsDatabase, etc.): src/db/member-reads.ts
  // needs them to classify the injected client. Only the client factory is doubled.
  const real = await importOriginal<typeof import("drizzle-orm/postgres-js")>();
  return {
    ...real,
    drizzle: () => ({
      execute: async () => {
        state.calls += 1;
        if (state.executeError) throw state.executeError;
        return state.calls === 1 ? [{ ...memberRow }] : milestoneRows.map((row) => ({ ...row }));
      },
      $client: { end: async () => {} },
    }),
  };
});

const baseEnv = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "profile-stats-bot-source-fixture-secret-32b",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
} as Env;

const ctx = (env: Env, requestId?: unknown) =>
  ({ env, get: (key: string) => (key === "requestId" ? requestId : undefined) }) as never;

beforeEach(() => {
  state.urls = [];
  state.options = [];
  state.calls = 0;
  state.connectionError = undefined;
  state.executeError = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("profile stats bot source", () => {
  it("reads through BOT_DATABASE_URL, never the web DATABASE_URL", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    const { statsFor } = profileStores({});
    const stats = await statsFor(
      ctx({
        ...baseEnv,
        DATABASE_URL: "postgres://fixture.test/web",
        DB: { connectionString: "postgres://fixture.test/web" },
        BOT_DATABASE_URL: "postgres://fixture.test/bot",
        BOT_DB: { connectionString: "postgres://fixture.test/bot-binding" },
      }),
      MEMBER,
    );
    expect(state.urls).toEqual(["postgres://fixture.test/bot"]);
    expect(stats).toMatchObject({ rankKey: "community_regular", tenureDays: 637 });
  });

  it("falls back to the BOT_DB binding without touching the web DB", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    const { statsFor } = profileStores({});
    const stats = await statsFor(
      ctx({
        ...baseEnv,
        DATABASE_URL: "postgres://fixture.test/web",
        DB: { connectionString: "postgres://fixture.test/web" },
        BOT_DB: { connectionString: "postgres://fixture.test/bot-binding" },
      }),
      MEMBER,
    );
    expect(state.urls).toEqual(["postgres://fixture.test/bot-binding"]);
    expect(stats).toMatchObject({ rankKey: "community_regular" });
  });

  it("never connects when only web sources exist: stats stay hidden", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    const { statsFor } = profileStores({});
    const stats = await statsFor(
      ctx({
        ...baseEnv,
        DATABASE_URL: "postgres://fixture.test/web",
        DB: { connectionString: "postgres://fixture.test/web" },
      }),
      MEMBER,
    );
    expect(stats).toBeNull();
    expect(state.urls).toEqual([]);
  });
});

// Exercise the real budget/read helpers: each catch must receive the Hono ID,
// not just the outer wrapper (inner read failures settle without rethrowing).
describe.each([
  { label: "valid ID", requestId: REQUEST_ID, fields: { request_id: REQUEST_ID } },
  { label: "malformed ID", requestId: "not-a-request-id!!", fields: {} },
])("profile stats Hono request correlation: $label", ({ requestId, fields }) => {
  it("carries only safe fields when the injected read rejects", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    const execute = vi.fn().mockRejectedValue(new TypeError("private driver detail"));
    const env: EnvWithAdminDb = { ...baseEnv, ADMIN_DB: { execute } as unknown as Db };
    const stats = await profileStores({}).statsFor(ctx(env, requestId), MEMBER);

    expect(stats).toMatchObject({ membershipUnavailable: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.urls).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      [MEMBER_STATS, { exception: "TypeError", aborted: false, ...fields }],
    ]);
  });

  it("carries only safe fields when the owned-client read rejects", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    state.executeError = new TypeError("private driver detail");
    const stats = await profileStores({}).statsFor(
      ctx({ ...baseEnv, BOT_DATABASE_URL: "postgres://fixture.test/bot" }, requestId),
      MEMBER,
    );

    expect(stats).toMatchObject({ membershipUnavailable: true });
    expect(state.urls).toEqual(["postgres://fixture.test/bot"]);
    expect(state.calls).toBe(1);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      [MEMBER_STATS, { exception: "TypeError", aborted: false, ...fields }],
    ]);
  });

  it("carries only safe fields when connection setup rejects before the read", async () => {
    const { profileStores } = await import("../src/profiles/routes-stores");
    state.connectionError = new TypeError("private driver detail");
    const stats = await profileStores({}).statsFor(
      ctx({ ...baseEnv, BOT_DATABASE_URL: "postgres://fixture.test/bot" }, requestId),
      MEMBER,
    );

    expect(stats).toMatchObject({ membershipUnavailable: true });
    expect(state.urls).toEqual(["postgres://fixture.test/bot"]);
    expect(state.calls).toBe(0);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      [MEMBER_STATS, { exception: "TypeError", aborted: false, ...fields }],
    ]);
  });
});
