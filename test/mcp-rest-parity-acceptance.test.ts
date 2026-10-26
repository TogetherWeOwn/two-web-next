// route-inventory: POST /mcp
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// Acceptance: MCP reaches REST parity on the machine surfaces (Test Author,
// failing-first). The Builder implements against this file; nothing here may
// change to make an implementation pass. No source file changes on this card.
//
// The build card's criteria, pinned blind to the implementation:
//
// (A) MCP `list_events` gains an optional `game` input advertised in
// tools/list with exact-match semantics; absent is byte-identical to today.
// Present mirrors REST exactly (trim, case-insensitive exact; present-blank/
// oversized/control/unknown answer the canonical empty collection, never
// unfiltered, never a 422-shaped tool error) — validated in-handler, not via
// a Zod max that would change the error shape, and sharing the REST parse
// rule rather than re-implementing it where extraction is clean.
// (B) Machine key reads canonicalize ULID case like the human URLs
// (src/events/keys.ts): a lowercase or mixed-case but otherwise valid ULID
// serves the same event on REST GET /api/public/events/:key and MCP
// get_event; excluded Crockford letters (I, L, O, U, either case), wrong
// lengths and non-ULID strings keep refusing with the existing static
// envelopes and no database read; a valid unknown key in any case stays the
// existing 404/not_found; case variants of one key share cache bytes (one
// read) and retirement frees them whatever case warms first.
// Boundaries this file does not contest:
// - The stored key's first-character bound (0-7 in
//   src/public-data/contracts.ts): a `Z...` key stays refused. Human URLs
//   are looser here; tightening that gap is not this card.
// - Seed/demo keys on the machine surfaces: they stay refused, so magic link
//   forms can never leak into the public contract.
// - Surrounding whitespace on keys: refused, never trimmed.
//
// Sharing the parse rule is pinned behaviorally: every game and key input
// below runs against BOTH surfaces and must produce the same outcome, so a
// hand-copied second rule that drifts fails one side of the pair.
//
// Hermetic only: in-memory pg-proxy fakes + far-future fixtures, the real
// Hono routes, the real MCP server over an in-memory transport, the real
// cache and serializers and reader. No database, no network (fetch throws),
// no sleeps. The offline, agent-runnable contract command is:
//
//   npx vitest run test/mcp-rest-parity-acceptance.test.ts
//
// RED dialect today (pre-build head): tools/list omits `game` and its Zod
// strip silently drops it, so every `game` call returns the unfiltered
// collection; both machine key gates accept uppercase ULIDs only, so
// lowercase/mixed keys answer 422/invalid_request before any read. CONTROLs
// pass today and must keep passing. Builder: implement in source; do NOT
// edit this file.
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { canonicalEventKey, eventKeyAllowed } from "../src/events/keys";
import { createPublicMcpServer } from "../src/mcp/server";
import { __resetApiPublicCacheForTests, retireApiPublicEventCache } from "../src/public-data/cache";
import { registerPublicApiRoutes } from "../src/public-data/routes";

const dbBox = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/admin/db", () => ({ dbFor: async () => dbBox.db as Db }));
vi.mock("../src/events/routes-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: async () => null,
}));

const ORIGIN = "https://machine-parity.example.test";

type EventRow = typeof events.$inferSelect;

