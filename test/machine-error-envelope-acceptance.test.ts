// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: POST /api/agent-events
// route-inventory: GET /events.rss
// route-inventory: GET /events.ics
// route-inventory: GET /events/:file{.+\.ics}
// route-inventory: POST /mcp
// route-inventory: GET /openapi.json
// Acceptance (failing-first, Test Author owned): one machine error vocabulary
// with request_id and next action across surfaces (K4).
//
// Every machine error carries stable `code`, human `message`, `request_id`
// for correlation, and `next` naming one safe action. Ingress keeps `reason`
// as a deprecated alias with `code` primary (strictly additive, no renames).
// Feed 503s stay no-store but gain a structured JSON envelope for
// Accept: application/json callers. MCP POST errors are all well-formed
// JSON-RPC error objects with stable numeric codes + data.next.
//
// Fail-first on the pre-fix code: the RED tests below assert the new keys
// (request_id/next on REST, code/next on ingress, JSON on feed 503s for JSON
// callers, JSON-RPC on MCP 429s, data.next on MCP transport, OpenAPI + doc
// agreement) and fail because the current code emits the four dialects.
// The PIN tests assert stability (no renames of PUBLIC_DATA_ERROR_CODES or
// ingress reasons, feed 429 plaintext preserved, batch -32600 preserved) and
// stay green pre and post.
//
// Hermetic and DB-free: mounted app with memory throttle doubles, fake
// ADMIN_DB chains, and the in-memory fake agent-event store only. No
// DATABASE_URL, no Discord, no network (fetch stubbed to throw). Success
// bodies are never asserted here; the paired build must not change them.
//
// Scope guard: must not import implementation internals beyond contracts,
// openapi, and test helpers; drive only through the mounted app
// (`test/app.ts`) with minimal env, plus direct contract/doc reads.
//
// Expected breaks for the Builder (exact-equality pins that gain keys):
// - test/mcp-budget-before-batch.test.ts:167,178 (REST 429 on /mcp -> JSON-RPC)
// - test/route-native-machine-failures-acceptance.test.ts:346,360,376,549
//   (REST_INTERNAL without request_id/next)
// - test/agent-events-pre-service-request-id.test.ts:227,236,246,268
//   (Object.keys exactly message/reason/request_id -> gains code/next)
// - test/agent-events-ingress-429-request-id-acceptance.test.ts:320 (same)
// - test/agent-events-shield.test.ts:211,212 (same)
// - test/agent-events-version-range.test.ts:185 (same)
// - test/agent-events-guild-id-type-acceptance.test.ts:134 (same)
// - test/w15b-exposure-throttle-race.test.ts:191 (same + retry_after)
// - test/public-reads-detail-serializer-pins.test.ts:82 (REST internal exact)
// toMatchObject pins on ingress/MCP stay green (lenient to new keys).
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { EnvWithAgentStore } from "../src/agent-events/route";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import type { Env } from "../src/env";
import {
  PUBLIC_DATA_ERROR_CODES,
  PUBLIC_DATA_INTERNAL_MESSAGE,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";

const APP_URL = "https://next.example.test";
const CALLER = "agent-under-test";
const CRED = "cred-envelope-k4-001";
const IP = "192.0.2.99";

const VALID_KEY = "00000000000000000000000001";

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as never;

const root = new URL("../", import.meta.url);

// ---------------------------------------------------------------------------
// Offline doubles
// ---------------------------------------------------------------------------

function memoryThrottleSql(limited: boolean, wait = 42) {
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
  return sql as unknown as Sql;
}

const openEnv = {
  APP_URL,
  THROTTLE_STORE: async () => memoryThrottleSql(false),
} as unknown as Env & EnvWithThrottle;

const limitedEnv = {
  APP_URL,
  THROTTLE_STORE: async () => memoryThrottleSql(true, 42),
} as unknown as Env & EnvWithThrottle;

/** Drizzle chain double resolving to `rows` for every select. */
function fakeDbWithRows(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenable = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "offset", "groupBy", "innerJoin"]) {
    chain[m] = () => chain;
  }
  chain.then = (res: unknown, rej: unknown) =>
    (thenable as Promise<unknown[]>).then(res as never, rej as never);
  chain.catch = (rej: unknown) => (thenable as Promise<unknown[]>).catch(rej as never);
  return { select: () => chain };
}

function fakeDbThrowing(err: unknown) {
  return {
    select: () => {
      throw err;
    },
  };
}

