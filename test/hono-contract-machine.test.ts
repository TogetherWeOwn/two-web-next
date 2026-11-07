// route-inventory: POST /mcp
// route-inventory: OPTIONS /mcp
// route-inventory: POST /api/agent-events
// Missing HTTP cases only; existing machine suites own the denial-envelope,
// payload-depth, grant and result-budget matrices. These are app.request
// characterizations, not built-Worker or migration parity qualification.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import type { Sql } from "../src/sessions";
import { readCounts, type Counts } from "../src/counts";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/counts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/counts")>()),
  readCounts: vi.fn(async () => ({ memberCount: null, onlineCount: null, ranks: [] })),
}));

const baseEnv = { APP_URL: "https://next.example.test" } as Env;
const rpcHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "cf-connecting-ip": "192.0.2.180",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Same transaction wrapper as the existing route doubles. Refuse unexpected
// statements so an admission or database read cannot pass unnoticed.
function spentBudget() {
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join("?");
    if (statement.includes("SELECT count(*)")) return [{ n: 60, wait: 60 }];
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected spent-budget statement");
  });
  const store = vi.fn(async () => withThrottleTx(query as unknown as Sql));
  return { store, query, env: { ...baseEnv, THROTTLE_STORE: store } as unknown as Env };
}

describe("Hono machine HTTP contracts", () => {
  it("caps an MCP batch before a spent budget is consulted", async () => {
    const budget = spentBudget();
    const storeRead = vi.fn(() => {
      throw new Error("MCP database must not resolve on a refusal");
    });
    const env = {
      ...budget.env,
      get ADMIN_DB() {
        return storeRead();
      },
    } as Env;
    const response = await app.request(
      "/mcp",
      { method: "POST", headers: rpcHeaders, body: JSON.stringify(["x".repeat(32 * 1024)]) },
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, data: { request_id: expect.any(String), next: expect.any(String) } },
    });
    expect(budget.store).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();

    // Same registered POST and same spent store: a bounded batch reaches
    // admission and gets 429 rather than the batch parser's 400.
    const bounded = await app.request(
      "/mcp",
      { method: "POST", headers: rpcHeaders, body: "[]" },
      env,
    );
    expect(bounded.status).toBe(429);
    expect(budget.store).toHaveBeenCalledOnce();
    expect(
      budget.query.mock.calls.filter(([strings]) => strings.join("?").includes("SELECT count(*)")),
    ).toHaveLength(1);
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("preserves the SDK preflight headers without admission or database resolution", async () => {
    const budget = spentBudget();
    const storeRead = vi.fn(() => {
      throw new Error("preflight must not resolve a database");
    });
    const response = await app.request(
      "/mcp",
      {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,mcp-protocol-version",
        },
      },
      {
        ...budget.env,
        get ADMIN_DB() {
          return storeRead();
        },
      } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(budget.store).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("refuses a foreign browser Origin on the registered MCP preflight", async () => {
    const response = await app.request(
      "/mcp",
      { method: "OPTIONS", headers: { origin: "https://foreign.example.test" } },
      baseEnv,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Invalid Origin: foreign.example.test" },
    });
  });

  it.each(["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"])(
    "leaves %s agent ingress unregistered even when ingress is enabled",
    async (method) => {
      const storeRead = vi.fn(() => {
        throw new Error("wrong methods must not enter admission");
      });
      const response = await app.request(
        "/api/agent-events",
        { method, headers: { origin: baseEnv.APP_URL } },
        {
          ...baseEnv,
          AGENT_EVENTS_ENABLED: "true",
          get AGENT_EVENT_SQL() {
            return storeRead();
          },
        } as Env,
      );
      expect(response.status).toBe(404);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(storeRead).not.toHaveBeenCalled();
    },
  );

  it("keeps cross-origin wrong-method ingress behind the global guard", async () => {
    const response = await app.request(
      "/api/agent-events",
      { method: "PUT", headers: { origin: "https://foreign.example.test" } },
      { ...baseEnv, AGENT_EVENTS_ENABLED: "true" },
    );
    expect(response.status).toBe(403);
  });

  it.each(["complete", "disconnect"])(
    "returns unbuffered MCP SSE headers before tool completion: %s",
    async (ending) => {
      let markEntered!: () => void;
      let resolveCounts!: (value: Counts) => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const counts = new Promise<Counts>((resolve) => {
        resolveCounts = resolve;
      });
      vi.mocked(readCounts).mockImplementationOnce(async () => {
        markEntered();
        return counts;
      });
      const fetch = vi.fn(async () => {
        throw new Error("no external calls in streaming fixture");
      });
      vi.stubGlobal("fetch", fetch);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const responsePromise = app.request(
          "/mcp",
          {
            method: "POST",
            headers: rpcHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 91,
              method: "tools/call",
              params: { name: "get_community", arguments: {} },
            }),
          },
          {
            ...baseEnv,
            FREEZE_BANNER_ENABLED: "true",
            FREEZE_BANNER_DATES: "Fixture maintenance window",
          },
        );
        await entered;
        // The tool remains unresolved. Any global middleware that buffers the
        // stream causes this await to hit the test timeout rather than pass.
        const response = await responsePromise;
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        reader = response.body!.getReader();
        if (ending === "disconnect") {
          await reader.cancel("synthetic client disconnect");
        } else {
          resolveCounts({ memberCount: null, onlineCount: null, ranks: [] });
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          const data = new TextDecoder()
            .decode(chunk.value)
            .split("\n")
            .find((line) => line.startsWith("data:"));
          expect(data).toBeDefined();
          expect(JSON.parse(data!.slice(5))).toMatchObject({
            jsonrpc: "2.0",
            id: 91,
            result: { structuredContent: expect.any(Object) },
          });
        }
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        // Response cancellation is not a promise that Hono cancels DB/tool work.
        // Settle the local tool ourselves; request-signal enablement is out of scope.
        resolveCounts({ memberCount: null, onlineCount: null, ranks: [] });
        reader?.releaseLock();
      }
    },
  );
});