function fixtureRow(n: number, over: Partial<EventRow> = {}): EventRow {
  const start = over.startsAt ?? new Date(Date.UTC(2099, 0, 1 + n, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 2 * 3600_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: String(n).padStart(26, "0"),
    title: `Night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
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
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

// A real letter-bearing ULID in its stored (uppercase) form; digits-only
// keys cannot distinguish case variants. This value first appears at
// test/admin-event-route-key-admission.test.ts, so the secret-scan surface
// is already proven safe without a new allowlist entry.
const LETTER_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LETTER_KEY_LOWER = LETTER_KEY.toLowerCase();
const LETTER_KEY_MIXED = [...LETTER_KEY].map((c, i) => (i % 2 ? c.toLowerCase() : c)).join("");
// Another valid ULID with no stored row, and its lowercase variant.
const UNKNOWN_KEY = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_KEY_LOWER = UNKNOWN_KEY.toLowerCase();

// Seven published rows (3 Chess, 2 Catan, 1 null-game, 1 blank-game) plus one
// invisible Chess draft; row 3 carries the letter-bearing key. Id order
// matches start order, so asc(startsAt), asc(id) reads back in id order.
function defaultRows(): EventRow[] {
  return [
    fixtureRow(1, { title: "Chess Night Alpha", game: "Chess" }),
    fixtureRow(2, { title: "Catan Evening", game: "Catan" }),
    fixtureRow(3, { title: "Chess Night Beta", game: "Chess", eventKey: LETTER_KEY }),
    fixtureRow(4, { title: "Open Social", game: null }),
    fixtureRow(5, { title: "Catan Marathon", game: "Catan" }),
    fixtureRow(6, { title: "Chess Night Gamma", game: "Chess" }),
    fixtureRow(7, { title: "Untitled Mixer", game: "" }),
    fixtureRow(8, { title: "Draft Chess Night", game: "Chess", status: "draft" }),
  ];
}

// pg-proxy fake answering the public read shapes: count, LIMIT/OFFSET page,
// keyed detail (an event_key bind with no LIMIT), and going aggregates
// (empty: deterministic zero counts). The game filter applies only when the
// WHERE clause names the game column, mirroring SQL: trim + lowercase the
// STORED side, lowercase but never trim the bound value (trimming is the
// caller's job, so an untrimmed bind matches nothing, as in SQL). The detail
// read compares event_key by EXACT byte equality: stored keys are uppercase,
// so canonicalization must happen before the read — a build that only
// case-folds inside SQL fails here the way a case-sensitive equality fails
// in Postgres.
function publicParityFixture(rows: EventRow[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((k) => {
      const v = row[k];
      return v instanceof Date ? v.toISOString() : v;
    });
  const normStored = (s: string): string => s.trim().toLowerCase();
  const order = (a: EventRow, b: EventRow): number =>
    a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id;
  const visible = (sql: string, params: unknown[]): EventRow[] => {
    let out = rows.filter((r) => r.status === "published");
    const wherePart = sql
      .split(/from "events"/i)
      .slice(1)
      .join(' from "events" ');
    if (/"game"/i.test(wherePart)) {
      const gameParam = params.find(
        (p): p is string =>
          typeof p === "string" &&
          p !== "published" &&
          p !== "draft" &&
          !(p.startsWith("%") && p.endsWith("%")) &&
          !/^\d{4}-\d{2}-\d{2}[T ]/.test(p) &&
          !rows.some((row) => row.eventKey === p),
      );
      if (gameParam === undefined) return out;
      const want = gameParam.toLowerCase();
      out = out.filter((r) => r.game !== null && normStored(r.game) === want);
    }
    return out;
  };
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (/^select count/i.test(sql)) return { rows: [[visible(sql, params).length]] };
    // Keyed detail read: the WHERE clause (after `from "events"`) names
    // event_key. Answer by exact byte equality, zero rows for an unknown
    // or wrong-case bind, exactly as Postgres equality would.
    const wherePart = sql
      .split(/from "events"/i)
      .slice(1)
      .join(' from "events" ');
    if (!sql.includes("limit") && /"event_key"/i.test(wherePart)) {
      const bind = params.find((p): p is string => typeof p === "string");
      const row = bind === undefined ? undefined : rows.find((r) => r.eventKey === bind);
      return { rows: row ? [encode(row)] : [] };
    }
    const pool = [...visible(sql, params)].sort(order);
    if (sql.includes("limit")) {
      const hasOffset = sql.includes(" offset ");
      const offset = hasOffset ? Number(params.at(-1)) : 0;
      const limit = Number(params.at(hasOffset ? -2 : -1));
      const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
      const end = Number.isSafeInteger(limit) ? start + limit : pool.length;
      return { rows: pool.slice(start, end).map(encode) };
    }
    return { rows: pool.map(encode) };
  });
  const eventReads = () => queries.filter((q) => q.sql.includes('from "events"'));
  return { db: db as unknown as Db, queries, eventReads };
}

const ALL_TITLES = [
  "Chess Night Alpha",
  "Catan Evening",
  "Chess Night Beta",
  "Open Social",
  "Catan Marathon",
  "Chess Night Gamma",
  "Untitled Mixer",
];
const CHESS_TITLES = ["Chess Night Alpha", "Chess Night Beta", "Chess Night Gamma"];
const CATAN_TITLES = ["Catan Evening", "Catan Marathon"];

interface CollectionBody {
  data: { event_key: string; title: string; game: string | null }[];
  page: number;
  limit: number;
  meta: { current_page: number; per_page: number; total: number; last_page: number };
}
const titles = (body: CollectionBody): string[] => body.data.map((d) => d.title);

// The canonical empty collection both surfaces must answer for every invalid
// or unknown game; REST spells it with default paging whatever was asked.
const EMPTY_COLLECTION: CollectionBody = {
  data: [],
  page: 1,
  limit: 20,
  meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
};

type JsonObj = Record<string, unknown>;

// One fixture shared by both surfaces: the REST harness reads it through the
// mocked dbFor, the MCP server through its deps. The counter belongs to the
// pg-proxy fake, so every statement both surfaces issue is observable.
function surfaces(rows: EventRow[] = defaultRows()) {
  const fx = publicParityFixture(rows);
  dbBox.db = fx.db;
  const restApp = new Hono<{ Bindings: Env }>();
  registerPublicApiRoutes(restApp);
  const env = { APP_URL: ORIGIN } as Env;
  const restGet = (path: string, headers?: HeadersInit) =>
    restApp.request(`${ORIGIN}${path}`, { headers }, env);

  const mcp = async () => {
    const server = createPublicMcpServer({ env, db: fx.db, requestId: "parity-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number | string, (m: JsonObj) => void>();
    clientTransport.onmessage = (message) => {
      const id = (message as { id?: number | string }).id;
      if (id !== undefined && pending.has(id)) {
        pending.get(id)!(message as JsonObj);
        pending.delete(id);
      }
    };
    await server.connect(serverTransport);
    await clientTransport.start();
    let nextId = 1;
    const call = (method: string, params?: JsonObj): Promise<JsonObj> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out`));
        }, 5000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        clientTransport
          .send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
          .catch((err: unknown) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(err as Error);
          });
      });
    const hello = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-rest-parity-acceptance", version: "0" },
    });
    expect(hello["error"], "MCP initialize must answer before tools are exercised").toBeUndefined();
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listTools = async (): Promise<JsonObj[]> => {
      const listed = await call("tools/list", {});
      return ((listed["result"] as JsonObj | undefined)?.["tools"] ?? []) as JsonObj[];
    };
    const callTool = (name: string, args: JsonObj) => call("tools/call", { name, arguments: args });
    const close = async () => {
      await server.close();
      await clientTransport.close();
    };
    return { listTools, callTool, close };
  };

  return { ...fx, env, restGet, mcp };
}

