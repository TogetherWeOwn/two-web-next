// route-inventory: POST /mcp
// route-inventory: OPTIONS /mcp
// Stateless public read-only MCP at /mcp (B2): exact tool allowlist over the
// published-only reads, no session, no mutations. Real app +
// agent-testdb/CI Postgres only.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { MCP_TOOL_NAMES } from "../src/mcp/server";
import {
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
  type CommunitySnapshotDto,
  type JoinHandoffDto,
  type PublicApiEventCollectionDto,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const INVITE_URL = "https://discord.gg/test-invite-handoff";

// All-digit 26-char keys, same shape as the api-public-events pins, so no
// secret scanner trips.
const key = (n: number) => String(n).padStart(26, "0");

type RpcResponse = {
  status: number;
  headers: Headers;
  messages: Record<string, unknown>[];
};

describe.skipIf(!process.env.DATABASE_URL)("public MCP: /mcp", () => {
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
    hits = [];
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const post = async (
    body: unknown,
    init: RequestInit = {},
    ip = "192.0.2.71",
  ): Promise<RpcResponse> => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        ...init,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": ip,
          ...init.headers,
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

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  const moderatorCookie = async () => {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "100000000000000171",
      username: "100000000000000171",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };

  const initialize = (id: number | string = 1) =>
    post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-public-test", version: "0" },
      },
    });

  const notifyInitialized = () => post({ jsonrpc: "2.0", method: "notifications/initialized" });

  const callTool = (name: string, args: Record<string, unknown>, id: number | string = 3) =>
    post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  it("completes the legacy-stateless handshake", async () => {
    const hello = await initialize();
    expect(hello.status).toBe(200);
    expect(hello.messages).toHaveLength(1);
    const result = hello.messages[0]!["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("two-web-next");
    const ack = await notifyInitialized();
    expect([200, 202]).toContain(ack.status);
  });

  it("lists exactly the four read-only tools and no prompts or resources", async () => {
    await initialize();
    await notifyInitialized();
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.status).toBe(200);
    const names = (
      (listed.messages[0]!["result"] as Record<string, unknown>)["tools"] as {
        name: string;
      }[]
    ).map((tool) => tool.name);
    expect(names.sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect([...MCP_TOOL_NAMES].sort()).toEqual([
      "get_community",
      "get_event",
      "get_join",
      "list_events",
    ]);
    // No prompts or resources are registered, so the server answers method
    // not found rather than an empty list: there is no hidden surface.
    const prompts = await post({ jsonrpc: "2.0", id: 10, method: "prompts/list" });
    expect(prompts.messages[0]).toMatchObject({ jsonrpc: "2.0", id: 10 });
    expect((prompts.messages[0]!["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(prompts.messages[0]).not.toHaveProperty("result");
    const resources = await post({ jsonrpc: "2.0", id: 11, method: "resources/list" });
    expect((resources.messages[0]!["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(resources.messages[0]).not.toHaveProperty("result");
    for (const tool of (listed.messages[0]!["result"] as Record<string, unknown>)["tools"] as {
      name: string;
      annotations?: Record<string, unknown>;
    }[]) {
      expect(tool.annotations?.["readOnlyHint"]).toBe(true);
    }
  });

  it("serves list_events with the same published rows as the REST collection", async () => {
    await seed(44);
    await seed(45, { status: "draft", title: "Hidden draft" });
    await initialize();
    await notifyInitialized();
    const called = await callTool("list_events", { per_page: 20, page: 1 });
    expect(called.status).toBe(200);
    const result = called.messages[0]!["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data.map((row) => row.event_key)).toEqual([key(44)]);
    for (const row of structured.data) {
      expect(Object.keys(row).sort()).toEqual([...PUBLIC_API_EVENT_FIELDS].sort());
      expect(validatePublicSchema(row, "PublicApiEvent")).toEqual([]);
    }
    const rest = await app.request(
      "/api/public/events",
      { headers: { "cf-connecting-ip": "192.0.2.72" } },
      env,
    );
    expect(structured).toEqual(await rest.json());
  });

  it("serves get_event and refuses unknown tools without a mutation surface", async () => {
    await seed(11);
    await initialize();
    await notifyInitialized();
    const one = await callTool("get_event", { event_key: key(11) });
    const single = (one.messages[0]!["result"] as Record<string, unknown>)[
      "structuredContent"
    ] as Record<string, unknown>;
    expect(single["event_key"]).toBe(key(11));
    expect(Object.keys(single).sort()).toEqual([...PUBLIC_API_EVENT_FIELDS].sort());
    const missing = await callTool("get_event", { event_key: key(12) }, 4);
    expect((missing.messages[0]!["result"] as Record<string, unknown>)["isError"]).toBe(true);
    const unknown = await callTool("rsvp_create", {}, 5);
    expect(unknown.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32602 },
    });
  });

  it("serves community and join snapshots shaped like the REST DTOs", async () => {
    await initialize();
    await notifyInitialized();
    const community = await callTool("get_community", {}, 6);
    const snapshot = (community.messages[0]!["result"] as Record<string, unknown>)[
      "structuredContent"
    ] as CommunitySnapshotDto;
    expect(Object.keys(snapshot).sort()).toEqual([...COMMUNITY_SNAPSHOT_FIELDS].sort());
    expect(snapshot.member_count).toBeNull();
    expect(validatePublicSchema(snapshot, "CommunitySnapshot")).toEqual([]);
    const join = await callTool("get_join", {}, 7);
    const handoff = (join.messages[0]!["result"] as Record<string, unknown>)[
      "structuredContent"
    ] as JoinHandoffDto;
    expect(Object.keys(handoff).sort()).toEqual([...JOIN_HANDOFF_FIELDS].sort());
    expect(handoff.invite_url).toBe(INVITE_URL);
    expect(validatePublicSchema(handoff, "JoinHandoff")).toEqual([]);
  });

  it("returns byte-identical results to cookie-bearing viewers and sets no cookie", async () => {
    await seed(44);
    const cookie = await moderatorCookie();
    await initialize();
    await notifyInitialized();
    const anon = await callTool("list_events", { per_page: 20, page: 1 }, 8);
    const authed = await post(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "list_events", arguments: { per_page: 20, page: 1 } },
      },
      { headers: { cookie } },
    );
    expect(JSON.stringify(authed.messages)).toBe(JSON.stringify(anon.messages));
    expect(authed.headers.get("set-cookie")).toBeNull();
    expect(anon.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a forged browser Origin but admits localhost and Origin-less clients", async () => {
    const evil = await post(
      { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} },
      { headers: { origin: "https://evil.test" } },
    );
    expect(evil.status).toBe(403);
    expect(evil.messages).toHaveLength(1);
    expect(evil.messages[0]).not.toHaveProperty("result");
    const local = await post(
      { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
      { headers: { origin: "http://localhost:6274" } },
    );
    expect(local.status).toBeLessThan(300);
    const bare = await post({ jsonrpc: "2.0", id: 22, method: "tools/list", params: {} });
    expect(bare.status).toBeLessThan(300);
  });

  it("refuses a foreign Host before routing", async () => {
    const res = await app.request(
      "https://evil.test/mcp",
      {
        method: "POST",
        headers: {
          host: "evil.test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "cf-connecting-ip": "192.0.2.75",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/list", params: {} }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("answers only the exact path and the POST/OPTIONS methods", async () => {
    const plain = { "content-type": "application/json", "cf-connecting-ip": "192.0.2.76" };
    // Origin-less POSTs never reach routing: the global guard refuses first,
    // and the /mcp exemption covers the exact path only.
    for (const path of ["/mcp/extra", "/mcp/"]) {
      const res = await app.request(path, { method: "POST", headers: plain, body: "{}" }, env);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin" });
    }
    // Past the guard (same-origin callers), routing still 404s non-exact paths.
    for (const path of ["/mcp/extra", "/mcp/"]) {
      const res = await app.request(
        path,
        { method: "POST", headers: { ...plain, origin: APP_URL }, body: "{}" },
        env,
      );
      expect(res.status).toBe(404);
    }
    const get = await app.request("/mcp", { method: "GET", headers: plain }, env);
    expect(get.status).toBe(404);
    // PUT/PATCH/DELETE stay under the global guard: no exemption, no handler.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: plain }, env);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin" });
    }
    const preflight = await app.request(
      "/mcp",
      {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "cf-connecting-ip": "192.0.2.76",
        },
      },
      env,
    );
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("rate-limits tool calls under the shared public budget with a JSON 429", async () => {
    now = Date.now();
    for (let i = 0; i < 60; i++) hits.push({ bucket: "events-read:192.0.2.77", at: now });
    const res = await post(
      { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} },
      {},
      "192.0.2.77",
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses JSON-RPC batches with -32600/400 without burning the budget", async () => {
    await seed(44);
    const batch = [
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
    const res = await post(batch, {}, "192.0.2.78");
    expect(res.status).toBe(400);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
    });
    expect(res.messages[0]).not.toHaveProperty("result");
    // No admission burn and no tool run: the shared budget is untouched.
    expect(hits).toHaveLength(0);
  });

  it.each([
    { name: "list_events", args: { per_page: 20, page: 1 }, id: 50 },
    { name: "get_event", args: { event_key: key(11) }, id: 51 },
  ])(
    "returns a static error and alerts instead of leaking SQL on $name failure",
    async ({ name, args, id }) => {
      __resetAlertRateLimitForTests();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        class McpBoomError extends Error {}
        // Plain fake, not a Proxy around the real Db: memberReadDb passes
        // non-Postgres adapters through unwrapped, so select reliably throws.
        const boomDb = {
          select() {
            throw new McpBoomError(
              'Failed query: select "id", "event_key" from "events" params: secret',
            );
          },
        } as unknown as typeof db;
        const boomEnv = {
          ...env,
          get ADMIN_DB() {
            return boomDb;
          },
        } as unknown as Env & EnvWithThrottle;
        const res = await app.request(
          "/mcp",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "cf-connecting-ip": "192.0.2.79",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          },
          boomEnv,
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        const message = JSON.parse(
          text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())[0]!,
        ) as Record<string, unknown>;
        const result = message["result"] as Record<string, unknown>;
        expect(result["isError"]).toBe(true);
        const content = result["content"] as { text: string }[];
        const body = JSON.parse(content[0]!.text) as {
          error: { code: string; message: string };
        };
        expect(body.error.code).toBe("internal");
        expect(body.error.message).toBe("Event data could not be read.");
        expect(content[0]!.text).not.toContain("Failed query");
        expect(content[0]!.text).not.toContain("event_key");
        const alerts = spy.mock.calls
          .map((args) => {
            try {
              return JSON.parse(args[0] as string) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((line) => line?.["event"] === "error.alert");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          method: "POST",
          route: "/mcp",
          fingerprint: "McpBoomError@/mcp",
        });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("alerts once when the tool factory throws", async () => {
    __resetAlertRateLimitForTests();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      class McpFactoryBoomError extends Error {}
      const factoryBoomEnv = {
        ...env,
        get ADMIN_DB(): never {
          throw new McpFactoryBoomError("factory boom");
        },
      } as unknown as Env & EnvWithThrottle;
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "cf-connecting-ip": "192.0.2.80",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 60, method: "tools/list", params: {} }),
        },
        factoryBoomEnv,
      );
      // The SDK answers a factory failure as a 500 JSON-RPC error; the
      // wrapper above is what raises the single error.alert for it.
      expect(res.status).toBe(500);
      const alerts = spy.mock.calls
        .map((args) => {
          try {
            return JSON.parse(args[0] as string) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((line) => line?.["event"] === "error.alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        method: "POST",
        route: "/mcp",
        fingerprint: "McpFactoryBoomError@/mcp",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    {
      label: "unknown body",
      body: { hello: "world" },
      headers: {} as Record<string, string>,
      id: 61,
      ip: "192.0.2.81",
    },
    {
      label: "bad protocol version",
      body: { jsonrpc: "2.0", id: 62, method: "tools/list", params: {} },
      headers: { "mcp-protocol-version": "2099-01-01" } as Record<string, string>,
      id: 62,
      ip: "192.0.2.82",
    },
  ])("stays silent on client protocol error: $label", async ({ body, headers, ip }) => {
    __resetAlertRateLimitForTests();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "cf-connecting-ip": ip,
            ...headers,
          },
          body: JSON.stringify(body),
        },
        env,
      );
      expect(res.status).toBe(400);
      const alerts = spy.mock.calls
        .map((args) => {
          try {
            return JSON.parse(args[0] as string) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((line) => line?.["event"] === "error.alert");
      expect(alerts).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
