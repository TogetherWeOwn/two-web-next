// route-inventory: POST /mcp
// route-inventory: OPTIONS /mcp
// Acceptance pins: the shared public-read budget is checked BEFORE batch
// parsing on POST /mcp. An over-budget caller therefore gets the same JSON
// 429 envelope as any other over-budget request, even when the body is a
// JSON-RPC batch that would otherwise be refused with -32600. Under budget,
// the batch refusal is unchanged, and OPTIONS preflight is never throttled.
// Real app + agent-testdb/CI Postgres only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const INVITE_URL = "https://discord.gg/test-invite-handoff";

// The shared 60/min public-read budget, spent: the same pre-seeded hit count
// the neighbouring MCP rate-limit pin uses to force a 429.
const BUDGET = 60;

// One batch body shared by the over- and under-budget cases, so the caller's
// budget state is the only variable between them.
const BATCH = [
  {
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { name: "list_events", arguments: { per_page: 20, page: 1 } },
  },
  {
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: "list_events", arguments: { per_page: 20, page: 1 } },
  },
];

// The 429 envelope the public API already answers with (see the shared-budget
// pin in test/api-public-events.test.ts); MCP shares that budget and shape.
// The throttle double reports a 60-second wait for hits seeded at `now`.
const RATE_LIMITED = {
  error: { code: "rate_limited", message: "Too many requests. Try again in 60 seconds." },
};

type RpcResponse = {
  status: number;
  headers: Headers;
  messages: Record<string, unknown>[];
};

describe.skipIf(!process.env.DATABASE_URL)(
  "public MCP: budget checked before batch parsing",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let store: SessionStore;
    let env: Env & EnvWithThrottle;
    let now: number;
    let hits: { bucket: string; at: number }[];

    const throttleDouble = () => {
      const sql = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const statement = strings.join("?");
          if (statement.includes("pg_advisory_xact_lock")) return [];
          if (statement.includes("SELECT count(*)")) {
            const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
            return [
              {
                n: rows.length,
                wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
              },
            ];
          }
          if (statement.includes("INSERT INTO web_throttle_hits")) {
            hits.push({ bucket: String(values[0]), at: now });
            return [];
          }
          if (statement.includes("DELETE FROM web_throttle_hits")) return [];
          throw new Error("Unexpected throttle statement");
        },
        {
          begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
          // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before
          // the advisory lock; the double passes it through.
          unsafe: async () => [],
        },
      );
      return sql;
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      store = createMemorySessionStore();
      now = Date.now();
      hits = [];
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_INVITE_URL: INVITE_URL,
        DISCORD_BOT_TOKEN: "bot-token",
        SESSION_STORE: store,
        THROTTLE_STORE: async () => throttleDouble() as unknown as Sql,
        get ADMIN_DB() {
          return db;
        },
      } as unknown as Env & EnvWithThrottle;
    });
    beforeEach(async () => {
      await fixture.reset();
      __resetApiPublicCacheForTests();
      now = Date.now();
      hits = [];
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const post = async (body: unknown, ip: string): Promise<RpcResponse> => {
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify(body),
        },
        env,
      );
      const text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      let messages: Record<string, unknown>[];
      if (contentType.includes("text/event-stream")) {
        messages = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice("data:".length).trim()));
      } else if (text.length > 0) {
        messages = [JSON.parse(text)];
      } else {
        messages = [];
      }
      return { status: res.status, headers: res.headers, messages };
    };

    const spendBudget = (ip: string) => {
      for (let i = 0; i < BUDGET; i++) hits.push({ bucket: `events-read:${ip}`, at: now });
    };

    it("answers an over-budget batch with the 429 envelope, not the batch refusal", async () => {
      const ip = "192.0.2.90";
      spendBudget(ip);
      const res = await post(BATCH, ip);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(res.messages).toEqual([RATE_LIMITED]);
      // The refused request records no further hit.
      expect(hits).toHaveLength(BUDGET);
    });

    it("answers an over-budget single request with the same 429 envelope (control)", async () => {
      const ip = "192.0.2.91";
      spendBudget(ip);
      const res = await post({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} }, ip);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(res.messages).toEqual([RATE_LIMITED]);
      expect(hits).toHaveLength(BUDGET);
    });

    it("still refuses an under-budget batch with -32600/400 and burns no budget (control)", async () => {
      const res = await post(BATCH, "192.0.2.92");
      expect(res.status).toBe(400);
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0]).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32600 },
      });
      expect(res.messages[0]).not.toHaveProperty("result");
      expect(hits).toHaveLength(0);
    });

    it("still answers OPTIONS preflight while the caller is over budget (control)", async () => {
      const ip = "192.0.2.93";
      spendBudget(ip);
      const preflight = await app.request(
        "/mcp",
        {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:6274",
            "access-control-request-method": "POST",
            "cf-connecting-ip": ip,
          },
        },
        env,
      );
      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers.get("access-control-allow-origin")).toBeTruthy();
      expect(hits).toHaveLength(BUDGET);
    });
  },
);