// A tool call must answer as a JSON-RPC result carrying a successful
// structuredContent — never a top-level protocol error (a Zod schema
// rejection surface) and never an isError tool result.
function toolResult(message: JsonObj, label: string): JsonObj {
  expect(message["error"], `${label}: protocol error, not a tool result`).toBeUndefined();
  const result = message["result"] as JsonObj;
  expect(result["isError"], `${label}: isError tool result`).toBeUndefined();
  expect(result["structuredContent"], `${label}: structuredContent`).toBeDefined();
  return result;
}

function toolError(message: JsonObj, label: string): { code: string; message: string } {
  expect(message["error"], `${label}: protocol error, not a tool result`).toBeUndefined();
  const result = message["result"] as JsonObj;
  expect(result["isError"], label).toBe(true);
  const content = result["content"] as { text: string }[];
  const parsed = JSON.parse(content[0]!.text) as { error: { code: string; message: string } };
  return parsed.error;
}

beforeEach(() => {
  __resetApiPublicCacheForTests();
  vi.stubGlobal("fetch", () => {
    throw new Error("Network is forbidden in MCP/REST parity acceptance");
  });
});
afterEach(() => {
  __resetApiPublicCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MCP list_events game facet: advertised input schema", () => {
  it("tools/list advertises an optional string game with exact-match semantics", async () => {
    // RED today: the input schema carries page/per_page only. Passing
    // condition: `game` is advertised as an optional string whose
    // description states the exact / case-insensitive match, so an agent
    // can discover the facet from tools/list alone.
    const { mcp } = surfaces();
    const client = await mcp();
    try {
      const tools = await client.listTools();
      const list = tools.find((t) => t["name"] === "list_events");
      expect(list, "list_events stays advertised").toBeDefined();
      const schema = list!["inputSchema"] as JsonObj;
      const props = schema["properties"] as Record<string, JsonObj>;
      expect(Object.keys(props).sort(), "input properties").toEqual(["game", "page", "per_page"]);
      const game = props["game"]!;
      const types = ([] as unknown[]).concat(game["type"] ?? []);
      expect(types, `game schema ${JSON.stringify(game)}`).toContain("string");
      const required = (schema["required"] as string[] | undefined) ?? [];
      expect(required, "game must stay optional").not.toContain("game");
      const description = [(game["description"] as string | undefined) ?? ""]
        .concat(list!["description"] as string)
        .join("\n")
        .toLowerCase();
      expect(description, "description states exact match").toContain("exact");
      expect(description, "description states case-insensitive").toContain("case-insensitive");
    } finally {
      await client.close();
    }
  });

  it("CONTROL: page and per_page stay advertised and the tool stays read-only", async () => {
    // Passes today and must keep passing: adding `game` must not disturb the
    // paging inputs or the read-only annotation.
    const { mcp } = surfaces();
    const client = await mcp();
    try {
      const list = (await client.listTools()).find((t) => t["name"] === "list_events")!;
      const props = (list["inputSchema"] as JsonObj)["properties"] as Record<string, JsonObj>;
      expect(props["page"]).toBeDefined();
      expect(props["per_page"]).toBeDefined();
      expect((list["annotations"] as JsonObj)?.["readOnlyHint"]).toBe(true);
      expect(list["outputSchema"]).toBeDefined();
    } finally {
      await client.close();
    }
  });
});

