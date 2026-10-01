// Real web_v1 SQL inside an owned, rollback-only fixture transaction. The
// driver wrapper only lends that reserved connection to request-scoped reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./helpers/web-v1-fixture";

const state = vi.hoisted(() => ({
  fixture: null as WebV1Fixture | null,
  queries: [] as string[],
  error: null as Error | null,
}));
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return { default: (raw: string, options: Record<string, unknown>) => {
    const url = testDatabaseUrl(raw); // Even the driver double refuses non-test URLs.
    if (!state.fixture) return original(url.href, { ...options, password: () => url.password });
    const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
      state.queries.push(parts.join(""));
      if (state.error) return Promise.reject(state.error);
      return state.fixture!.sql(parts, ...values as postgres.ParameterOrFragment<never>[]);
    };
    sql.end = async () => {}; // Fixture owns the transaction/socket, not the request.
    return sql;
  } };
});

const NOW = Date.parse("2026-09-30T12:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_GUILD_ID: "test-guild",
  DISCORD_INVITE_URL: "https://discord.gg/test",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_BOT_TOKEN: "test-bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe.skipIf(!process.env.DATABASE_URL)("homepage counts (test container)", () => {
  let fixture: WebV1Fixture;
  let env: Env;
  let app: (typeof import("../src/index"))["default"];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    state.queries = [];
    state.error = null;
    fixture = await createWebV1Fixture(process.env.DATABASE_URL!);
    const sql = fixture.sql;
    await sql`
      INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date(NOW).toISOString()}::text)
    `;
    // Deliberately scrambled insertion order. These are highest-rank-held
    // counts, not role holder totals; null and zero mean different things.
    await sql`
      INSERT INTO web_v1.rank_counts VALUES
      ('legend', 'Legend', 0, 5), ('soldier', 'Soldier', 20, 3),
      ('prospect', 'Prospect', 24, 1), ('veteran', 'Veteran', NULL, 4), ('member', 'Member', 40, 2)
    `;
    state.fixture = fixture;
    // Keep event/featured reads local and separate from the bot-view socket.
    // A counts failure must not take either of these homepage sections down.
    const event: typeof events.$inferSelect = {
      id: 1, eventKey: "counts-game-night", title: "Counts fixture game night", game: null, description: null,
      startsAt: new Date(NOW + 3600_000), endsAt: new Date(NOW + 7200_000), timezone: "UTC", location: "Lobby",
      capacity: null, status: "published", discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
      createdBy: null, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
      recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null, createdAt: new Date(NOW), updatedAt: new Date(NOW),
    };
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof event)[];
    const db = drizzle(async (query) => {
      if (query.includes("set_config")) return { rows: [] };
      if (query.includes('from "events"')) return { rows: [columns.map((key) => {
        const value = event[key];
        return value instanceof Date ? value.toISOString() : value;
      })] };
      if (query.includes('from "rsvps"')) return { rows: [[1, 3]] };
      if (query.includes('from "featured_contents"')) return { rows: [[1, "Counts fixture news", "Featured fixture", null, null, null]] };
      throw new Error("Unexpected public homepage fixture query");
    }) as unknown as Db;
    Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
    env = { ...baseEnv, DB: { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href },
      ADMIN_DB: db, SESSION_STORE: createMemorySessionStore() } as Env;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    app = (await import("../src/index")).default;
  });
  afterEach(async () => {
    state.fixture = null;
    vi.restoreAllMocks();
    await fixture?.dispose();
  });

  const home = async () => {
    const res = await app.request(new URL("/", env.APP_URL).href, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain('href="/e/counts-game-night"');
    expect(html).toContain("Counts fixture game night");
    expect(html).toContain("3 going");
    expect(html).toContain('data-testid="featured-content"');
    expect(html).toContain("Counts fixture news");
    return html;
  };
  const emptyCounts = (html: string) => {
    expect(html).not.toContain('data-testid="member-count"');
    expect(html).toContain('data-testid="join"');
    expect(html).toContain("The lobby is open.");
    expect(html).toContain('data-testid="rank-stack"');
    expect(html).not.toContain("SQLSTATE");
  };

  it("renders fresh member/online counts and SQL-ordered ranks from the binding", async () => {
    const html = await home();
    expect(html).toContain('<strong>84</strong> members');
    expect(html).toContain('<strong>12</strong> online');
    for (const [rank, value] of [["Prospect", "24"], ["Member", "40"], ["Soldier", "20"],
      ["Veteran", ""], ["Legend", "unclaimed"]]) {
      expect(html).toContain(`<dt>${rank}</dt><dd>${value}</dd>`);
    }
    const ordered = ["prospect", "member", "soldier", "veteran", "legend"].map((key) => html.indexOf(`data-rank="${key}"`));
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(state.queries).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("supports explicit local DATABASE_URL without the binding", async () => {
    env = { ...env, DATABASE_URL: env.DB!.connectionString, DB: undefined };
    expect(await home()).toContain('<strong>84</strong> members');
  });

  it("keeps a genuine zero member count, and omits zero online", async () => {
    await fixture.sql`UPDATE web_v1.live_counts SET human_member_count = 0, online_count = 0`;
    const html = await home();
    expect(html).toContain('<strong>0</strong> members');
    expect(html).not.toContain('</strong> online');
  });

  it.each([-599_999, 599_999])("renders text timestamps just inside the freshness boundary (%i ms)", async (offset) => {
    const timestamp = new Date(NOW + offset).toISOString();
    await fixture.sql`UPDATE web_v1.live_counts SET counts_updated_at = ${timestamp}::text`;
    const [row] = await fixture.sql`SELECT counts_updated_at, pg_typeof(counts_updated_at)::text AS type FROM web_v1.live_counts`;
    expect(row).toEqual({ counts_updated_at: timestamp, type: "text" });
    expect(await home()).toContain('<strong>84</strong> members');
  });

  it.each([-600_000, 600_000])("suppresses text timestamps at the exact stale boundary (%i ms); ranks remain readable", async (offset) => {
    await fixture.sql`UPDATE web_v1.live_counts SET counts_updated_at = ${new Date(NOW + offset).toISOString()}::text`;
    const html = await home();
    emptyCounts(html);
    expect(html).toContain('<dt>Member</dt><dd>40</dd>');
  });

  it("degrades invalid timestamp text with HTTP 200", async () => {
    await fixture.sql`UPDATE web_v1.live_counts SET counts_updated_at = 'not-a-timestamp'`;
    emptyCounts(await home());
  });

  it("degrades missing and undated live rows", async () => {
    await fixture.sql`UPDATE web_v1.live_counts SET counts_updated_at = NULL`;
    emptyCounts(await home());
    await fixture.sql`DELETE FROM web_v1.live_counts`;
    // Clear module-local cache to exercise the missing-row query itself.
    vi.resetModules();
    app = (await import("../src/index")).default;
    emptyCounts(await home());
  });

  it("degrades a missing schema to the five label-only fallback rungs with HTTP 200", async () => {
    // This schema was created in OUR transaction; never a pre-existing schema.
    await fixture.sql`DROP SCHEMA web_v1 CASCADE`;
    const html = await home();
    emptyCounts(html);
    for (const rank of ["Prospect", "Member", "Soldier", "Veteran", "Legend"]) {
      expect(html).toContain(`<dt>${rank}</dt><dd></dd>`);
    }
    expect(html).not.toContain("unclaimed"); // Unknown is not zero.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("degrades a DB error with HTTP 200, caches the failure, and logs each view once", async () => {
    state.error = new Error("SQLSTATE: fixture DB unavailable");
    emptyCounts(await home());
    emptyCounts(await home());
    expect(state.queries).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SQLSTATE");
  });

  it("escapes producer-provided rank labels instead of inserting HTML", async () => {
    await fixture.sql`UPDATE web_v1.rank_counts SET rank_label = '<script>bad()</script>' WHERE rank_key = 'member'`;
    const html = await home();
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<script>bad()</script>");
  });
});

describe("web_v1 fixture containment", () => {
  it.each([
    "postgres://agent_test@neon.example.test/two_web_next",
    "postgres://agent_test@agent-testdb:5432/two_web_next?options=-csearch_path=public",
    "postgres://other@agent-testdb:5432/two_web_next",
  ])("rejects an unauthorized URL before constructing a client: %s", async (raw) => {
    await expect(createWebV1Fixture(raw)).rejects.toThrow("refusing before connecting");
  });
});