const baseIngressEnv = {
  APP_URL,
  THROTTLE_STORE: async () => memoryThrottleSql(false),
} as unknown as Env;

const enabledIngressEnv = {
  ...baseIngressEnv,
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
} as unknown as Env;

beforeEach(() => {
  __resetApiPublicCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("machine-error envelope fixtures must remain offline");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function grantEnv() {
  const fake = makeFakeAgentDb();
  await fake.addGrant(CRED, {
    id: "grant-envelope-k4",
    agent_id: CALLER,
    guild_id: DEFAULT_CONFIG.stagingGuildId,
    expires_at: null,
    disabled_at: null,
  });
  return { ...enabledIngressEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
}

async function postIngress(env: Env, body: unknown, bearer?: string) {
  return app.request(
    "/api/agent-events",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
    executionCtx,
  );
}

function postMcp(env: Env & EnvWithThrottle, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-connecting-ip": IP,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

async function readMcpMessages(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length).trim()));
  }
  if (text.length > 0) return [JSON.parse(text)];
  return [];
}

// ---------------------------------------------------------------------------
// Code-stability pins (GREEN pre and post: no renames)
// ---------------------------------------------------------------------------

describe("machine error vocabulary: code stability", () => {
  it("PIN: keeps the five public-data error codes in order", () => {
    expect(PUBLIC_DATA_ERROR_CODES).toEqual([
      "internal",
      "invalid_request",
      "not_found",
      "rate_limited",
      "unavailable",
    ]);
  });

  it("PIN: keeps the static internal message bytes", () => {
    expect(PUBLIC_DATA_INTERNAL_MESSAGE).toBe("Event data could not be read.");
  });

  it("PIN: ingress disabled keeps its reason", async () => {
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      baseIngressEnv,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "ingress_disabled",
    });
  });

  it("PIN: ingress without a store keeps its reason and message", async () => {
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      enabledIngressEnv,
      executionCtx,
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { reason: string; message: string }).toMatchObject({
      reason: "ingress_unavailable",
      message: "The agent event store is not configured.",
    });
  });

  it("PIN: unauthenticated keeps its reason", async () => {
    const env = await grantEnv();
    const res = await postIngress(env, { op: "create", idempotency_key: "pin-unauth-001" });
    expect(res.status).toBe(401);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "unauthenticated",
    });
  });

  it("PIN: unknown op keeps forbidden_action", async () => {
    const env = await grantEnv();
    const res = await postIngress(
      env,
      { op: "delete", idempotency_key: "pin-forbidden-001" },
      CRED,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "forbidden_action",
    });
  });

  it("PIN: MCP batch refusal keeps -32600", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const res = await postMcp(openEnv, batch);
    expect(res.status).toBe(400);
    const messages = await readMcpMessages(res);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
  });
});

// ---------------------------------------------------------------------------
// REST envelope: code + message + request_id + next (RED)
// ---------------------------------------------------------------------------