describe("MCP list_events game facet: filtered reads mirror REST", () => {
  it("filters to the exact stored game and byte-matches the REST collection", async () => {
    // RED today: `game` is stripped and all 7 published rows come back.
    // Passing condition: only the 3 Chess rows, and the structuredContent
    // equals the REST JSON for ?game=Chess byte-for-byte after parse.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const result = toolResult(
        await client.callTool("list_events", { game: "Chess" }),
        "list_events game=Chess",
      );
      const viaTool = result["structuredContent"] as unknown as CollectionBody;
      expect(titles(viaTool)).toEqual(CHESS_TITLES);
      expect(viaTool.meta).toEqual({ current_page: 1, per_page: 20, total: 3, last_page: 1 });
      const rest = await s.restGet("/api/public/events?game=Chess");
      expect(rest.status).toBe(200);
      expect(viaTool).toEqual(await rest.json());
    } finally {
      await client.close();
    }
  });

  it("matches case-insensitively and trims, exactly like REST", async () => {
    // RED today: every variant returns the unfiltered 7. Passing condition:
    // each variant returns exactly the Chess rows on BOTH surfaces — the
    // direct per-surface titles are the oracle, not surface agreement. The
    // heavily space-padded variant pins REST's order: trim first, then the
    // length bound applies to the trimmed value (a pre-trim bound would
    // wrongly refuse it).
    const s = surfaces();
    const client = await s.mcp();
    try {
      for (const game of ["cHeSs", "CHESS", "chess", "  Chess  ", `Chess${" ".repeat(200)}`]) {
        const viaTool = toolResult(
          await client.callTool("list_events", { game }),
          `list_events game=${JSON.stringify(game)}`,
        )["structuredContent"] as unknown as CollectionBody;
        expect(titles(viaTool), `MCP game=${JSON.stringify(game)}`).toEqual(CHESS_TITLES);
        const rest = await s.restGet(`/api/public/events?game=${encodeURIComponent(game)}`);
        expect(rest.status, `REST game=${JSON.stringify(game)}`).toBe(200);
        const viaRest = (await rest.json()) as CollectionBody;
        expect(titles(viaRest), `REST game=${JSON.stringify(game)}`).toEqual(CHESS_TITLES);
      }
    } finally {
      await client.close();
    }
  });

  it("reads a different stored game, not a hardcoded one", async () => {
    // RED today: unfiltered. Passing condition: game=Catan returns exactly
    // the 2 Catan rows (the draft and null/blank games stay invisible).
    const s = surfaces();
    const client = await s.mcp();
    try {
      const viaTool = toolResult(
        await client.callTool("list_events", { game: "Catan" }),
        "list_events game=Catan",
      )["structuredContent"] as unknown as CollectionBody;
      expect(titles(viaTool)).toEqual(CATAN_TITLES);
      expect(viaTool.meta.total).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("composes the facet with paging and clamps to the filtered last page", async () => {
    // RED today: paging runs over the unfiltered 7. Passing condition: the
    // filter narrows the total first; page 2 of 2 holds the last Chess row
    // and page 99 clamps to it, exactly as REST does.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const second = toolResult(
        await client.callTool("list_events", { game: "Chess", per_page: 2, page: 2 }),
        "list_events Chess page 2",
      )["structuredContent"] as unknown as CollectionBody;
      expect(titles(second)).toEqual(["Chess Night Gamma"]);
      expect(second.page).toBe(2);
      expect(second.meta).toEqual({ current_page: 2, per_page: 2, total: 3, last_page: 2 });
      const clamped = toolResult(
        await client.callTool("list_events", { game: "Chess", per_page: 2, page: 99 }),
        "list_events Chess page 99",
      )["structuredContent"] as unknown as CollectionBody;
      expect(clamped).toEqual(second);
    } finally {
      await client.close();
    }
  });

  it("CONTROL: an absent game keeps the unfiltered contract byte-identical", async () => {
    // Passes today and must keep passing: only a PRESENT game filters; the
    // absent-game envelope (both with and without paging inputs) is
    // untouched and still equals the REST collection.
    const s = surfaces();
    const client = await s.mcp();
    try {
      for (const args of [{}, { per_page: 20, page: 1 }]) {
        const viaTool = toolResult(
          await client.callTool("list_events", args),
          `list_events ${JSON.stringify(args)}`,
        )["structuredContent"] as unknown as CollectionBody;
        expect(titles(viaTool), JSON.stringify(args)).toEqual(ALL_TITLES);
        expect(viaTool.meta, JSON.stringify(args)).toEqual({
          current_page: 1,
          per_page: 20,
          total: 7,
          last_page: 1,
        });
      }
      const rest = await s.restGet("/api/public/events");
      expect(rest.status).toBe(200);
      const viaRest = (await rest.json()) as CollectionBody;
      expect(titles(viaRest)).toEqual(ALL_TITLES);
    } finally {
      await client.close();
    }
  });
});

