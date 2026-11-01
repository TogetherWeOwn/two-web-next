// route-inventory: POST /mcp
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// The 32 KiB event budget is measured on the whole serialized MCP tool
// result, not on one DTO copy: the result carries the DTO twice (escaped text
// plus structuredContent) and newer protocols add SDK metadata. Real app, MCP
// transport, serializers and cache; only the event reads and admission are
// replaced, so no database or network. Adapted from the acceptance test in
// #1935.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import {
  API_PUBLIC_BOUNDS,
  type PublicApiEventCollectionDto,
  type PublicApiEventDto,
} from "../src/public-data/contracts";
import {
  eventResultBytes,
  fitByteBudget,
  getEventTrimmedNotice,
  LIST_EVENTS_TRIMMED_NOTICE,
} from "../src/public-data/routes";
import app from "./app";

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

const CAP = API_PUBLIC_BOUNDS.maxBodyBytes;
const PROTOCOLS = ["2025-06-18", "2026-07-28"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const key = (n: number) => String(n).padStart(26, "0");
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const list = vi.mocked(listPublicApiEvents);
const detail = vi.mocked(getPublicApiEvent);

// Quotes, backslashes and newlines escape to two bytes in the text copy, so
// they inflate the result well past a single DTO copy.
const ESCAPED = 'Bring "snacks" \\ a chair.\n'.repeat(160);

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

function row(n: number, description: string | null): PublicApiEvent {
  return {
    id: n,
    eventKey: key(n),
    title: `Night ${n}`,
    game: null,
    description,
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
  };
}

function useRows(rows: PublicApiEvent[]) {
  list.mockResolvedValue({ rows, total: rows.length, page: 1 });
  detail.mockImplementation(
    async (_db, eventKey) => rows.find((r) => r.eventKey === eventKey) ?? null,
  );
}

async function callTool(protocol: Protocol, name: string, args: Record<string, unknown>) {
  const meta =
    protocol === "2026-07-28"
      ? {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocol,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "result-budget-test", version: "1" },
          },
        }
      : {};
  const response = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol,
        ...(protocol === "2026-07-28" ? { "mcp-method": "tools/call", "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name, arguments: args, ...meta },
      }),
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
  const message = JSON.parse(payload) as { result: ToolResult; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result;
}

// A trimmed result carries the notice as a second text block, inside the cap.
function expectFittedSuccess(result: ToolResult, notice?: string) {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(notice === undefined ? 1 : 2);
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  if (notice !== undefined) expect(result.content[1]).toEqual({ type: "text", text: notice });
  expect(bytes(result), "whole serialized tool result").toBeLessThanOrEqual(CAP);
}

function expectTrimmed(actual: PublicApiEventDto, original: string) {
  expect(actual.description!.endsWith("…")).toBe(true);
  expect(original.startsWith(actual.description!.slice(0, -1))).toBe(true);
}

