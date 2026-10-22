// route-inventory: GET /about.md
// route-inventory: GET /faq.md
// Live-rank pins for the Markdown alternates through the real routes. The
// builder pins in test/ai-friendly-md.test.ts invoke mdAbout/mdFaq directly,
// so a route that stopped passing ranks would stay green there; these tests
// stand up a renamed ladder on a disposable database and assert the derived
// prose over HTTP instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type { Env } from "../src/env";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./helpers/web-v1-fixture";

const state = vi.hoisted(() => ({
  fixture: null as WebV1Fixture | null,
}));
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (raw: string, options: Record<string, unknown>) => {
      const url = testDatabaseUrl(raw); // Even the driver double refuses non-test URLs.
      if (!state.fixture) return original(url.href, { ...options, password: () => url.password });
      const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
        return state.fixture!.sql(parts, ...(values as postgres.ParameterOrFragment<never>[]));
      };
      sql.end = async () => {}; // Fixture owns the transaction/socket, not the request.
      return sql;
    },
  };
});

describe.skipIf(!process.env.DATABASE_URL)(
  "markdown alternates render live ranks through the routes",
  () => {
    let fixture: WebV1Fixture;
    let env: Env;
    let app: typeof import("../src/index")["default"];

    beforeEach(async () => {
      vi.resetModules();
      fixture = await createWebV1Fixture(process.env.DATABASE_URL!);
      const sql = fixture.sql;
      await sql`CREATE TABLE web_v1.rank_ladder (rank_key text NOT NULL, role_id text)`;
      await sql`
      INSERT INTO web_v1.live_counts VALUES (84, 12, ${new Date().toISOString()}::text)
    `;
      // Same three-rung renamed ladder as the builder pins, deliberately
      // scrambled insertion order: the render order comes from rank_order.
      await sql`
      INSERT INTO web_v1.rank_counts VALUES
      ('crown', 'Crown', 0, 3), ('ember', 'Ember', 24, 1), ('tide', 'Tide', 40, 2)
    `;
      await sql`
      INSERT INTO web_v1.rank_ladder VALUES
      ('ember', '1387000000000000001'), ('tide', '1387000000000000002'),
      ('crown', '1387000000000000005')
    `;
      state.fixture = fixture;
      env = {
        APP_URL: "https://next.example.test",
        DISCORD_INVITE_URL: "https://discord.gg/test",
        DISCORD_GUILD_ID: "test-guild",
        SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
        BOT_DB: { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href },
      } as Env;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      app = (await import("../src/index")).default;
    });

    afterEach(async () => {
      state.fixture = null;
      vi.restoreAllMocks();
      await fixture?.dispose();
    });

    const get = async (path: string) => {
      const res = await app.request(new URL(path, env.APP_URL).href, {}, env);
      expect(res.status).toBe(200);
      return res.text();
    };

    it("about.md derives the ladder fact from live ranks", async () => {
      const body = await get("/about.md");
      expect(body).toContain("Est. 1998");
      expect(body).toContain("You start as an Ember. Show up a few times, play, become a Tide.");
      expect(body).not.toContain("Prospect");
      expect(body).not.toContain("Member");
    });

    it("faq.md derives the rungs and entry answers from live ranks", async () => {
      const body = await get("/faq.md");
      expect(body).toContain(
        "Three, in order: Ember → Tide → Crown. Ranks stack — a Tide still holds everything below. Crown is still unclaimed.",
      );
      expect(body).toContain("Everyone starts as an Ember");
      expect(body).not.toContain("Prospect → Member");
      expect(body).not.toContain("Legend is still unclaimed");
    });
  },
);