describe("MCP list_events game facet: every invalid input answers the canonical empty collection", () => {
  // Each input must yield EXACTLY the canonical empty collection as a
  // successful tool result: never the unfiltered rows, never an isError
  // tool error (the 422 shape), never a top-level JSON-RPC error (the Zod
  // schema-rejection shape — a `max` on the schema fails these rows).
  const EMPTY_CASES: { label: string; game: string }[] = [
    { label: "unknown game", game: "Go" },
    { label: "present-blank empty string", game: "" },
    { label: "present-blank spaces only", game: "   " },
    { label: "oversized (500 chars)", game: "C".repeat(500) },
    { label: "oversized extended known game (205 chars)", game: `Chess${"x".repeat(200)}` },
    { label: "embedded NUL control character", game: "Che\u0000ss" },
    { label: "control character only", game: "\u0001" },
  ];

  for (const { label, game } of EMPTY_CASES) {
    it(`answers the canonical empty collection for ${label}, never an error`, async () => {
      // RED today: the stripped/absent facet returns all 7 rows. Passing
      // condition: exactly the canonical empty collection, even when paging
      // inputs ask for a deep page (REST ignores paging on the empty page).
      const s = surfaces();
      const client = await s.mcp();
      try {
        for (const args of [{ game }, { game, per_page: 2, page: 99 }]) {
          const result = toolResult(
            await client.callTool("list_events", args),
            `list_events ${label} ${JSON.stringify(args).slice(0, 40)}`,
          );
          expect(
            result["structuredContent"] as unknown as CollectionBody,
            `${label}: canonical empty collection`,
          ).toEqual(EMPTY_COLLECTION);
        }
      } finally {
        await client.close();
      }
    });
  }

  it("never reflects a hostile game and never interpolates it", async () => {
    // RED today: unfiltered rows. Passing condition: the empty collection,
    // and no raw hostile value anywhere in the tool result bytes.
    const s = surfaces();
    const client = await s.mcp();
    try {
      for (const game of ['Chess" OR "1"="1', "<script>alert(1)</script>"]) {
        const message = await client.callTool("list_events", { game });
        const result = toolResult(message, `hostile game ${game}`);
        expect(result["structuredContent"] as unknown as CollectionBody, game).toEqual(
          EMPTY_COLLECTION,
        );
        expect(JSON.stringify(message), game).not.toContain(game);
      }
    } finally {
      await client.close();
    }
  });

  it("a long-but-legal 100-codepoint game still goes to the reader and matches nothing", async () => {
    // RED today: unfiltered 7 rows, and no game predicate at all. Passing
    // condition: a 100-codepoint value (at the shared REST bound) reads and
    // misses honestly — empty collection WITH event reads issued — instead
    // of being short-circuited like an invalid input. Catches a too-tight
    // re-implemented bound while the oversized rows above catch a loose one.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const before = s.eventReads().length;
      const result = toolResult(
        await client.callTool("list_events", { game: "C".repeat(100) }),
        "list_events 100-codepoint game",
      );
      expect(result["structuredContent"] as unknown as CollectionBody).toEqual(EMPTY_COLLECTION);
      expect(s.eventReads().length, "a legal-length game must reach the read").toBeGreaterThan(
        before,
      );
    } finally {
      await client.close();
    }
  });
});

