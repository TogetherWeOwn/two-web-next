// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /events.md
// route-inventory: GET /e/:file{.+\.md}
// route-inventory: POST /mcp
// route-inventory: GET /openapi.json
// Acceptance (failing-first, Test Author owned): public machine reads return
// route-native machine failures instead of branded HTML. Unexpected faults on
// the /api/public reads answer the existing allowlisted public error envelope
// with the static internal code/message and 500; event/leaf .md faults stay
// Markdown with static actionable guidance and 500; early /mcp oversized or
// broken uploads answer a documented JSON-RPC error with null id and a static
// code/message, keeping 413/400 semantics, body cancellation and the
// body-before-admission order. Healthy DTOs, MCP tools, rate/admission
// ordering, caps, no-store/Vary and the browser shell are preserved. Real app
// + agent-testdb/CI Postgres only; the builder implements on this branch and
// never edits this file.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import app from "./app";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { MARKDOWN_MIME } from "../src/ai-friendly/md";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import {
  PUBLIC_API_EVENT_FIELDS,
  type PublicApiEventCollectionDto,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { parseJsonLines } from "./helpers/parse-json-lines";
import { validatePublicSchema } from "./helpers/public-api-schema";

// Serializer-fault injection only: with the flags off every read delegates to
// the real implementation. Query faults need no mock: a fake ADMIN_DB whose
// select() throws reaches the same rethrow path as a programming fault.
const faultFlags = vi.hoisted(() => ({ restSerializerBoom: false, mdSerializerBoom: false }));
vi.mock("../src/events/reads", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/events/reads")>();
  const badInstant = new Date(NaN);
  return {
    ...original,
    listPublicApiEvents: async (...args: Parameters<typeof original.listPublicApiEvents>) => {
      if (!faultFlags.restSerializerBoom) return original.listPublicApiEvents(...args);
      return {
        rows: [
          {
            eventKey: "00000000000000000000000072",
            title: "serializer-boom secret-row-marker",
            game: null,
            description: null,
            startsAt: badInstant,
            endsAt: badInstant,
            timezone: "UTC",
            location: null,
            capacity: null,
            goingCount: null,
            goingOccupancy: null,
            rsvpOpen: true,
            discordEventId: null,
          },
        ],
        total: 1,
        page: 1,
      } as never;
    },
    getPublicApiEvent: async (...args: Parameters<typeof original.getPublicApiEvent>) => {
      if (!faultFlags.restSerializerBoom) return original.getPublicApiEvent(...args);
      return {
        eventKey: "00000000000000000000000072",
        title: "serializer-boom secret-row-marker",
        game: null,
        description: null,
        startsAt: badInstant,
        endsAt: badInstant,
        timezone: "UTC",
        location: null,
        capacity: null,
        goingCount: null,
        goingOccupancy: null,
        rsvpOpen: true,
        discordEventId: null,
      } as never;
    },
    listFeed: async (...args: Parameters<typeof original.listFeed>) => {
      if (!faultFlags.mdSerializerBoom) return original.listFeed(...args);
      return [
        {
          eventKey: "00000000000000000000000073",
          title: "md-serializer-boom secret-row-marker",
          game: null,
          description: null,
          startsAt: badInstant,
          endsAt: badInstant,
          timezone: "UTC",
          location: null,
          capacity: null,
          status: "published",
        },
      ] as never;
    },
    getPublicEvent: async (...args: Parameters<typeof original.getPublicEvent>) => {
      if (!faultFlags.mdSerializerBoom) return original.getPublicEvent(...args);
      return {
        eventKey: "01J0000000000000000000PXB1",
        title: "md-serializer-boom secret-row-marker",
        game: null,
        description: null,
        startsAt: badInstant,
        endsAt: badInstant,
        timezone: "UTC",
        location: null,
        capacity: null,
        status: "published",
      } as never;
    },
  };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MD_DETAIL_KEY = "01J0000000000000000000PXB1";
const BUDGET = 60;
const MCP_MAX = BODY_LIMIT_BYTES.mcp;

// All-digit 26-char keys, same shape as the api-public-events pins, so no
// secret scanner trips.
const key = (n: number) => String(n).padStart(26, "0");

// The pinned route-native contracts. REST reuses the MCP tool's static
// internal message so the two machine surfaces cannot drift; Markdown reuses
// the outage bytes plus the safe next action; /mcp wraps the existing 413/400
// messages in the JSON-RPC error shape with one static transport code.
const REST_INTERNAL = {
  error: { code: "internal", message: "Event data could not be read." },
} as const;
const MD_INTERNAL_BODY = "Events temporarily unavailable. Try again shortly.";
const MCP_TRANSPORT_CODE = -32600;
const MCP_413_MESSAGE = "Reduce the size of your request and try again.";
const MCP_400_MESSAGE = "Check your request and try again.";
const mcpError = (message: string) => ({
  jsonrpc: "2.0",
  id: null,
  error: { code: MCP_TRANSPORT_CODE, message },
});

const SQL_TEXT = 'select "id", "event_key" from "events"';
const ROW_SECRET = "secret-row-marker";
const STREAM_SECRET = "secret-stream-marker";

const root = new URL("../", import.meta.url);

describe.skipIf(!process.env.DATABASE_URL)("route-native machine failures", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let env: Env & EnvWithThrottle;
  let now: number;
  let hits: { bucket: string; at: number }[];
  let eventStore: Mock<() => unknown>;
  let spy: ReturnType<typeof vi.spyOn>;

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
        unsafe: async () => [],
      },
    );
    return sql;
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    now = Date.now();
    hits = [];
    eventStore = vi.fn(() => db);
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_STORE: createMemorySessionStore(),
      THROTTLE_STORE: async () => throttleDouble() as unknown as Sql,
      get ADMIN_DB() {
        return eventStore();
      },
    } as unknown as Env & EnvWithThrottle;
  });
  beforeEach(async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.reset();
    __resetApiPublicCacheForTests();
    __resetAlertRateLimitForTests();
    now = Date.now();
    hits = [];
    eventStore.mockReset();
    eventStore.mockImplementation(() => db);
    faultFlags.restSerializerBoom = false;
    faultFlags.mdSerializerBoom = false;
  });
  afterEach(() => {
    spy.mockRestore();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string, headers: Record<string, string> = {}, ip = "192.0.2.71") =>
    app.request(path, { headers: { "cf-connecting-ip": ip, ...headers } }, env);

  const postMcp = async (init: RequestInit, ip = "192.0.2.71") =>
    app.request(
      "/mcp",
      {
        method: "POST",
        ...init,
        headers: { "cf-connecting-ip": ip, ...init.headers },
      },
      env,
    );

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  const seedMd = (eventKey: string, status: "published" | "draft" = "published") =>
    db.insert(events).values({
      eventKey,
      title: `t-${eventKey}`,
      description: "Bring stims.",
      startsAt: new Date("2099-01-01T00:00:00Z"),
      endsAt: new Date("2099-01-02T00:00:00Z"),
      timezone: "UTC",
      location: "Voice: General",
      status,
    } as never);

  // Plain fake, not a Proxy around the real Db: memberReadDb passes
  // non-Postgres adapters through unwrapped, so select reliably throws.
  const boomDb = (boom: Error, selectSpy?: Mock) =>
    ({
      select(...args: unknown[]) {
        selectSpy?.(...args);
        throw boom;
      },
    }) as unknown as typeof db;

  class QueryBoomError extends Error {}
  const queryBoom = () => new QueryBoomError(`Failed query: ${SQL_TEXT} params: ${ROW_SECRET}`);

  const sseMessages = (text: string): Record<string, unknown>[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length).trim()));

  const alerts = () => {
    const { parsed, skipped } = parseJsonLines(spy.mock.calls);
    expect(skipped, `unparsed log lines: ${JSON.stringify(skipped)}`).toEqual([]);
    return parsed
      .map(({ value }) => value as Record<string, unknown>)
      .filter((line) => line?.["event"] === "error.alert");
  };

  const expectNoLeak = (text: string) => {
    expect(text).not.toContain("<html");
    expect(text).not.toContain("<!doctype");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain(SQL_TEXT);
    expect(text).not.toContain(ROW_SECRET);
    expect(text).not.toContain(STREAM_SECRET);
    expect(text).not.toContain("serializer-boom");
  };

  type MatrixRow = {
    name: string;
    run: () => Promise<{ res: Response; pull?: Mock; cancel?: Mock }>;
    status: number;
    contentType: string;
    body: (text: string) => Promise<void> | void;
    varyAccept: boolean;
    zeroHits: boolean;
  };

  const matrix: MatrixRow[] = [
    ...(
      [
        ["absent Accept", {}],
        ["wildcard Accept", { accept: "*/*" }],
        ["browser Accept", { accept: "text/html" }],
        ["JSON Accept", { accept: "application/json" }],
      ] as const
    ).map(([label, headers]) => ({
      name: `REST collection query fault (${label}) -> 500 internal envelope`,
      run: async () => {
        eventStore.mockImplementation(() => boomDb(queryBoom()));
        return { res: await get("/api/public/events", { ...headers }, "192.0.2.73") };
      },
      status: 500,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(REST_INTERNAL);
      },
      varyAccept: true,
      zeroHits: false,
    })),
    {
      name: "REST single query fault (absent Accept) -> 500 internal envelope",
      run: async () => {
        eventStore.mockImplementation(() => boomDb(queryBoom()));
        return { res: await get(`/api/public/events/${key(11)}`, {}, "192.0.2.74") };
      },
      status: 500,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(REST_INTERNAL);
      },
      varyAccept: true,
      zeroHits: false,
    },
    {
      name: "REST serializer fault (JSON Accept) -> 500 internal envelope, no row data",
      run: async () => {
        faultFlags.restSerializerBoom = true;
        return {
          res: await get("/api/public/events", { accept: "application/json" }, "192.0.2.75"),
        };
      },
      status: 500,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(REST_INTERNAL);
      },
      varyAccept: true,
      zeroHits: false,
    },
    ...(
      [
        ["absent Accept", {}],
        ["browser Accept", { accept: "text/html" }],
        ["wildcard Accept", { accept: "*/*" }],
      ] as const
    ).map(([label, headers]) => ({
      name: `Markdown collection query fault (${label}) -> 500 Markdown guidance`,
      run: async () => {
        eventStore.mockImplementation(() => boomDb(queryBoom()));
        return { res: await get("/events.md", { ...headers }, "192.0.2.76") };
      },
      status: 500,
      contentType: "text/markdown",
      body: async (text: string) => {
        expect(text).toBe(MD_INTERNAL_BODY);
      },
      // URL-addressed, never negotiated: the Markdown outage helpers set no Vary.
      varyAccept: false,
      zeroHits: false,
    })),
    {
      name: "Markdown detail query fault (wildcard Accept) -> 500 Markdown guidance",
      run: async () => {
        eventStore.mockImplementation(() => boomDb(queryBoom()));
        return { res: await get(`/e/${MD_DETAIL_KEY}.md`, { accept: "*/*" }, "192.0.2.77") };
      },
      status: 500,
      contentType: "text/markdown",
      body: async (text: string) => {
        expect(text).toBe(MD_INTERNAL_BODY);
      },
      varyAccept: false,
      zeroHits: false,
    },
    {
      name: "Markdown serializer fault (absent Accept) -> 500 Markdown guidance",
      run: async () => {
        faultFlags.mdSerializerBoom = true;
        return { res: await get("/events.md", {}, "192.0.2.78") };
      },
      status: 500,
      contentType: "text/markdown",
      body: async (text: string) => {
        expect(text).toBe(MD_INTERNAL_BODY);
      },
      varyAccept: false,
      zeroHits: false,
    },
    ...(
      [
        ["absent Accept", {}],
        ["wildcard Accept", { accept: "*/*" }],
        ["browser Accept", { accept: "text/html" }],
        ["JSON Accept", { accept: "application/json" }],
      ] as const
    ).map(([label, headers]) => ({
      name: `MCP advertised overcap (${label}) -> 413 JSON-RPC error, upload cancelled`,
      run: async () => {
        const pull = vi.fn();
        const cancel = vi.fn();
        const res = await postMcp(
          {
            body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
            duplex: "half",
            headers: {
              "content-type": "application/json",
              "content-length": String(MCP_MAX + 1),
              ...headers,
            },
          } as RequestInit,
          "192.0.2.79",
        );
        return { res, pull: pull as Mock, cancel: cancel as Mock };
      },
      status: 413,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(mcpError(MCP_413_MESSAGE));
      },
      varyAccept: true,
      zeroHits: true,
    })),
    {
      name: "MCP streamed overcap (absent Accept) -> 413 JSON-RPC error, upload cancelled",
      run: async () => {
        const cancel = vi.fn();
        const res = await postMcp(
          {
            body: new ReadableStream<Uint8Array>(
              {
                cancel,
                pull: (controller) => controller.enqueue(new Uint8Array(1024)),
              },
              { highWaterMark: 0 },
            ),
            duplex: "half",
            headers: { "content-type": "application/json", "content-length": "1" },
          } as RequestInit,
          "192.0.2.80",
        );
        return { res, cancel: cancel as Mock };
      },
      status: 413,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(mcpError(MCP_413_MESSAGE));
      },
      varyAccept: true,
      zeroHits: true,
    },
    ...(
      [
        ["absent Accept", {}],
        ["JSON Accept", { accept: "application/json" }],
      ] as const
    ).map(([label, headers]) => ({
      name: `MCP broken upload (${label}) -> 400 JSON-RPC error`,
      run: async () => {
        const res = await postMcp(
          {
            body: new ReadableStream<Uint8Array>({
              pull() {
                throw new Error(`upload-stream-boom ${STREAM_SECRET}`);
              },
            }),
            duplex: "half",
            headers: { "content-type": "application/json", ...headers },
          } as RequestInit,
          "192.0.2.81",
        );
        return { res };
      },
      status: 400,
      contentType: "application/json",
      body: async (text: string) => {
        expect(JSON.parse(text)).toEqual(mcpError(MCP_400_MESSAGE));
      },
      varyAccept: true,
      zeroHits: true,
    })),
  ];

  describe("offline request matrix: status, Content-Type and envelope per family", () => {
    it.each(matrix)("$name", async (row) => {
      const { res, pull, cancel } = await row.run();
      expect(res.status).toBe(row.status);
      expect(res.headers.get("content-type")).toContain(row.contentType);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      if (row.varyAccept) expect(res.headers.get("vary")).toContain("Accept");
      if (row.zeroHits) expect(hits).toHaveLength(0);
      if (pull) expect(pull).not.toHaveBeenCalled();
      if (cancel) expect(cancel).toHaveBeenCalled();
      const text = await res.text();
      expectNoLeak(text);
      await row.body(text);
    });
  });

  describe("alert and privacy boundary", () => {
    it("REST fault alerts once with the class fingerprint and keeps the envelope static", async () => {
      class RestAlertBoomError extends Error {}
      eventStore.mockImplementation(() =>
        boomDb(new RestAlertBoomError(`Failed query: ${SQL_TEXT} params: ${ROW_SECRET}`)),
      );
      const res = await get("/api/public/events", {}, "192.0.2.82");
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual(REST_INTERNAL);
      // Admission still runs before the query: the faulting request burns one hit.
      expect(hits).toHaveLength(1);
      const lines = alerts();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        method: "GET",
        route: "/api/public/events",
        fingerprint: "RestAlertBoomError@/api/public/events",
      });
      const line = JSON.stringify(lines[0]);
      expect(line).not.toContain("Failed query");
      expect(line).not.toContain(ROW_SECRET);
    });

    it("Markdown fault alerts once and never trips the member-read refusal", async () => {
      class MdAlertBoomError extends Error {}
      eventStore.mockImplementation(() =>
        boomDb(new MdAlertBoomError(`Failed query: ${SQL_TEXT} params: ${ROW_SECRET}`)),
      );
      const res = await get(`/e/${MD_DETAIL_KEY}.md`, {}, "192.0.2.83");
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
      const text = await res.text();
      expect(text).toBe(MD_INTERNAL_BODY);
      expect(text).not.toContain("Member data is temporarily unavailable.");
      const lines = alerts();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        method: "GET",
        route: "/e/:file{.+\\.md}",
        fingerprint: "MdAlertBoomError@/e/:file{.+\\.md}",
      });
      const line = JSON.stringify(lines[0]);
      expect(line).not.toContain("Failed query");
      expect(line).not.toContain(ROW_SECRET);
    });
  });

  describe("MCP upload cancellation", () => {
    it("settles the advertised 413 JSON-RPC error even when cancel never settles", async () => {
      const pull = vi.fn();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const pending = Symbol("pending");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof pending>((resolve) => {
        timer = setTimeout(() => resolve(pending), 2000);
      });
      try {
        const raced = await Promise.race([
          postMcp(
            {
              body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
              duplex: "half",
              headers: {
                "content-type": "application/json",
                "content-length": String(MCP_MAX + 1),
              },
            } as RequestInit,
            "192.0.2.84",
          ),
          timeout,
        ]);
        expect(raced, "413 refusal must settle before the deadline").not.toBe(pending);
        const res = raced as Response;
        expect(res.status).toBe(413);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual(mcpError(MCP_413_MESSAGE));
        expect(pull).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
        expect(hits).toHaveLength(0);
      } finally {
        clearTimeout(timer);
      }
    });
  });

  describe("preserved contracts", () => {
    it("serves healthy event DTOs unchanged", async () => {
      await seed(71);
      const res = await get("/api/public/events", {}, "192.0.2.85");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      const body = (await res.json()) as PublicApiEventCollectionDto;
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(Object.keys(body.data[0]!).sort()).toEqual([...PUBLIC_API_EVENT_FIELDS].sort());
      expect(validatePublicSchema(body.data[0], "PublicApiEvent")).toEqual([]);
      expect(validatePublicSchema(body, "PublicApiEventCollection")).toEqual([]);
      const single = await get(`/api/public/events/${key(71)}`, {}, "192.0.2.86");
      expect(single.status).toBe(200);
      expect(validatePublicSchema(await single.json(), "PublicApiEvent")).toEqual([]);
      const md = await get("/events.md", {}, "192.0.2.87");
      expect(md.status).toBe(200);
      expect(md.headers.get("content-type")).toBe(MARKDOWN_MIME);
    });

    it("serves healthy Markdown detail and MCP tools unchanged", async () => {
      await seedMd(MD_DETAIL_KEY);
      const md = await get(`/e/${MD_DETAIL_KEY}.md`, {}, "192.0.2.88");
      expect(md.status).toBe(200);
      expect(md.headers.get("content-type")).toBe(MARKDOWN_MIME);
      expect(await md.text()).toContain(`t-${MD_DETAIL_KEY}`);
      const res = await postMcp(
        {
          body: JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/list", params: {} }),
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        "192.0.2.89",
      );
      expect(res.status).toBe(200);
      const messages = sseMessages(await res.text());
      const result = messages[0]?.["result"] as Record<string, unknown>;
      const tools = result["tools"] as { name: string; annotations?: { readOnlyHint?: boolean } }[];
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "get_community",
        "get_event",
        "get_join",
        "list_events",
      ]);
      for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(result).not.toHaveProperty("prompts");
      expect(result).not.toHaveProperty("resources");
    });

    it("keeps the no-database 503s: envelope, Markdown and tool error", async () => {
      eventStore.mockImplementation(() => null);
      const rest = await get("/api/public/events", {}, "192.0.2.90");
      expect(rest.status).toBe(503);
      expect(await rest.json()).toEqual({
        error: { code: "unavailable", message: "Event data is temporarily unavailable." },
      });
      const md = await get("/events.md", {}, "192.0.2.91");
      expect(md.status).toBe(503);
      expect(md.headers.get("content-type")).toBe(MARKDOWN_MIME);
      expect(await md.text()).toBe("Events temporarily unavailable");
      const mcp = await postMcp(
        {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 71,
            method: "tools/call",
            params: { name: "list_events", arguments: { per_page: 20, page: 1 } },
          }),
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        "192.0.2.92",
      );
      expect(mcp.status).toBe(200);
      const result = sseMessages(await mcp.text())[0]?.["result"] as Record<string, unknown>;
      expect(result["isError"]).toBe(true);
      const content = result["content"] as { text: string }[];
      expect(JSON.parse(content[0]!.text)).toEqual({
        error: { code: "unavailable", message: "Event data is temporarily unavailable." },
      });
    });

    it("keeps transport failures on the 503 outage path, never the 500 envelope", async () => {
      const transport = (message: string) => {
        const err = new Error(message) as Error & { code?: string };
        err.name = "PostgresError";
        err.code = "ECONNREFUSED";
        return err;
      };
      eventStore.mockImplementation(() => boomDb(transport("connect ECONNREFUSED")));
      const rest = await get("/api/public/events", {}, "192.0.2.93");
      expect(rest.status).toBe(503);
      expect(await rest.json()).toEqual({
        error: { code: "unavailable", message: "Event data is temporarily unavailable." },
      });
      const md = await get("/events.md", {}, "192.0.2.94");
      expect(md.status).toBe(503);
      expect(await md.text()).toBe("Events temporarily unavailable");
    });

    it("refuses over-budget callers with 429 before any database read", async () => {
      const ip = "192.0.2.95";
      for (let i = 0; i < BUDGET; i++) hits.push({ bucket: `events-read:${ip}`, at: now });
      const selectSpy = vi.fn();
      eventStore.mockImplementation(() => boomDb(queryBoom(), selectSpy as Mock));
      const res = await get("/api/public/events", {}, ip);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toEqual({
        error: { code: "rate_limited", message: "Too many requests. Try again in 60 seconds." },
      });
      expect(selectSpy).not.toHaveBeenCalled();
      expect(hits).toHaveLength(BUDGET);
    });

    it("leaves the browser shell alone: unknown routes still 404 as HTML", async () => {
      const res = await get("/definitely-not-a-route-xyz", {}, "192.0.2.96");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
    });
  });

  describe("machine documentation", () => {
    it("publishes the 500 envelope and internal code in OpenAPI", async () => {
      const res = await get("/openapi.json", {}, "192.0.2.97");
      expect(res.status).toBe(200);
      const spec = (await res.json()) as ReturnType<typeof getOpenApiDocument>;
      type Responses = Record<
        string,
        { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }
      >;
      const paths = spec.paths as unknown as Record<string, { get?: { responses?: Responses } }>;
      for (const path of ["/api/public/events", "/api/public/events/{key}"]) {
        const responses = paths[path]?.get?.responses;
        expect(responses?.["500"]).toBeDefined();
        expect(responses?.["500"]?.description).toMatch(/try again/i);
        expect(responses?.["500"]?.content?.["application/json"]?.schema?.$ref).toBe(
          "#/components/schemas/PublicDataError",
        );
      }
      const schemas = spec.components as unknown as {
        schemas: {
          PublicDataError: {
            properties: { error: { properties: { code: { enum: string[] } } } };
          };
        };
      };
      expect(schemas.schemas.PublicDataError.properties.error.properties.code.enum).toContain(
        "internal",
      );
      expect(spec.info.description).toContain("internal");
    });

    it("documents the MCP JSON-RPC upload errors in the body-limits contract", () => {
      const doc = readFileSync(new URL("docs/body-limits.md", root), "utf8");
      expect(doc).toContain("jsonrpc");
      expect(doc).toContain(String(MCP_TRANSPORT_CODE));
      expect(doc).toMatch(/"id":\s*null/);
      expect(doc).toContain(MCP_413_MESSAGE);
    });
  });
});
