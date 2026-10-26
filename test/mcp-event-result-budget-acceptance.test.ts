// route-inventory: POST /mcp
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// Test Author owned. The measured ceiling is the complete serialized tool result,
// not one DTO copy and not JSON-RPC/HTTP framing. Real app, MCP SDK transport,
// serializers and cache; only external event reads/admission are replaced.
// No database or network. Builder must not edit this acceptance file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventForm } from "../src/admin/validation";
import type { Env } from "../src/env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { PublicApiEventCollectionDto, PublicApiEventDto } from "../src/public-data/contracts";
import app from "./app";
import { validatePublicSchema } from "./helpers/public-api-schema";

vi.mock("../src/admin/db", () => ({ dbFor: async () => ({}) }));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  listPublicApiEvents: vi.fn(),
  getPublicApiEvent: vi.fn(),
}));
vi.mock("../src/events/routes-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: async () => null,
}));

const ORIGIN = "https://next.example.test";
const CAP = 32_768;
const key = (n: number) => String(n).padStart(26, "0");
const bytes = (text: string) => new TextEncoder().encode(text).length;
const serializedBytes = (value: unknown) => bytes(JSON.stringify(value));
const list = vi.mocked(listPublicApiEvents);
const detail = vi.mocked(getPublicApiEvent);
const env = {
  APP_URL: ORIGIN,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const UNAVAILABLE = {
  error: { code: "unavailable", message: "Event data is temporarily unavailable." },
};

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};
type RpcMessage = { jsonrpc: string; id: number | string; result: ToolResult; error?: unknown };
type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
};
type Tool = { name: string; annotations?: { readOnlyHint?: boolean }; outputSchema?: Schema };

// Complete reader row. Expected public metadata below is hand-specified, not
// generated with a production serializer or description fitter.
function row(n: number, over: Partial<PublicApiEvent> = {}): PublicApiEvent {
  return {
    id: n,
    eventKey: key(n),
    title: `Night ${n}`,
    game: null,
    description: null,
    accessibilityNotes: null,
    startsAt: new Date("2099-11-04T20:00:00Z"),
    endsAt: new Date("2099-11-04T22:00:00Z"),
    timezone: "UTC",
    location: null,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2099-01-01T00:00:00Z"),
    updatedAt: new Date("2099-01-01T00:00:00Z"),
    icsSequence: 0n,
    goingCount: null,
    goingOccupancy: null,
    ...over,
  };
}

function expectedEvent(source: PublicApiEvent): PublicApiEventDto {
  return {
    event_key: source.eventKey as PublicApiEventDto["event_key"],
    title: source.title,
    game: source.game,
    description: source.description,
    starts_at: "2099-11-04T20:00:00.000Z",
    ends_at: "2099-11-04T22:00:00.000Z",
    starts_at_local: "2099-11-04 20:00",
    ends_at_local: "2099-11-04 22:00",
    timezone: "UTC",
    location: source.location,
    capacity: source.capacity,
    going_count: null,
    going_occupancy: null,
    status: "published",
    rsvp_open: true,
    synced_to_discord: false,
  };
}

function collection(rows: PublicApiEvent[], total = rows.length, page = 1) {
  return {
    data: rows.map(expectedEvent),
    page,
    limit: 20,
    meta: {
      current_page: page,
      per_page: 20,
      total,
      last_page: Math.max(1, Math.ceil(total / 20)),
    },
  };
}

// Independent protocol shape, solely for demonstrating fixture pressure.
function resultFor(dto: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(dto) }], structuredContent: dto };
}

function useRows(rows: PublicApiEvent[], total = rows.length, page = 1) {
  list.mockResolvedValue({ rows, total, page });
  detail.mockImplementation(
    async (_db, eventKey) => rows.find((r) => r.eventKey === eventKey) ?? null,
  );
}