describe("MCP list_events game facet: refusals read nothing, valid games read once", () => {
  it("short-circuits blank, oversized and control-character games with zero event reads", async () => {
    // RED today: each call reads the full unfiltered collection. Passing
    // condition: no statement against events at all — the value is refused
    // in-handler before the reader, mirroring REST's early return.
    const s = surfaces();
    const client = await s.mcp();
    try {
      for (const game of ["", "   ", "C".repeat(500), `Chess${"x".repeat(200)}`, "Che\u0000ss"]) {
        const before = s.eventReads().length;
        const result = toolResult(
          await client.callTool("list_events", { game }),
          `no-read refusal ${JSON.stringify(game).slice(0, 30)}`,
        );
        expect(result["structuredContent"] as unknown as CollectionBody).toEqual(EMPTY_COLLECTION);
        expect(s.eventReads().length, `queries for ${JSON.stringify(game).slice(0, 30)}`).toBe(
          before,
        );
      }
    } finally {
      await client.close();
    }
  });

  it("reads exactly one count and one page statement, both carrying the game predicate", async () => {
    // RED today: no issued statement names the game column. Passing
    // condition: one count + one LIMIT-bound page SELECT with the game
    // predicate (the total reflects the filter), and the Chess rows return.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const result = toolResult(
        await client.callTool("list_events", { game: "Chess" }),
        "list_events Chess query shape",
      );
      expect(titles(result["structuredContent"] as unknown as CollectionBody)).toEqual(
        CHESS_TITLES,
      );
      const reads = s.eventReads();
      const counts = reads.filter((q) => /^select count/i.test(q.sql));
      const pages = reads.filter((q) => !/^select count/i.test(q.sql));
      expect(counts).toHaveLength(1);
      expect(pages).toHaveLength(1);
      expect(counts[0]!.sql).toContain('"game"');
      expect(pages[0]!.sql).toContain('"game"');
      expect(pages[0]!.sql).toContain("limit");
    } finally {
      await client.close();
    }
  });

  it("CONTROL: REST still refuses blank and oversized games without reading", async () => {
    // Passes today (the REST early return) and must keep passing: sharing
    // the parse rule must not regress the surface that already had it.
    const s = surfaces();
    for (const query of ["?game=", "?game=%20%20", `?game=${"C".repeat(500)}`]) {
      const before = s.eventReads().length;
      const res = await s.restGet(`/api/public/events${query}`);
      expect(res.status, query).toBe(200);
      expect((await res.json()) as CollectionBody, query).toEqual(EMPTY_COLLECTION);
      expect(s.eventReads().length, query).toBe(before);
    }
  });
});

