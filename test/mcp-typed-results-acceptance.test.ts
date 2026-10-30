// route-inventory: POST /mcp
// route-inventory: GET /llms.txt
// route-inventory: GET /openapi.json
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// C4 acceptance (Test Author owned, failing-first): MCP tools advertise a
// typed output schema for every successful result through tools/list, and
// /llms.txt discovers the read-only machine surface (/mcp, /openapi.json and
// one short repo machine-interface guide). The Builder implements against
// this file and never edits it; follow-up test corrections return to the
// acceptance card. Real app + agent-testdb/CI Postgres for the tools suite;
// the discovery suite is DB-free.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { llmsTxt, MARKDOWN_MIME } from "../src/ai-friendly/md";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { MCP_TOOL_NAMES } from "../src/mcp/server";
import {
  API_PUBLIC_BOUNDS,
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
  type CommunitySnapshotDto,
  type JoinHandoffDto,
  type PublicApiEventCollectionDto,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/test-invite-handoff";
/** The one short repo machine-interface guide /llms.txt points agents at. */
const GUIDE_PATH = "docs/machine-interface.md";
/** The guide's runnable offline contract check (a package.json script). */
const CONTRACT_CHECK = "npm run check:machine-contract";

// All-digit 26-char keys, same shape as the mcp-public pins, so no secret
// scanner trips.
const key = (n: number) => String(n).padStart(26, "0");

const guideFile = () => fileURLToPath(new URL(`../${GUIDE_PATH}`, import.meta.url));

const readGuide = (): string => {
  expect(existsSync(guideFile()), `${GUIDE_PATH} must exist: /llms.txt points agents at it`).toBe(
    true,
  );
  return readFileSync(guideFile(), "utf8");
};

/** Absolute same-origin link paths advertised in a discovery body. */
const appPaths = (body: string): string[] =>
  [...body.matchAll(/https?:\/\/[^\s)>\]"']+/g)]
    .map((match) => match[0].replace(/[.,;:]+$/, ""))
    .filter((link) => link.startsWith(`${APP_URL}/`))
    .map((link) => link.slice(APP_URL.length));

const guideMentions = (body: string): string[] => [
  ...new Set([...body.matchAll(/(?<![\w/.])docs\/[a-z0-9-]+\.md/g)].map((match) => match[0])),
];

const staticEnv = () =>
  ({
    APP_URL,
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  }) as unknown as Env;

describe("C4 discovery: /llms.txt and the machine-interface guide (DB-free)", () => {
  it("llms.txt links the canonical /mcp and /openapi.json discovery URLs", () => {
    const body = llmsTxt(APP_URL);
    expect(body).toContain(`${APP_URL}/mcp`);
    expect(body).toContain(`${APP_URL}/openapi.json`);
  });

  it("llms.txt names the read-only remote tools and keeps sign-in and joining in the browser", () => {
    const body = llmsTxt(APP_URL);
    for (const name of MCP_TOOL_NAMES) expect(body).toContain(name);
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/browser/i);
    expect(body).not.toContain("no remote tools");
  });

  it("llms.txt advertises no training permission, member directory or auth/write surface", () => {
    const body = llmsTxt(APP_URL);
    expect(body).not.toMatch(/training/i);
    expect(body).not.toMatch(/member directory/i);
    for (const path of appPaths(body)) {
      expect(path, `discovery link ${path}`).not.toMatch(
        /oauth|authorize|\/token|login|session|admin/i,
      );
    }
  });

  it("llms.txt points to one short machine-interface guide with codes, limits and next actions", () => {
    const body = llmsTxt(APP_URL);
    expect(guideMentions(body)).toEqual([GUIDE_PATH]);
    const guide = readGuide();
    for (const code of [
      "invalid_request",
      "not_found",
      "rate_limited",
      "unavailable",
      "internal",
    ]) {
      expect(guide).toContain(code);
    }
    expect(guide).toMatch(/20\s+rows/);
    expect(guide).toContain("32 KiB");
    expect(guide).toMatch(/retry-after/i);
    expect(guide).toMatch(/try again/i);
    expect(guide).toContain("/mcp");
    expect(guide).toContain("/openapi.json");
    expect(guide).toContain(CONTRACT_CHECK);
    expect(guide.split("\n").length, "guide stays short").toBeLessThanOrEqual(120);
  });

  it("the guide names a runnable offline contract check", () => {
    expect(readGuide()).toContain(CONTRACT_CHECK);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts, "package.json must define the guide's contract check").toHaveProperty(
      "check:machine-contract",
    );
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (
        name === "DATABASE_URL" ||
        name.startsWith("PG") ||
        name.startsWith("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_")
      ) {
        delete env[name];
      }
    }
    const run = spawnSync("npm", ["run", "check:machine-contract"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      timeout: 25_000,
      encoding: "utf8",
    });
    expect(run.error, "contract check must run offline").toBeUndefined();
    expect(
      run.status,
      `contract check failed offline:\n${run.stdout?.slice(-2000)}\n${run.stderr?.slice(-2000)}`,
    ).toBe(0);
  });

  it("every machine discovery link resolves locally", async () => {
    const llms = await app.request("/llms.txt", {}, staticEnv());
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toBe(MARKDOWN_MIME);
    const body = await llms.text();
    expect(body).toContain(`${APP_URL}/mcp`);
    const spec = await app.request("/openapi.json", {}, staticEnv());
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    for (const path of [
      "/api/public/events",
      "/api/public/events/{key}",
      "/api/public/community",
      "/api/public/join",
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
    for (const mention of guideMentions(body)) {
      expect(
        existsSync(fileURLToPath(new URL(`../${mention}`, import.meta.url))),
        `${mention} resolves to a repo file`,
      ).toBe(true);
    }
  });
});

type JsonSchemaLike = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
};

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * Minimal conformance check against an advertised output schema: the same
 * subset test/helpers/public-api-schema.ts covers (type, required,
 * properties, items, enum) plus the const/anyOf/oneOf spellings zod emits,
 * so the assertion pins the contract, not the derivation. Unknown keywords
 * ($schema, formats, descriptions, bounds, additionalProperties) are ignored.
 */
