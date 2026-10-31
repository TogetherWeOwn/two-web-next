// route-inventory: POST /mcp
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventForm } from "../src/admin/validation";
import type { Env } from "../src/env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import type { PublicApiEventDto } from "../src/public-data/contracts";
import {
  EventByteCapExceededError,
  eventResultBytes,
  fitByteBudget,
} from "../src/public-data/routes";
import app from "./app";

vi.mock("../src/admin/db", () => ({ dbFor: async () => ({}) }));
vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listPublicApiEvents: vi.fn(),
  getPublicApiEvent: vi.fn(),
}));
vi.mock("../src/events/routes-shared", async (original) => ({
  ...(await original<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: async () => null,
}));

const ORIGIN = "https://next.example.test";
const CAP = 32768;
const key = (n: number) => String(n).padStart(26, "0");
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const list = vi.mocked(listPublicApiEvents);
const detail = vi.mocked(getPublicApiEvent);
const env = {
  APP_URL: ORIGIN,
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;

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

type Result = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
  _meta?: unknown;
};
function useRows(rows: PublicApiEvent[]) {
  list.mockResolvedValue({ rows, total: rows.length, page: 1 });
  detail.mockImplementation(async (_db, id) => rows.find((r) => r.eventKey === id) ?? null);
}
async function rest(path: string) {
  const response = await app.request(path, {}, env);
  return { response, text: await response.text() };
}
function payload(text: string, type: string | null) {
  return JSON.parse(
    type?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1)!
      : text,
  );
}
async function legacy(name: string, args: object): Promise<Result> {
  const response = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    env,
  );
  expect(response.status).toBe(200);
  return payload(await response.text(), response.headers.get("content-type")).result as Result;
}
async function modern(name: string, args: Record<string, unknown>) {
  const wires: { method: string; protocol: string | null; result: Result }[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${ORIGIN}/mcp`);
      const requestBody =
        request.method === "POST" ? ((await request.clone().json()) as { method: string }) : null;
      const response = await app.request(request, undefined, env);
      if (response.status === 200 && requestBody) {
        const text = await response.clone().text();
        const message = payload(text, response.headers.get("content-type"));
        if (message.result)
          wires.push({
            method: requestBody.method,
            protocol: request.headers.get("mcp-protocol-version"),
            result: message.result as Result,
          });
      }
      return response;
    },
  });
  const client = new Client(
    { name: "fixture-client", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(transport);
    const discovered = await client.listTools();
    expect(discovered.tools.map((tool) => tool.name)).toContain(name);
    await client.callTool({ name, arguments: args });
    expect(wires.some((wire) => wire.method === "server/discover")).toBe(true);
    const call = wires.find((wire) => wire.method === "tools/call")!;
    expect(call.protocol).toBe("2026-07-28");
    expect(call.result.resultType).toBe("complete");
    expect(call.result._meta).toEqual({
      "io.modelcontextprotocol/serverInfo": { name: "two-web-next", version: "1.0.0" },
    });
    return call.result;
  } finally {
    await client.close();
  }
}
function legacyProjection(dto: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(dto) }], structuredContent: dto };
}
function compare(result: Result, http: Awaited<ReturnType<typeof rest>>) {
  expect(result.isError).toBeUndefined();
  expect(http.response.status).toBe(200);
  expect(result.content[0]!.text).toBe(http.text);
  expect(result.structuredContent).toEqual(JSON.parse(http.text));
  expect(size(result)).toBeLessThanOrEqual(CAP);
  if (result.resultType === "complete") expect(eventResultBytes(http.text)).toBe(size(result));
}

describe("MCP emitted-result bytes and marked description minima", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
    list.mockReset();
    detail.mockReset();
    vi.stubGlobal("fetch", () => {
      throw new Error("network forbidden");
    });
  });
  afterEach(() => {
    __resetApiPublicCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the collection array identity and exact wrapper bytes through every fitting iteration", () => {
    const sources = Array.from({ length: 20 }, (_, i) =>
      row(i + 1, { description: "d".repeat(1000) }),
    );
    const cloned = collection(sources);
    const retained = collection(sources);
    let calls = 0;
    const expected = fitByteBudget(cloned.data, CAP, (trimmed) => ({ ...cloned, data: trimmed }));
    const actual = fitByteBudget(retained.data, CAP, (trimmed) => {
      calls++;
      expect(trimmed).toBe(retained.data);
      return retained;
    });
    expect(calls).toBeGreaterThan(1);
    expect(actual).toBe(expected);
    expect(eventResultBytes(actual)).toBeLessThanOrEqual(CAP);
    expect(retained.data).toHaveLength(20);
    expect(retained.data.some((item) => item.description?.endsWith("…"))).toBe(true);
    expect(retained.meta).toEqual(cloned.meta);
  });

  it("budgets actual negotiated modern list results and preserves legacy and REST parity on cold and warm reads", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, { description: "d".repeat(393) }));
    // Independently tune form-valid input to land at the legacy result boundary.
    const base = size(legacyProjection(collection(rows)));
    const count = Math.floor((CAP - base) / 2);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(500);
    rows[0]!.description += "d".repeat(count);
    expect(size(legacyProjection(collection(rows)))).toBeGreaterThanOrEqual(CAP - 1);
    expect(
      parseEventForm({
        title: rows[0]!.title,
        description: rows[0]!.description!,
        timezone: "UTC",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
      }).description,
    ).toBe(rows[0]!.description);
    useRows(rows);
    for (const first of ["REST", "MCP"]) {
      __resetApiPublicCacheForTests();
      const prior = first === "REST" ? await rest("/api/public/events") : undefined;
      const current = await modern("list_events", {});
      const http = prior ?? (await rest("/api/public/events"));
      compare(current, http);
      compare(await legacy("list_events", {}), http);
      compare(await modern("list_events", {}), await rest("/api/public/events"));
      const actual = JSON.parse(http.text);
      expect(actual.data.map((e: PublicApiEventDto) => e.event_key)).toEqual(
        rows.map((r) => r.eventKey),
      );
      expect({ ...actual, data: [] }).toEqual({ ...collection(rows), data: [] });
    }
  });

  it("terminates at a nonempty marker for one-code-point and existing ellipsis descriptions", () => {
    const dto = expectedEvent(row(1, { description: "🎮" }));
    const marker = { ...dto, description: "…" };
    const wrap = (rows: PublicApiEventDto[]) => rows[0];
    const floor = eventResultBytes(JSON.stringify(marker));
    expect(JSON.parse(fitByteBudget([dto], floor, wrap))).toEqual(marker);
    expect(() => fitByteBudget([{ ...marker }], floor - 1, wrap)).toThrow(
      EventByteCapExceededError,
    );
    expect(() => fitByteBudget([{ ...dto, description: null }], 1, wrap)).toThrow(
      EventByteCapExceededError,
    );
  });

  it("budgets actual modern detail result and preserves legacy/REST parity", async () => {
    const empty = row(1, { description: "" });
    const length = Math.floor((CAP - size(legacyProjection(expectedEvent(empty)))) / 2);
    const source = row(1, { description: "d".repeat(length) });
    expect(size(legacyProjection(expectedEvent(source)))).toBeGreaterThanOrEqual(CAP - 1);
    useRows([source]);
    for (const first of ["REST", "MCP"]) {
      __resetApiPublicCacheForTests();
      const path = `/api/public/events/${key(1)}`;
      const prior = first === "REST" ? await rest(path) : undefined;
      const current = await modern("get_event", { event_key: key(1) });
      const http = prior ?? (await rest(path));
      compare(current, http);
      compare(await legacy("get_event", { event_key: key(1) }), http);
      compare(await modern("get_event", { event_key: key(1) }), await rest(path));
      expect(JSON.parse(http.text).description).toMatch(/…$/u);
    }
  });

  it.each([206, 209])(
    "refuses an irreducible marked floor at location length %i without caching erased descriptions",
    async (locationLength) => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        row(i + 1, {
          title: "T".repeat(100),
          game: "G".repeat(100),
          location: "L".repeat(locationLength),
          description: "d".repeat(1000),
          goingCount: 0,
          goingOccupancy: 0,
        }),
      );
      const parsed = parseEventForm({
        title: rows[0]!.title,
        game: rows[0]!.game!,
        location: rows[0]!.location!,
        description: rows[0]!.description!,
        timezone: "UTC",
        starts_at: "2099-11-04 20:00",
        ends_at: "2099-11-04 22:00",
      });
      expect(parsed.location).toBe(rows[0]!.location);
      expect(parsed.description).toBe(rows[0]!.description);
      if (locationLength === 206) {
        const floor = (description: string) => ({
          ...collection(rows),
          data: rows.map((source) => ({
            ...expectedEvent(source),
            going_count: 0,
            going_occupancy: 0,
            description,
          })),
        });
        const projected = (description: string) => ({
          ...legacyProjection(floor(description)),
          resultType: "complete",
          _meta: {
            "io.modelcontextprotocol/serverInfo": { name: "two-web-next", version: "1.0.0" },
          },
        });
        // Only erasing markers can fit this floor: a distinct refusal case from
        // metadata that already overflows with every description empty.
        expect(size(projected(""))).toBeLessThanOrEqual(CAP);
        expect(size(projected("…"))).toBeGreaterThan(CAP);
      }
      useRows(rows);
      for (const first of ["REST", "MCP"]) {
        __resetApiPublicCacheForTests();
        for (let i = 0; i < 2; i++) {
          const prior = first === "REST" ? await rest("/api/public/events") : undefined;
          const result = await modern("list_events", {});
          const http = prior ?? (await rest("/api/public/events"));
          expect(http.response.status).toBe(503);
          expect(http.response.headers.get("cache-control")).toBe("no-store, private");
          expect(JSON.parse(http.text).error).toMatchObject({
            code: "unavailable",
            message: "Event data is temporarily unavailable.",
          });
          for (const failure of [result, await legacy("list_events", {})]) {
            expect(failure.isError).toBe(true);
            expect(failure.structuredContent).toBeUndefined();
            expect(size(failure)).toBeLessThanOrEqual(CAP);
            expect(JSON.parse(failure.content[0]!.text)).toEqual({
              error: { code: "unavailable", message: "Event data is temporarily unavailable." },
            });
          }
        }
      }
      useRows([row(1, { description: "recovered" })]);
      const recovered = await rest("/api/public/events");
      expect(recovered.response.status).toBe(200);
      expect(JSON.parse(recovered.text).data[0].description).toBe("recovered");
      compare(await modern("list_events", {}), recovered);
    },
  );

  it("keeps nonempty ellipses for fitting near-floor rows on cold and warm requests", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(i + 1, {
        title: "T".repeat(100),
        game: "G".repeat(100),
        location: "L".repeat(200),
        description: "d".repeat(1000),
        goingCount: 0,
        goingOccupancy: 0,
      }),
    );
    useRows(rows);
    for (const first of ["REST", "MCP"]) {
      __resetApiPublicCacheForTests();
      const prior = first === "REST" ? await rest("/api/public/events") : undefined;
      const current = await modern("list_events", {});
      const http = prior ?? (await rest("/api/public/events"));
      compare(current, http);
      compare(await legacy("list_events", {}), http);
      const data = JSON.parse(http.text).data as PublicApiEventDto[];
      expect(data).toHaveLength(20);
      for (const [i, event] of data.entries()) {
        expect(event.event_key).toBe(rows[i]!.eventKey);
        expect(event.description).toBeTruthy();
        if (event.description !== rows[i]!.description) expect(event.description).toMatch(/…$/u);
      }
      expect((await rest("/api/public/events")).text).toBe(http.text);
      compare(await modern("list_events", {}), http);
    }
  });
});