describe("case-variant ULIDs: machine key reads mirror the human canonicalization", () => {
  it("CONTROL: the human canonical predicate is case-insensitive and excludes ILOU", () => {
    // Passes today and anchors the target semantics: machine behavior must
    // converge with this predicate (case folding only), without importing
    // its seed-key or first-char looseness.
    expect(canonicalEventKey(LETTER_KEY_LOWER)).toBe(LETTER_KEY);
    expect(canonicalEventKey(LETTER_KEY_MIXED)).toBe(LETTER_KEY);
    expect(canonicalEventKey(`${LETTER_KEY.slice(0, 25)}U`)).toBeNull();
    expect(canonicalEventKey(`${LETTER_KEY.slice(0, 25)}u`)).toBeNull();
    expect(eventKeyAllowed(LETTER_KEY_LOWER, ORIGIN)).toBe(true);
  });

  it("REST serves lowercase and mixed-case keys byte-identically to the stored key", async () => {
    // RED today: both variants 422 before any read. Passing condition: 200
    // with the exact stored-key bytes (the DTO still carries the uppercase
    // event_key), and one shared cache entry — the first variant pays the
    // read, the rest replay.
    const s = surfaces();
    const upper = await s.restGet(`/api/public/events/${LETTER_KEY}`);
    expect(upper.status).toBe(200);
    const storedBody = await upper.text();
    const readsAfterWarm = s.eventReads().length;
    expect(readsAfterWarm).toBeGreaterThan(0);
    for (const variant of [LETTER_KEY_LOWER, LETTER_KEY_MIXED]) {
      const res = await s.restGet(`/api/public/events/${variant}`);
      expect(res.status, variant).toBe(200);
      expect(await res.text(), variant).toBe(storedBody);
    }
    expect(s.eventReads().length, "case variants replay from one cache entry").toBe(readsAfterWarm);
    const dto = JSON.parse(storedBody) as { event_key: string; title: string };
    expect(dto.event_key).toBe(LETTER_KEY);
    expect(dto.title).toBe("Chess Night Beta");
  });

  it("a lowercase variant that warms first frees the shared entry on retirement", async () => {
    // RED today: the lowercase request 422s. Passing condition: warming via
    // the lowercase variant serves the uppercase variant from cache, and a
    // retire forces a re-read for the pair.
    const s = surfaces();
    const warm = await s.restGet(`/api/public/events/${LETTER_KEY_LOWER}`);
    expect(warm.status).toBe(200);
    const body = await warm.text();
    const readsAfterWarm = s.eventReads().length;
    expect(readsAfterWarm).toBeGreaterThan(0);
    const upper = await s.restGet(`/api/public/events/${LETTER_KEY}`);
    expect(upper.status).toBe(200);
    expect(await upper.text()).toBe(body);
    expect(s.eventReads().length).toBe(readsAfterWarm);
    retireApiPublicEventCache();
    const afterRetire = await s.restGet(`/api/public/events/${LETTER_KEY}`);
    expect(afterRetire.status).toBe(200);
    expect(await afterRetire.text()).toBe(body);
    expect(s.eventReads().length).toBeGreaterThan(readsAfterWarm);
  });

  it("MCP get_event serves case variants with the stored uppercase key", async () => {
    // RED today: lowercase answers invalid_request. Passing condition:
    // every case variant returns the same structuredContent, and the
    // canonical uppercase result equals the REST detail JSON.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const upper = toolResult(
        await client.callTool("get_event", { event_key: LETTER_KEY }),
        "get_event uppercase",
      )["structuredContent"] as JsonObj;
      expect(upper["event_key"]).toBe(LETTER_KEY);
      expect(upper["title"]).toBe("Chess Night Beta");
      for (const variant of [LETTER_KEY_LOWER, LETTER_KEY_MIXED]) {
        const viaVariant = toolResult(
          await client.callTool("get_event", { event_key: variant }),
          `get_event ${variant}`,
        )["structuredContent"] as JsonObj;
        expect(viaVariant, variant).toEqual(upper);
      }
      const rest = await s.restGet(`/api/public/events/${LETTER_KEY}`);
      expect(rest.status).toBe(200);
      expect(upper).toEqual(await rest.json());
    } finally {
      await client.close();
    }
  });

  it("a valid unknown key in lowercase answers not_found on both surfaces", async () => {
    // RED today: REST 422s and MCP answers invalid_request. Passing
    // condition: the existing static not_found envelopes, so case folding
    // changes admission, never the miss vocabulary.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const rest = await s.restGet(`/api/public/events/${UNKNOWN_KEY_LOWER}`);
      expect(rest.status).toBe(404);
      // request_id is added by app-level middleware this direct-route
      // harness does not mount; pin the envelope's owned fields and allow
      // only that transport field beside them.
      const notFound = (await rest.json()) as { error: JsonObj };
      expect(notFound.error).toMatchObject({
        code: "not_found",
        message: "No published event with that key.",
        next: "Check the event key and retry.",
      });
      expect(Object.keys(notFound.error).sort()).toEqual(
        expect.arrayContaining(["code", "message", "next"]),
      );
      expect(
        Object.keys(notFound.error).every((k) =>
          ["code", "message", "next", "request_id"].includes(k),
        ),
      ).toBe(true);
      const err = toolError(
        await client.callTool("get_event", { event_key: UNKNOWN_KEY_LOWER }),
        "get_event unknown lowercase",
      );
      expect(err).toEqual({ code: "not_found", message: "No published event with that key." });
    } finally {
      await client.close();
    }
  });
});