describe("machine errors: REST envelope", () => {
  it("RED: 422 invalid_request carries code + request_id + next", async () => {
    const res = await app.request(
      "/api/public/events/not-a-key!",
      { headers: { "cf-connecting-ip": IP } },
      openEnv,
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
    // Static message: the rejected key is never reflected.
    expect(JSON.stringify(body)).not.toContain("not-a-key");
  });

  it("RED: 503 no-database carries code + request_id + next", async () => {
    const res = await app.request(
      "/api/public/events",
      { headers: { "cf-connecting-ip": IP } },
      openEnv,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: 429 rate_limited carries code + request_id + next with Retry-After", async () => {
    const res = await app.request(
      "/api/public/events",
      { headers: { "cf-connecting-ip": IP } },
      limitedEnv,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toContain("42");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: 404 not_found carries code + request_id + next", async () => {
    const env = { ...openEnv, ADMIN_DB: fakeDbWithRows([]) } as unknown as Env & EnvWithThrottle;
    const res = await app.request(
      `/api/public/events/${VALID_KEY}`,
      { headers: { "cf-connecting-ip": IP } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: 500 internal carries code + request_id + next without leaking", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = new Error("boom secret-envelope-marker SELECT * FROM events");
      const env = { ...openEnv, ADMIN_DB: fakeDbThrowing(boom) } as unknown as Env &
        EnvWithThrottle;
      const res = await app.request(
        "/api/public/events",
        { headers: { "cf-connecting-ip": IP } },
        env,
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("secret-envelope-marker");
      expect(text).not.toContain("SELECT");
      const body = JSON.parse(text) as {
        error: { code: string; message: string; request_id: string; next: string };
      };
      expect(body.error.code).toBe("internal");
      expect(body.error.message).toBe(PUBLIC_DATA_INTERNAL_MESSAGE);
      expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
      expect(typeof body.error.next).toBe("string");
      expect(body.error.next.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("RED: transport faults stay 503 unavailable with request_id + next", async () => {
    const err = new Error("connect fail") as Error & { code: string };
    err.code = "ECONNREFUSED";
    const env = { ...openEnv, ADMIN_DB: fakeDbThrowing(err) } as unknown as Env & EnvWithThrottle;
    const res = await app.request(
      "/api/public/events",
      { headers: { "cf-connecting-ip": IP } },
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: REST request_ids are unique per request", async () => {
    const a = await app.request(
      "/api/public/events/bad-a!",
      { headers: { "cf-connecting-ip": IP } },
      openEnv,
    );
    const b = await app.request(
      "/api/public/events/bad-b!",
      { headers: { "cf-connecting-ip": IP } },
      openEnv,
    );
    const ja = (await a.json()) as { error: { request_id: string } };
    const jb = (await b.json()) as { error: { request_id: string } };
    expect(ja.error.request_id).not.toBe(jb.error.request_id);
    expect(ja.error.request_id).toBe(a.headers.get("x-request-id"));
    expect(jb.error.request_id).toBe(b.headers.get("x-request-id"));
  });
});

// ---------------------------------------------------------------------------
// Ingress envelope: code primary, reason alias, + next (RED for code/next)
// ---------------------------------------------------------------------------

describe("machine errors: ingress envelope", () => {
  it("RED: disabled 404 keeps reason and gains code + next", async () => {
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      baseIngressEnv,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      code: string;
      reason: string;
      message: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("ingress_disabled");
    expect(body.code).toBe("ingress_disabled");
    expect(body.code).toBe(body.reason);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: no-store 503 keeps reason and gains code + next", async () => {
    const res = await app.request(
      "/api/agent-events",
      { method: "POST", body: "{}" },
      enabledIngressEnv,
      executionCtx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      message: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("ingress_unavailable");
    expect(body.code).toBe("ingress_unavailable");
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: unauthenticated 401 keeps reason and gains code + next", async () => {
    const env = await grantEnv();
    const res = await postIngress(env, { op: "create", idempotency_key: "env-unauth-001" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      message: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("unauthenticated");
    expect(body.code).toBe("unauthenticated");
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: validation_failed 422 keeps reason and gains code + next", async () => {
    const env = await grantEnv();
    const res = await postIngress(env, { op: 42 }, CRED);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("validation_failed");
    expect(body.code).toBe("validation_failed");
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: forbidden_action 403 keeps reason and gains code + next", async () => {
    const env = await grantEnv();
    const res = await postIngress(
      env,
      { op: "delete", idempotency_key: "env-forbidden-001" },
      CRED,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("forbidden_action");
    expect(body.code).toBe("forbidden_action");
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: grant_expired 403 keeps reason and gains code + next", async () => {
    const fake = makeFakeAgentDb();
    await fake.addGrant("cred-expired-001", {
      id: "grant-expired-k4",
      agent_id: CALLER,
      guild_id: DEFAULT_CONFIG.stagingGuildId,
      expires_at: new Date(Date.now() - 1000),
      disabled_at: null,
    });
    const env = { ...enabledIngressEnv, AGENT_EVENT_SQL: fake.sql } as unknown as Env;
    const res = await postIngress(
      env,
      { op: "create", idempotency_key: "env-expired-001" },
      "cred-expired-001",
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      request_id: string;
      next: string;
    };
    expect(body.reason).toBe("grant_expired");
    expect(body.code).toBe("grant_expired");
    expect(typeof body.next).toBe("string");
    expect(body.next.length).toBeGreaterThan(0);
  });

  it("RED: ingress 500 gains code + request_id + next", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = Object.assign(
        async () => {
          throw new Error("broken ingress store");
        },
        {
          begin: async () => {
            throw new Error("broken ingress store");
          },
          unsafe: async () => [],
        },
      ) as unknown as EnvWithAgentStore["AGENT_EVENT_SQL"];
      const env = { ...enabledIngressEnv, AGENT_EVENT_SQL: broken } as unknown as Env;
      const res = await app.request(
        "/api/agent-events",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer anything" },
          body: JSON.stringify({ op: "create", idempotency_key: "env-500-001" }),
        },
        env,
        executionCtx,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as {
        code: string;
        reason: string;
        message: string;
        request_id: string;
        next: string;
      };
      expect(body.reason).toBe("internal_error");
      expect(body.code).toBe("internal_error");
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id.length).toBeGreaterThan(0);
      expect(typeof body.next).toBe("string");
      expect(body.next.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Feed 503 negotiation: JSON for JSON callers, still no-store (RED)
// ---------------------------------------------------------------------------

describe("machine errors: feed 503 negotiation", () => {
  it("RED: /events.rss JSON callers get a structured envelope", async () => {
    const res = await app.request(
      "/events.rss",
      { headers: { "cf-connecting-ip": IP, accept: "application/json" } },
      openEnv,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: /events.ics JSON callers get a structured envelope", async () => {
    const res = await app.request(
      "/events.ics",
      { headers: { "cf-connecting-ip": IP, accept: "application/json" } },
      openEnv,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      error: { code: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: per-event ICS JSON callers get a structured envelope", async () => {
    const res = await app.request(
      `/events/${VALID_KEY}.ics`,
      { headers: { "cf-connecting-ip": IP, accept: "application/json" } },
      openEnv,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      error: { code: string; request_id: string; next: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(typeof body.error.next).toBe("string");
    expect(body.error.next.length).toBeGreaterThan(0);
  });

  it("RED: feed 503s are no-store even for feed-native callers", async () => {
    const res = await app.request("/events.rss", { headers: { "cf-connecting-ip": IP } }, openEnv);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).toBe("Events temporarily unavailable");
  });

  it("PIN: feed-native Accept stays plaintext on 503", async () => {
    const res = await app.request(
      "/events.rss",
      { headers: { "cf-connecting-ip": IP, accept: "application/rss+xml" } },
      openEnv,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("Events temporarily unavailable");
  });

  it("PIN: throttled feeds stay plaintext even for JSON Accept", async () => {
    const res = await app.request(
      "/events.rss",
      { headers: { "cf-connecting-ip": IP, accept: "application/json" } },
      limitedEnv,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("Too many requests");
  });
});

// ---------------------------------------------------------------------------
// MCP transport: all JSON-RPC with numeric codes + data.next (RED)
// ---------------------------------------------------------------------------

describe("machine errors: MCP transport", () => {
  it("RED: MCP 429 answers JSON-RPC, not the REST envelope", async () => {
    const res = await postMcp(limitedEnv, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    const messages = await readMcpMessages(res);
    expect(messages).toHaveLength(1);
    const msg = messages[0] as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { next: string; request_id: string } };
    };
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBeNull();
    expect(typeof msg.error.code).toBe("number");
    expect(Number.isInteger(msg.error.code)).toBe(true);
    expect(typeof msg.error.message).toBe("string");
    expect(msg.error.message.length).toBeGreaterThan(0);
    expect(typeof msg.error.data.next).toBe("string");
    expect(msg.error.data.next.length).toBeGreaterThan(0);
    expect(typeof msg.error.data.request_id).toBe("string");
    expect(msg.error.data.request_id.length).toBeGreaterThan(0);
    expect(msg).not.toHaveProperty("result");
  });

  it("RED: MCP 429 numeric codes are stable across calls", async () => {
    const a = await readMcpMessages(
      await postMcp(limitedEnv, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    );
    const b = await readMcpMessages(
      await postMcp(limitedEnv, { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }),
    );
    const ca = (a[0] as { error: { code: number } }).error.code;
    const cb = (b[0] as { error: { code: number } }).error.code;
    expect(typeof ca).toBe("number");
    expect(ca).toBe(cb);
  });

  it("RED: MCP batch refusal carries data.next + request_id", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} },
    ];
    const res = await postMcp(openEnv, batch);
    expect(res.status).toBe(400);
    const messages = await readMcpMessages(res);
    expect(messages).toHaveLength(1);
    const msg = messages[0] as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { next: string; request_id: string } };
    };
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBeNull();
    expect(msg.error.code).toBe(-32600);
    expect(typeof msg.error.data.next).toBe("string");
    expect(msg.error.data.next.length).toBeGreaterThan(0);
    expect(typeof msg.error.data.request_id).toBe("string");
    expect(msg.error.data.request_id.length).toBeGreaterThan(0);
  });

  it("RED: MCP 413 answers JSON-RPC with data.next + request_id", async () => {
    const res = await postMcp(
      openEnv,
      { jsonrpc: "2.0", id: 31, method: "tools/list", params: {} },
      { "content-length": "40000" },
    );
    expect(res.status).toBe(413);
    const messages = await readMcpMessages(res);
    expect(messages).toHaveLength(1);
    const msg = messages[0] as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { next: string; request_id: string } };
    };
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBeNull();
    expect(typeof msg.error.code).toBe("number");
    expect(Number.isInteger(msg.error.code)).toBe(true);
    expect(msg.error.message).toBe("Reduce the size of your request and try again.");
    expect(typeof msg.error.data.next).toBe("string");
    expect(msg.error.data.next.length).toBeGreaterThan(0);
    expect(typeof msg.error.data.request_id).toBe("string");
    expect(msg.error.data.request_id.length).toBeGreaterThan(0);
  });

  it("RED: every MCP transport error is a JSON-RPC error object", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 41, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 42, method: "tools/list", params: {} },
    ];
    for (const res of [
      await postMcp(limitedEnv, { jsonrpc: "2.0", id: 43, method: "tools/list", params: {} }),
      await postMcp(openEnv, batch),
      await postMcp(
        openEnv,
        { jsonrpc: "2.0", id: 44, method: "tools/list", params: {} },
        { "content-length": "40000" },
      ),
    ]) {
      const messages = await readMcpMessages(res);
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg).toHaveProperty("error");
      expect(msg).not.toHaveProperty("result");
      const err = msg.error as { code: unknown; message: unknown; data: unknown };
      expect(typeof err.code).toBe("number");
      expect(typeof err.message).toBe("string");
      expect(typeof err.data).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAPI and doc agreement (RED for new keys/doc)
// ---------------------------------------------------------------------------

describe("machine errors: OpenAPI and doc agreement", () => {
  it("RED: OpenAPI error schema requires code + message + request_id + next", () => {
    const spec = getOpenApiDocument(APP_URL);
    const schemas = spec.components.schemas as Record<
      string,
      { properties?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }
    >;
    const err = schemas.PublicDataError?.properties?.error;
    expect(err?.required?.slice().sort()).toEqual(["code", "message", "next", "request_id"].sort());
    expect(Object.keys(err?.properties ?? {}).sort()).toEqual(
      ["code", "message", "next", "request_id"].sort(),
    );
  });

  it("PIN: OpenAPI error codes still include the five without renames", () => {
    const spec = getOpenApiDocument(APP_URL);
    const schemas = spec.components.schemas as unknown as Record<
      string,
      { properties: { error: { properties: { code: { enum: string[] } } } } }
    >;
    const err = schemas.PublicDataError?.properties.error.properties.code;
    expect(err).toBeDefined();
    for (const code of PUBLIC_DATA_ERROR_CODES) {
      expect(err?.enum).toContain(code);
    }
  });

  it("RED: OpenAPI description documents request_id and next", () => {
    const spec = getOpenApiDocument(APP_URL);
    expect(spec.info.description).toContain("request_id");
    expect(spec.info.description).toContain("next");
  });

  it("RED: served /openapi.json matches the code envelope", async () => {
    const res = await app.request(
      "/openapi.json",
      { headers: { "cf-connecting-ip": IP } },
      openEnv,
    );
    expect(res.status).toBe(200);
    const spec = (await res.json()) as ReturnType<typeof getOpenApiDocument>;
    const schemas = spec.components.schemas as Record<
      string,
      { properties?: Record<string, { required?: string[] }> }
    >;
    expect(schemas.PublicDataError?.properties?.error?.required?.slice().sort()).toEqual(
      ["code", "message", "next", "request_id"].sort(),
    );
  });

  it("RED: docs/machine-errors.md is the single source in 60 lines or fewer", () => {
    let text: string;
    try {
      text = readFileSync(new URL("docs/machine-errors.md", root), "utf8");
    } catch {
      throw new Error("docs/machine-errors.md is missing: K4 needs the single-source table");
    }
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(text).toContain("request_id");
    expect(text).toContain("next");
    for (const code of PUBLIC_DATA_ERROR_CODES) {
      expect(text).toContain(code);
    }
    for (const surface of ["REST", "ingress", "feed", "MCP"]) {
      expect(text.toLowerCase()).toContain(surface.toLowerCase());
    }
  });
});