describe("MCP event results fit the budget at the serialized tool-result boundary", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
    list.mockReset();
    detail.mockReset();
  });
  afterEach(() => __resetApiPublicCacheForTests());

  it("eventResultBytes counts both copies, escaping and SDK metadata", () => {
    const body = JSON.stringify({ description: ESCAPED });
    const text = JSON.stringify(body);
    expect(eventResultBytes(body)).toBeGreaterThan(body.length + text.length);
    // The measure is exactly the newest protocol's result shape.
    expect(eventResultBytes(body)).toBe(
      bytes({
        content: [{ type: "text", text: body }],
        structuredContent: JSON.parse(body),
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "two-web-next", version: "1.0.0" } },
      }),
    );
    expect(eventResultBytes(body, "Shortened.")).toBe(
      eventResultBytes(body) + bytes({ type: "text", text: "Shortened." }) + 1,
    );
  });

  it("the notices say the text was shortened and how to read more", () => {
    expect(LIST_EVENTS_TRIMMED_NOTICE).toContain("shortened");
    expect(LIST_EVENTS_TRIMMED_NOTICE).toContain("per_page");
    expect(LIST_EVENTS_TRIMMED_NOTICE).toContain("meta.last_page");
    expect(LIST_EVENTS_TRIMMED_NOTICE).toContain("get_event");
    expect(getEventTrimmedNotice(key(7))).toContain(`/e/${key(7)}`);
  });

  it("an untrimmed result carries no notice", async () => {
    useRows([row(5, "A short night.")]);
    const listed = await callTool("2025-06-18", "list_events", { page: 1, per_page: 20 });
    expectFittedSuccess(listed);
    const one = await callTool("2025-06-18", "get_event", { event_key: key(5) });
    expectFittedSuccess(one);
    expect((one.structuredContent as PublicApiEventDto).description).toBe("A short night.");
  });

  it("fitByteBudget keeps a result exactly at the cap and trims one byte over", () => {
    const dto = () => [{ event_key: key(1), description: ESCAPED } as PublicApiEventDto];
    const wrap = (rows: PublicApiEventDto[]) => ({ data: rows });
    const exact = eventResultBytes(JSON.stringify(wrap(dto())));

    // An untrimmed result carries no notice, so it fits at exactly the cap.
    const atCap = fitByteBudget(dto(), exact, wrap, LIST_EVENTS_TRIMMED_NOTICE);
    expect(atCap.trimmed).toBe(false);
    expect(eventResultBytes(atCap.body)).toBe(exact);
    expect(JSON.parse(atCap.body).data[0].description).toBe(ESCAPED);

    // One byte over trims, and the trimmed body fits with its notice counted.
    const oneOver = fitByteBudget(dto(), exact - 1, wrap, LIST_EVENTS_TRIMMED_NOTICE);
    expect(oneOver.trimmed).toBe(true);
    expect(eventResultBytes(oneOver.body, LIST_EVENTS_TRIMMED_NOTICE)).toBeLessThanOrEqual(
      exact - 1,
    );
    expect(JSON.parse(oneOver.body).data[0].description.endsWith("…")).toBe(true);
  });

  for (const protocol of PROTOCOLS) {
    it(`list_events trims an oversized page so the ${protocol} result fits 32 KiB`, async () => {
      const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, ESCAPED));
      useRows(rows);
      // One DTO copy alone is over the cap, so the old body-only measure could
      // never have bounded the doubled result either.
      expect(rows.length * ESCAPED.length).toBeGreaterThan(CAP);
      const result = await callTool(protocol, "list_events", { page: 1, per_page: 20 });
      expectFittedSuccess(result, LIST_EVENTS_TRIMMED_NOTICE);
      const structured = result.structuredContent as PublicApiEventCollectionDto;
      expect(structured.data.map((r) => r.event_key)).toEqual(rows.map((r) => r.eventKey));
      for (const dto of structured.data) expectTrimmed(dto, ESCAPED);
    });

    it(`get_event trims an oversized description so the ${protocol} result fits 32 KiB`, async () => {
      const original = ESCAPED.repeat(10);
      useRows([row(7, original)]);
      const result = await callTool(protocol, "get_event", { event_key: key(7) });
      expectFittedSuccess(result, getEventTrimmedNotice(key(7)));
      expectTrimmed(result.structuredContent as PublicApiEventDto, original);
    });
  }

  it("a body near the cap fits as REST but is trimmed for the MCP result", async () => {
    // ~24 KiB of DTO: under 32 KiB as one copy, over it once doubled.
    const original = "D".repeat(24_000);
    useRows([row(9, original)]);
    const result = await callTool("2025-06-18", "get_event", { event_key: key(9) });
    expectFittedSuccess(result, getEventTrimmedNotice(key(9)));
    expectTrimmed(result.structuredContent as PublicApiEventDto, original);
  });

  it("REST serves the same fitted bytes as the MCP structured result, without the notice", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, ESCAPED));
    useRows(rows);
    const result = await callTool("2025-06-18", "list_events", { page: 1, per_page: 20 });
    __resetApiPublicCacheForTests();
    const rest = await app.request("/api/public/events?per_page=20&page=1", {}, env);
    expect(rest.status).toBe(200);
    const text = await rest.text();
    expect(text).toBe(result.content[0]!.text);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(CAP);
  });
});