describe("case-variant ULIDs: malformed keys keep refusing with no database read", () => {
  // Every key below must refuse on BOTH surfaces with the existing static
  // envelopes, reflect nothing, and issue zero event reads. The excluded-
  // letter rows are pure case variants of one stored key, pinning that
  // case folding never widens the Crockford alphabet.
  const tail = (last: string) => `${LETTER_KEY.slice(0, 25)}${last}`;
  const REFUSE_KEYS: { label: string; key: string }[] = [
    { label: "excluded letter I", key: tail("I") },
    { label: "excluded letter L", key: tail("L") },
    { label: "excluded letter O", key: tail("O") },
    { label: "excluded letter U", key: tail("U") },
    { label: "excluded lowercase u", key: tail("u") },
    { label: "excluded lowercase l", key: tail("l") },
    { label: "first char above the stored bound (Z)", key: `Z${LETTER_KEY.slice(1)}` },
    { label: "lowercase first char above the bound (z)", key: `z${LETTER_KEY_LOWER.slice(1)}` },
    { label: "25-char prefix", key: LETTER_KEY.slice(0, 25) },
    { label: "27-char extension", key: `${LETTER_KEY}V` },
    { label: "hyphenated", key: `${LETTER_KEY.slice(0, 13)}-${LETTER_KEY.slice(13)}` },
    { label: "punctuation", key: "not-a-key!!!" },
    { label: "seed/demo key", key: "seed-calendar-01" },
    { label: "space-padded valid key", key: `%20${LETTER_KEY_LOWER}%20` },
  ];

  for (const { label, key } of REFUSE_KEYS) {
    it(`CONTROL: refuses ${label} on both surfaces with zero event reads`, async () => {
      // Passes today (both gates reject these) and must keep passing: the
      // build widens CASE only. The MCP side skips the URL-encoded row —
      // percent sequences are a URL spelling, not a tool argument.
      const s = surfaces();
      const rest = await s.restGet(`/api/public/events/${key}`);
      expect(rest.status, `REST ${label}`).toBe(422);
      const raw = await rest.text();
      const refused = JSON.parse(raw) as { error: JsonObj };
      expect(refused.error, `REST ${label}`).toMatchObject({
        code: "invalid_request",
        message: "That event key is not valid.",
        next: "Fix the request and retry.",
      });
      expect(
        Object.keys(refused.error).every((k) =>
          ["code", "message", "next", "request_id"].includes(k),
        ),
        `REST ${label} envelope fields`,
      ).toBe(true);
      expect(raw, `REST ${label} never reflects the key`).not.toContain(key);
      expect(s.eventReads(), `REST ${label} reads nothing`).toHaveLength(0);
      if (!key.includes("%")) {
        const client = await s.mcp();
        try {
          const before = s.eventReads().length;
          const err = toolError(
            await client.callTool("get_event", { event_key: key }),
            `get_event ${label}`,
          );
          expect(err, `MCP ${label}`).toEqual({
            code: "invalid_request",
            message: "That event key is not valid.",
          });
          expect(s.eventReads().length, `MCP ${label} reads nothing`).toBe(before);
        } finally {
          await client.close();
        }
      }
    });
  }

  it("CONTROL: the stored uppercase key still serves on both surfaces", async () => {
    // Passes today and must keep passing: widening case admission must not
    // disturb the canonical form.
    const s = surfaces();
    const client = await s.mcp();
    try {
      const rest = await s.restGet(`/api/public/events/${LETTER_KEY}`);
      expect(rest.status).toBe(200);
      expect(((await rest.json()) as { event_key: string }).event_key).toBe(LETTER_KEY);
      const viaTool = toolResult(
        await client.callTool("get_event", { event_key: LETTER_KEY }),
        "get_event stored key CONTROL",
      )["structuredContent"] as JsonObj;
      expect(viaTool["event_key"]).toBe(LETTER_KEY);
    } finally {
      await client.close();
    }
  });
});
