// Acceptance: public 429s validate Retry-After through the shared parser.
//
// Contract (from the card spec, written blind to the implementation):
//   - The real public routes, admitted through the real throttle chain
//     (fixture env + memory throttle store), answer an exhausted budget
//     with the public error envelope whose message and whose `retry-after`
//     response header AGREE on one validated number of seconds.
//   - Validation is the shared `parseRetryAfterSeconds` admission:
//     a usable upstream value passes through (fractions ceil upstream of
//     here), absurd values cap at 86400, and absent/unparseable values
//     fall back to 60 — the raw upstream text is never echoed into the
//     user-visible message or the header.
//   - The MCP 429 path (POST /mcp) carries the same validated value with
//     no separate parser copy.
//   - Positive control: an unexhausted budget still serves the normal 200
//     with no Retry-After header.
//
// Injection seam: the memory throttle's SELECT row. `wait` is what the
// fixed-window counter reports; it flows checkJoinThrottle ->
// rateLimitExceeded -> the upstream response header that admitted()
// re-reads. Weird waits (string garbage, missing, negative, huge,
// exponential) model an untrusted/driver-shaped counter result.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { registerPublicApiRoutes } from "../src/public-data/routes";
import { registerMcpRoutes } from "../src/mcp/routes";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const IP = "192.0.2.90";

type Wait = unknown;

function fixture(limited: boolean, wait: Wait) {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        return [{ n: limited ? 999 : 0, wait }];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) return [];
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  const app = new Hono<{ Bindings: Env }>();
  registerPublicApiRoutes(app);
  registerMcpRoutes(app);
  const env = {
    APP_URL: "https://next.example.test",
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    THROTTLE_STORE: async () => sql as unknown as Sql,
  } as unknown as EnvWithThrottle;
  const get = (path: string) => app.request(path, { headers: { "cf-connecting-ip": IP } }, env);
  const mcp = () =>
    app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": IP,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
      env,
    );
  return { get, mcp };
}

async function expectValidated429(res: Response, seconds: number) {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe(String(seconds));
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toEqual({
    error: {
      code: "rate_limited",
      message: `Too many requests. Try again in ${seconds} seconds.`,
    },
  });
}

describe("public 429 Retry-After validation (real routes + memory throttle)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
    vi.restoreAllMocks();
  });

  it("passes a valid upstream wait through unchanged, header and message agreeing", async () => {
    const f = fixture(true, 42);
    await expectValidated429(await f.get("/api/public/events"), 42);
  });

  it("caps an absurd upstream wait at 86400 instead of echoing it raw", async () => {
    const f = fixture(true, 999_999);
    await expectValidated429(await f.get("/api/public/events"), 86_400);
  });

  it("never echoes exponential notation: an unrepresentable wait falls back to 60", async () => {
    // 1e21 stringifies upstream as "1e+21", which is not delta-seconds.
    const f = fixture(true, 1e21);
    const res = await f.get("/api/public/events");
    const text = await res.clone().text();
    expect(text).not.toContain("1e+21");
    await expectValidated429(res, 60);
  });

  it("keeps header and message agreeing (1s floor) for a negative upstream wait", async () => {
    const f = fixture(true, -5);
    await expectValidated429(await f.get("/api/public/events"), 1);
  });

  it("falls back to 60 and never reflects garbage from the counter row", async () => {
    const f = fixture(true, "garbage-marker");
    const res = await f.get("/api/public/events");
    const text = await res.clone().text();
    expect(text).not.toContain("garbage-marker");
    await expectValidated429(res, 60);
  });

  it("falls back to 60 when the counter row carries no wait", async () => {
    const f = fixture(true, undefined);
    await expectValidated429(await f.get("/api/public/events"), 60);
  });

  it("MCP 429 carries the same validated value (huge wait capped, no separate parser)", async () => {
    const f = fixture(true, 999_999);
    await expectValidated429(await f.mcp(), 86_400);
  });

  it("MCP 429 passes a valid upstream wait through unchanged", async () => {
    const f = fixture(true, 17);
    await expectValidated429(await f.mcp(), 17);
  });

  it("positive control: an unexhausted budget serves the normal 200 join handoff with no Retry-After", async () => {
    const f = fixture(false, 42);
    const res = await f.get("/api/public/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    const body = (await res.json()) as { invite_url?: unknown };
    expect(body.invite_url).toBe("https://discord.gg/test-invite");
  });
});
