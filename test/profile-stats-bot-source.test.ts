// Profile stats must read the bot-owned `web_v1` views through the bot
// database (BOT_DATABASE_URL then BOT_DB), never the web database — the same
// source rule as homepage counts. The web DB holds no `web_v1` views, so a
// web-DB read fails and the stats block stays hidden in production.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const MEMBER = "100000000000000001";

const state = vi.hoisted(() => ({
  urls: [] as string[],
  options: [] as Record<string, unknown>[],
  calls: 0,
}));

vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    state.urls.push(url);
    state.options.push(options);
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

// statsFor reads the request ID off the Hono context for its warn line; the
// source-selection pins below carry none, so the fake context returns undefined.
const ctx = (env: Env) => ({ env, get: () => undefined }) as never;

beforeEach(() => {
  state.urls = [];
  state.options = [];
  state.calls = 0;
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