function validateAdvertised(value: unknown, schema: JsonSchemaLike, path = "$"): string[] {
  const problems: string[] = [];
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const))
      problems.push(`${path} is not the const`);
    return problems;
  }
  if (schema.enum) {
    if (!schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
      problems.push(`${path} not in enum`);
    return problems;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (branches) {
      if (!branches.some((branch) => validateAdvertised(value, branch, path).length === 0))
        problems.push(`${path} matches no ${key} branch`);
      return problems;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    problems.push(`${path} is not ${types.join("|")}`);
    return problems;
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if ((types.includes("object") || (!schema.type && schema.properties)) && isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${path}.${name} is missing`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in value)
        problems.push(...validateAdvertised(value[name], property, `${path}.${name}`));
    }
  }
  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      problems.push(...validateAdvertised(item, schema.items!, `${path}[${index}]`)),
    );
  }
  return problems;
}

/** A property accepts null through a type array or a union branch. */
const allowsNull = (schema: JsonSchemaLike | undefined): boolean => {
  if (!schema) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("null")) return true;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(allowsNull);
};

type RpcResponse = {
  status: number;
  headers: Headers;
  messages: Record<string, unknown>[];
};

type ListedTool = {
  name: string;
  annotations?: Record<string, unknown>;
  outputSchema?: JsonSchemaLike;
};

describe.skipIf(!process.env.DATABASE_URL)("C4 typed results: advertised output schemas", () => {
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
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
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
    ip = "192.0.2.91",
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

  const initialize = () =>
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-typed-results-acceptance", version: "0" },
      },
    });

  const notifyInitialized = () => post({ jsonrpc: "2.0", method: "notifications/initialized" });

  const callTool = (name: string, args: Record<string, unknown>, id: number | string = 3) =>
    post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  const listTools = async (): Promise<ListedTool[]> => {
    await initialize();
    await notifyInitialized();
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.status).toBe(200);
    return (listed.messages[0]!["result"] as Record<string, unknown>)["tools"] as ListedTool[];
  };

  const outputSchemaFor = (tools: ListedTool[], name: string): JsonSchemaLike => {
    const tool = tools.find((entry) => entry.name === name);
    expect(tool, `tools/list must advertise ${name}`).toBeDefined();
    expect(tool!.outputSchema, `tools/list must advertise outputSchema for ${name}`).toBeDefined();
    return tool!.outputSchema!;
  };

  const toolResult = (called: RpcResponse): Record<string, unknown> => {
    expect(called.status).toBe(200);
    return called.messages[0]!["result"] as Record<string, unknown>;
  };

  const sorted = (fields: readonly string[] | undefined): string[] => [...(fields ?? [])].sort();

  it("tools/list advertises a nonempty output schema per tool and keeps the read-only allowlist", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations?.["readOnlyHint"], tool.name).toBe(true);
      const schema = outputSchemaFor(tools, tool.name);
      expect(schema.type, tool.name).toBe("object");
      expect(Object.keys(schema.properties ?? {}), tool.name).not.toHaveLength(0);
      expect(schema.required ?? [], tool.name).not.toHaveLength(0);
    }
  });

  it("advertised schemas match the canonical OpenAPI contract, not a second field list", async () => {
    const tools = await listTools();
    const components = getOpenApiDocument(APP_URL).components.schemas as unknown as Record<
      string,
      JsonSchemaLike
    >;
    const listSchema = outputSchemaFor(tools, "list_events");
    expect(sorted(listSchema.required)).toEqual(
      sorted(components.PublicApiEventCollection?.required),
    );
    expect(sorted(listSchema.required)).toEqual(["data", "limit", "meta", "page"]);
    expect(sorted(listSchema.properties?.["data"]?.items?.required)).toEqual(
      sorted([...PUBLIC_API_EVENT_FIELDS]),
    );
    expect(sorted(listSchema.properties?.["meta"]?.required)).toEqual([
      "current_page",
      "last_page",
      "per_page",
      "total",
    ]);
    const eventSchema = outputSchemaFor(tools, "get_event");
    expect(sorted(eventSchema.required)).toEqual(sorted([...PUBLIC_API_EVENT_FIELDS]));
    expect(sorted(eventSchema.required)).toEqual(sorted(components.PublicApiEvent?.required));
    const communitySchema = outputSchemaFor(tools, "get_community");
    expect(sorted(communitySchema.required)).toEqual(sorted([...COMMUNITY_SNAPSHOT_FIELDS]));
    expect(sorted(communitySchema.required)).toEqual(
      sorted(components.CommunitySnapshot?.required),
    );
    const joinSchema = outputSchemaFor(tools, "get_join");
    expect(sorted(joinSchema.required)).toEqual(sorted([...JOIN_HANDOFF_FIELDS]));
    expect(sorted(joinSchema.required)).toEqual(sorted(components.JoinHandoff?.required));
    // Unknown counts read as null, never 0 by default.
    for (const field of [
      "going_count",
      "going_occupancy",
      "game",
      "description",
      "location",
      "capacity",
    ]) {
      expect(allowsNull(eventSchema.properties?.[field]), `get_event.${field}`).toBe(true);
    }
    for (const field of ["member_count", "online_count"]) {
      expect(allowsNull(communitySchema.properties?.[field]), `get_community.${field}`).toBe(true);
    }
    // Published-only rows: the status pins the one public status.
    const statusSchema = eventSchema.properties?.["status"];
    expect(
      statusSchema?.enum?.includes("published") || statusSchema?.const === "published",
      "get_event.status pins published",
    ).toBe(true);
  });

  it("list_events results validate, stay published-only and equal REST bytes", async () => {
    await seed(44);
    await seed(45, { status: "draft", title: "Hidden draft" });
    await seed(46, { status: "cancelled", title: "Hidden cancelled" });
    const schema = outputSchemaFor(await listTools(), "list_events");
    const result = toolResult(await callTool("list_events", { per_page: 20, page: 1 }));
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data.map((row) => row.event_key)).toEqual([key(44)]);
    expect(validateAdvertised(structured, schema)).toEqual([]);
    const rest = await app.request(
      "/api/public/events?per_page=20&page=1",
      { headers: { "cf-connecting-ip": "192.0.2.92" } },
      env,
    );
    expect(structured).toEqual(await rest.json());
  });

  it("list_events paging results validate and equal REST bytes", async () => {
    await seed(1);
    await seed(2);
    await seed(3);
    const schema = outputSchemaFor(await listTools(), "list_events");
    const result = toolResult(await callTool("list_events", { per_page: 1, page: 2 }));
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data.map((row) => row.event_key)).toEqual([key(2)]);
    expect(structured.page).toBe(2);
    expect(structured.limit).toBe(1);
    expect(structured.meta).toEqual({ current_page: 2, per_page: 1, total: 3, last_page: 3 });
    expect(validateAdvertised(structured, schema)).toEqual([]);
    const rest = await app.request(
      "/api/public/events?per_page=1&page=2",
      { headers: { "cf-connecting-ip": "192.0.2.93" } },
      env,
    );
    expect(structured).toEqual(await rest.json());
  });

  it("list_events empty results validate and equal REST bytes", async () => {
    const schema = outputSchemaFor(await listTools(), "list_events");
    const result = toolResult(await callTool("list_events", { per_page: 20, page: 1 }));
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data).toEqual([]);
    expect(structured.meta.total).toBe(0);
    expect(validateAdvertised(structured, schema)).toEqual([]);
    const rest = await app.request(
      "/api/public/events?per_page=20&page=1",
      { headers: { "cf-connecting-ip": "192.0.2.94" } },
      env,
    );
    expect(structured).toEqual(await rest.json());
  });

  it("list_events truncation keeps rows, fits 32 KiB and validates", async () => {
    await seed(7, { description: "D".repeat(40_000) });
    const schema = outputSchemaFor(await listTools(), "list_events");
    const result = toolResult(await callTool("list_events", { per_page: 20, page: 1 }));
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as PublicApiEventCollectionDto;
    expect(structured.data).toHaveLength(1);
    expect(structured.data[0]!.description!.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(structured)).length).toBeLessThanOrEqual(
      API_PUBLIC_BOUNDS.maxBodyBytes,
    );
    expect(validateAdvertised(structured, schema)).toEqual([]);
  });

  it("get_event results validate and equal REST bytes; failures keep isError with no success content", async () => {
    await seed(11, { game: null, description: null, location: null, capacity: null });
    const schema = outputSchemaFor(await listTools(), "get_event");
    const result = toolResult(await callTool("get_event", { event_key: key(11) }));
    expect(result["isError"]).toBeUndefined();
    const structured = result["structuredContent"] as Record<string, unknown>;
    expect(structured["event_key"]).toBe(key(11));
    expect(validateAdvertised(structured, schema)).toEqual([]);
    const rest = await app.request(
      `/api/public/events/${key(11)}`,
      { headers: { "cf-connecting-ip": "192.0.2.95" } },
      env,
    );
    expect(structured).toEqual(await rest.json());
    // Unknown keys keep the failure shape: isError, no success content.
    const missing = toolResult(await callTool("get_event", { event_key: key(12) }, 4));
    expect(missing["isError"]).toBe(true);
    expect(missing["structuredContent"]).toBeUndefined();
    const missingText = (missing["content"] as { text: string }[])[0]!.text;
    expect(JSON.parse(missingText)).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
    // U is outside Crockford base32: rejected keys never reflect or validate as successes.
    const bad = toolResult(
      await callTool("get_event", { event_key: "01u00000000000000000000001" }, 5),
    );
    expect(bad["isError"]).toBe(true);
    expect(bad["structuredContent"]).toBeUndefined();
    const badText = (bad["content"] as { text: string }[])[0]!.text;
    expect(JSON.parse(badText)).toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });
    expect(badText).not.toContain("01u000");
  });

  it("community and join results validate with nulls and equal REST bytes", async () => {
    const tools = await listTools();
    const communityResult = toolResult(await callTool("get_community", {}, 6));
    expect(communityResult["isError"]).toBeUndefined();
    const snapshot = communityResult["structuredContent"] as CommunitySnapshotDto;
    expect(snapshot.member_count).toBeNull();
    expect(validateAdvertised(snapshot, outputSchemaFor(tools, "get_community"))).toEqual([]);
    const communityRest = await app.request(
      "/api/public/community",
      { headers: { "cf-connecting-ip": "192.0.2.96" } },
      env,
    );
    expect(snapshot).toEqual(await communityRest.json());
    const joinResult = toolResult(await callTool("get_join", {}, 7));
    expect(joinResult["isError"]).toBeUndefined();
    const handoff = joinResult["structuredContent"] as JoinHandoffDto;
    expect(handoff.invite_url).toBe(INVITE_URL);
    expect(validateAdvertised(handoff, outputSchemaFor(tools, "get_join"))).toEqual([]);
    const joinRest = await app.request(
      "/api/public/join",
      { headers: { "cf-connecting-ip": "192.0.2.97" } },
      env,
    );
    expect(handoff).toEqual(await joinRest.json());
  });

  it("keeps no prompts, resources or hidden tools", async () => {
    await initialize();
    await notifyInitialized();
    const prompts = await post({ jsonrpc: "2.0", id: 10, method: "prompts/list" });
    expect((prompts.messages[0]!["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(prompts.messages[0]).not.toHaveProperty("result");
    const resources = await post({ jsonrpc: "2.0", id: 11, method: "resources/list" });
    expect((resources.messages[0]!["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    expect(resources.messages[0]).not.toHaveProperty("result");
  });
});