// Validate advertised required fields/types/unions rather than importing the
// production output validator. Canonical OpenAPI validation runs separately.
function schemaProblems(value: unknown, schema: Schema, path = "$"): string[] {
  if (schema.const !== undefined && value !== schema.const) return [`${path}: const`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: enum`];
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches)
    return branches.some((s) => schemaProblems(value, s).length === 0) ? [] : [`${path}: union`];
  const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    types.length &&
    !types.some((t) => t === actual || (t === "integer" && Number.isInteger(value)))
  ) {
    return [`${path}: type`];
  }
  if (Array.isArray(value) && schema.items)
    return value.flatMap((v, i) => schemaProblems(v, schema.items!, `${path}[${i}]`));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return [
      ...(schema.required ?? []).filter((k) => !(k in record)).map((k) => `${path}.${k}: missing`),
      ...Object.entries(schema.properties ?? {}).flatMap(([k, s]) =>
        k in record ? schemaProblems(record[k], s, `${path}.${k}`) : [],
      ),
    ];
  }
  return [];
}

async function rpc(method: string, params: unknown, id: number | string = 3) {
  const response = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const wire = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? wire
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1)!
    : wire;
  const message = JSON.parse(payload) as RpcMessage;
  expect(message.jsonrpc).toBe("2.0");
  expect(message.id).toBe(id);
  expect(message.error).toBeUndefined();
  expect(message.result).toBeDefined();
  return { message, payload, wire };
}

async function tools() {
  await rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "result-budget-test", version: "1" },
    },
    1,
  );
  // The endpoint is stateless, as in the existing transport tests.
  const called = await rpc("tools/list", {}, 2);
  return (called.message.result as unknown as { tools: Tool[] }).tools;
}

function success(called: Awaited<ReturnType<typeof rpc>>, schema: Schema, schemaName: string) {
  const result = called.message.result;
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe("text");
  expect(result.structuredContent).toBeDefined();
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  expect(schemaProblems(result.structuredContent, schema)).toEqual([]);
  expect(validatePublicSchema(result.structuredContent, schemaName)).toEqual([]);
  return result;
}

function descriptionsOnly(actual: PublicApiEventDto[], sources: PublicApiEvent[]) {
  expect(actual).toHaveLength(sources.length);
  for (const [i, source] of sources.entries()) {
    const { description, ...metadata } = actual[i]!;
    const { description: original, ...expected } = expectedEvent(source);
    expect(metadata).toEqual(expected);
    expect(description, `description ${i} is not discarded`).not.toBeNull();
    expect(description!.length).toBeGreaterThan(0);
    expect(description!, `description ${i} contains no lone surrogate`).not.toMatch(
      /[\uD800-\uDFFF]/u,
    );
    if (description !== original) {
      expect(description!.endsWith("…")).toBe(true);
      const prefix = description!.slice(0, -1);
      expect(original!.startsWith(prefix)).toBe(true);
      expect(prefix).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  }
}

async function rest(path: string) {
  const response = await app.request(path, {}, env);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) };
}

function toolError(result: ToolResult, code: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code } });
  expect(serializedBytes(result)).toBeLessThanOrEqual(CAP);
}

describe("event tool results: duplicated serialized byte budget (offline)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
    list.mockReset();
    detail.mockReset();
    vi.stubGlobal("fetch", () => {
      throw new Error("Network forbidden in result-budget acceptance");
    });
  });
  afterEach(() => {
    __resetApiPublicCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("CONTROL: keeps four read-only typed tools, small and empty results byte-equal to REST", async () => {
    const advertised = await tools();
    expect(advertised.map((t) => t.name).sort()).toEqual([
      "get_community",
      "get_event",
      "get_join",
      "list_events",
    ]);
    for (const tool of advertised) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.outputSchema?.required?.length).toBeGreaterThan(0);
    }
    for (const rows of [[], [row(1, { description: 'Small \\"🎮e\u0301 description' })]]) {
      __resetApiPublicCacheForTests();
      useRows(rows);
      const called = await rpc("tools/call", { name: "list_events", arguments: {} });
      const result = success(
        called,
        advertised.find((t) => t.name === "list_events")!.outputSchema!,
        "PublicApiEventCollection",
      );
      expect(result.structuredContent).toEqual(collection(rows));
      expect(serializedBytes(result)).toBeLessThanOrEqual(CAP);
      expect((await rest("/api/public/events")).text).toBe(result.content[0]!.text);
    }
  });

  it.each([
    ["ordinary", "d".repeat(1000)],
    ["quotes and backslashes", '"\\'.repeat(500)],
    ["astral and combining", "🎮e\u0301".repeat(333) + "🎮"],
  ])(
    "fits all 20 validator-admissible %s descriptions at the actual result boundary",
    async (_name, description) => {
      const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, { description }));
      const parsed = parseEventForm({
        title: rows[0]!.title,
        description,
        timezone: "UTC",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
      });
      expect(parsed.description).toBe(description);
      expect([...description]).toHaveLength(1000);
      expect(serializedBytes(resultFor(collection(rows, 41, 2)))).toBeGreaterThan(CAP);
      useRows(rows, 41, 2);
      const schema = (await tools()).find((t) => t.name === "list_events")!.outputSchema!;
      for (const first of ["REST", "MCP"] as const) {
        __resetApiPublicCacheForTests();
        const before =
          first === "REST" ? await rest("/api/public/events?per_page=20&page=2") : null;
        const called = await rpc("tools/call", {
          name: "list_events",
          arguments: { per_page: 20, page: 2 },
        });
        const result = success(called, schema, "PublicApiEventCollection");
        const body = result.structuredContent as PublicApiEventCollectionDto;
        descriptionsOnly(body.data, rows);
        expect({ ...body, data: [] }).toEqual({ ...collection(rows, 41, 2), data: [] });
        const mirrored = before ?? (await rest("/api/public/events?per_page=20&page=2"));
        expect(mirrored.response.status).toBe(200);
        expect(mirrored.text).toBe(result.content[0]!.text);
        expect(bytes(mirrored.text)).toBeLessThanOrEqual(CAP);
        // Soft so parity/shape controls above still diagnose an oversized success.
        expect
          .soft(serializedBytes(result), `${first} first: entire CallToolResult`)
          .toBeLessThanOrEqual(CAP);
        const replay = await rpc(
          "tools/call",
          { name: "list_events", arguments: { per_page: 20, page: 2 } },
          4,
        );
        expect(replay.message.result).toEqual(result);
        expect
          .soft(serializedBytes(replay.message.result), "cached MCP replay")
          .toBeLessThanOrEqual(CAP);
        const repeat = await rest("/api/public/events?per_page=20&page=2");
        expect(repeat.text).toBe(mirrored.text);
        const conditional = await app.request(
          "/api/public/events?per_page=20&page=2",
          { headers: { "if-none-match": repeat.response.headers.get("etag")! } },
          env,
        );
        expect(conditional.status).toBe(304);
        expect(await conditional.text()).toBe("");
      }
    },
  );

  it("get_event fits a long existing description, preserving metadata and REST parity on cold and warm reads", async () => {
    // Existing/legacy rows can exceed current form input caps, as in the
    // pre-existing byte-cap acceptance. The read must still bound its output.
    const source = row(1, {
      description: '🎮"\\e\u0301'.repeat(6000),
      game: "Chess",
      location: "Hall",
      capacity: 8,
    });
    expect(serializedBytes(resultFor(expectedEvent(source)))).toBeGreaterThan(CAP);
    useRows([source]);
    const schema = (await tools()).find((t) => t.name === "get_event")!.outputSchema!;
    for (const first of ["REST", "MCP"] as const) {
      __resetApiPublicCacheForTests();
      const prior = first === "REST" ? await rest(`/api/public/events/${key(1)}`) : null;
      const result = success(
        await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } }),
        schema,
        "PublicApiEvent",
      );
      descriptionsOnly([result.structuredContent as PublicApiEventDto], [source]);
      const mirrored = prior ?? (await rest(`/api/public/events/${key(1)}`));
      expect(mirrored.response.status).toBe(200);
      expect(mirrored.text).toBe(result.content[0]!.text);
      expect
        .soft(serializedBytes(result), `${first} first: get_event entire result`)
        .toBeLessThanOrEqual(CAP);
      expect(
        (await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } }, 4))
          .message.result,
      ).toEqual(result);
    }
  });

  it("refuses metadata that fits one DTO but cannot fit the duplicated result; never poisons a success cache", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(i + 1, { title: "T".repeat(100), game: "G".repeat(100), location: "L".repeat(255) }),
    );
    const parsed = parseEventForm({
      title: rows[0]!.title,
      game: rows[0]!.game!,
      location: rows[0]!.location!,
      timezone: "UTC",
      starts_at: "2099-11-04 20:00",
      ends_at: "2099-11-04 22:00",
    });
    expect(parsed.title).toBe(rows[0]!.title);
    expect(parsed.game).toBe(rows[0]!.game);
    expect(parsed.location).toBe(rows[0]!.location);
    expect(serializedBytes(collection(rows))).toBeLessThan(CAP);
    expect(serializedBytes(resultFor(collection(rows)))).toBeGreaterThan(CAP);
    useRows(rows);
    for (let repeat = 0; repeat < 2; repeat++) {
      const http = await rest("/api/public/events");
      expect
        .soft(http.response.status, "irreducible duplicate metadata is REST unavailable too")
        .toBe(503);
      expect.soft(http.response.headers.get("cache-control")).toBe("no-store, private");
      const called = await rpc("tools/call", { name: "list_events", arguments: {} });
      expect.soft(called.message.result.isError, "irreducible MCP success forbidden").toBe(true);
      if (called.message.result.isError) {
        toolError(called.message.result, "unavailable");
        expect(JSON.parse(called.message.result.content[0]!.text)).toEqual(UNAVAILABLE);
        expect(http.body).toEqual({
          error: {
            ...UNAVAILABLE.error,
            request_id: expect.any(String),
            next: "Retry the read shortly.",
          },
        });
      }
    }
    // Change only the external data, not cache state: a cached oversized success
    // or cached refusal must not hide a recovered small response.
    useRows([row(1)]);
    const recovered = await rest("/api/public/events");
    expect(recovered.response.status).toBe(200);
    expect.soft(recovered.body).toEqual(collection([row(1)]));
    const result = (await rpc("tools/call", { name: "list_events", arguments: {} })).message.result;
    expect.soft(result.structuredContent).toEqual(collection([row(1)]));
  });

  it("CONTROL: irreducible detail overflow and reader exceptions keep static errors without sensitive echoes", async () => {
    useRows([row(1, { title: "Private source detail ".repeat(CAP) })]);
    const oversized = await rest(`/api/public/events/${key(1)}`);
    expect(oversized.response.status).toBe(503);
    expect(oversized.response.headers.get("cache-control")).toBe("no-store, private");
    const called = await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } });
    toolError(called.message.result, "unavailable");
    expect(JSON.parse(called.message.result.content[0]!.text)).toEqual(UNAVAILABLE);
    expect(JSON.stringify(called.message)).not.toContain("Private source detail");
    __resetApiPublicCacheForTests();
    list.mockRejectedValue(new Error("PRIVATE event storage exception"));
    const failure = await rpc("tools/call", { name: "list_events", arguments: {} });
    toolError(failure.message.result, "internal");
    expect(JSON.parse(failure.message.result.content[0]!.text)).toEqual({
      error: { code: "internal", message: expect.any(String) },
    });
    expect(JSON.stringify(failure.message)).not.toContain("PRIVATE");
  });

  it("CONTROL: single-event and unknown-key contracts remain typed success or not_found", async () => {
    const source = row(1, { description: "🎮".repeat(1000) });
    useRows([source]);
    const schema = (await tools()).find((t) => t.name === "get_event")!.outputSchema!;
    const result = success(
      await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } }),
      schema,
      "PublicApiEvent",
    );
    expect(result.structuredContent).toEqual(expectedEvent(source));
    expect(serializedBytes(result)).toBeLessThan(CAP);
    expect((await rest(`/api/public/events/${key(1)}`)).text).toBe(result.content[0]!.text);
    toolError(
      (await rpc("tools/call", { name: "get_event", arguments: { event_key: key(2) } })).message
        .result,
      "not_found",
    );
  });

  it("preserves a fitting near-ceiling detail and trims the first overflowing code point", async () => {
    // Derive only the fixture size from an independent literal protocol shape,
    // never from the production budget constant or description-fitting code.
    const empty = row(1, { description: "" });
    const overhead = serializedBytes(resultFor(expectedEvent(empty)));
    const length = Math.floor((CAP - overhead) / 2);
    const source = row(1, { description: "d".repeat(length) });
    const fittingBytes = serializedBytes(resultFor(expectedEvent(source)));
    expect(fittingBytes).toBeGreaterThanOrEqual(CAP - 1);
    expect(fittingBytes).toBeLessThanOrEqual(CAP);
    const schema = (await tools()).find((t) => t.name === "get_event")!.outputSchema!;
    for (const extra of [0, 1]) {
      __resetApiPublicCacheForTests();
      const current = { ...source, description: source.description! + "d".repeat(extra) };
      useRows([current]);
      const result = success(
        await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } }),
        schema,
        "PublicApiEvent",
      );
      descriptionsOnly([result.structuredContent as PublicApiEventDto], [current]);
      if (extra === 0) expect(result.structuredContent).toEqual(expectedEvent(current));
      else
        expect((result.structuredContent as PublicApiEventDto).description!.endsWith("…")).toBe(
          true,
        );
      expect((await rest(`/api/public/events/${key(1)}`)).text).toBe(result.content[0]!.text);
      expect.soft(serializedBytes(result), `boundary +${extra}`).toBeLessThanOrEqual(CAP);
    }
  });

  it("refuses a legacy detail whose metadata alone overflows only after typed duplication", async () => {
    const source = row(1, { title: "M".repeat(16_000) });
    expect(serializedBytes(expectedEvent(source))).toBeLessThan(CAP);
    expect(serializedBytes(resultFor(expectedEvent(source)))).toBeGreaterThan(CAP);
    useRows([source]);
    for (let repeat = 0; repeat < 2; repeat++) {
      const http = await rest(`/api/public/events/${key(1)}`);
      expect.soft(http.response.status).toBe(503);
      expect.soft(http.response.headers.get("cache-control")).toBe("no-store, private");
      const result = (
        await rpc("tools/call", { name: "get_event", arguments: { event_key: key(1) } })
      ).message.result;
      expect.soft(result.isError).toBe(true);
      if (result.isError) {
        toolError(result, "unavailable");
        expect(JSON.parse(result.content[0]!.text)).toEqual(UNAVAILABLE);
      }
    }
  });

  it("CONTROL: actual JSON-RPC request-id serialization is outside the result ceiling", async () => {
    // Ordinary admitted input, deliberately near the result boundary. Both IDs
    // are legal and bounded fixture controls, not a new client request-ID policy.
    const source = row(1, { description: "d".repeat(14_500) });
    useRows([source]);
    const short = await rpc(
      "tools/call",
      { name: "get_event", arguments: { event_key: key(1) } },
      7,
    );
    const longId = '"\\🎮'.repeat(1024);
    const long = await rpc(
      "tools/call",
      { name: "get_event", arguments: { event_key: key(1) } },
      longId,
    );
    expect(short.message.result).toEqual(long.message.result);
    expect(serializedBytes(long.message.result)).toBeLessThanOrEqual(CAP);
    // Observe the application's real transport bytes, not a hand-built wrapper.
    expect(bytes(long.payload)).toBeGreaterThan(CAP);
    expect(bytes(long.payload) - bytes(short.payload)).toBe(
      serializedBytes(longId) - serializedBytes(7),
    );
    expect(bytes(long.wire)).toBeGreaterThanOrEqual(bytes(long.payload));
    expect(long.message.id).toBe(longId);
  });
});
