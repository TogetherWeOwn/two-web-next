// Joinable analytics log lines (Z2 acceptance, failing-first).
//
// Contract: the `event_search` console.info line is a structured object —
// `{ event, query, results }` plus a validated `request_id` when the caller
// has one (no `JSON.stringify`) — and both analytics write-degradation warns
// carry the same optional validated `request_id`, so every line joins to
// `http.request`. Validation follows the join-attempt precedent
// (`safeRequestId`): a valid correlation id is echoed verbatim, anything else
// is omitted — never logged raw. No user id, session, IP, or raw query/PII
// travels on any of these lines.
//
// Owned by the Test Author card; the Z2 Builder must not edit this file.
// RED at handoff: `event_search` is still a pre-stringified blob without
// `request_id`, and both warns carry `{ exception }` only. The Builder's
// handoff comment states the exact new signatures these tests call through
// widened types below (the casts keep `npm run typecheck` green while the
// runtime assertions fail for the right reason).
import { readFileSync, readdirSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { recordBoardView } from "../src/hotzones/board-log";
import { recordSearch } from "../src/events/search-log";
import type { Env } from "../src/env";
import { eventSearchLogEntry, normalizeEventSearch } from "../src/islands/contracts";
import { safeRequestId } from "../src/request-log";

/* ------------------------------------------------------- fixtures + shims */

const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_RAY = "abcdef0123456789";
const VALID_RAY_COLO = "abcdef0123456789-IAD";
const INVALID_IDS = [
  ["arbitrary text", "not-a-request-id!!"],
  ["path traversal", "../../etc/passwd"],
  ["empty", ""],
  ["short ray", "abcdef012345678"],
  ["bad ulid first char", "81ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ["lowercase ulid", VALID_ULID.toLowerCase()],
  ["null", null],
  ["undefined", undefined],
] as const;

const SEARCH_WARNING = "Event search unavailable for logging; serving results without recording.";
const BOARD_WARNING = "Board view unavailable for logging; serving results without recording.";
const BOARD_OPTS = { boardKey: "hotzones", scope: "all", season: "2026", resultCount: 3 };

/** Widened calls until the Z2 signatures land; see the file header. */
const entryWithId = eventSearchLogEntry as unknown as (
  raw: string,
  results: number,
  requestId?: unknown,
) => unknown;
const recordSearchWithId = recordSearch as unknown as (
  db: Db,
  raw: string | null | undefined,
  resultCount: number,
  deadlineMs?: number,
  requestId?: unknown,
) => Promise<void>;
const recordBoardViewWithId = recordBoardView as unknown as (
  db: Db | null,
  opts: typeof BOARD_OPTS,
  deadlineMs?: number,
  requestId?: unknown,
) => Promise<void>;
/** Extra arg until `loadCalendarPageModel` accepts `requestId`. */
function modelWithId(args: Parameters<typeof loadCalendarPageModel>[0], requestId: unknown) {
  return loadCalendarPageModel(Object.assign(args, requestId === undefined ? {} : { requestId }));
}

const throwingDb = () =>
  ({
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({
          values: async () => {
            throw new Error("boom");
          },
        }),
      }),
  }) as unknown as Db;
const hungDb = () =>
  ({
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({ values: () => new Promise<void>(() => {}) }),
      }),
  }) as unknown as Db;

beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function infoLines(name: string): unknown[][] {
  return vi.mocked(console.info).mock.calls.filter((call) => call[0] === name);
}
function httpRequestLines(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of vi.mocked(console.log).mock.calls) {
    try {
      const value = JSON.parse(String(call[0])) as Record<string, unknown>;
      if (value && typeof value === "object" && value.event === "http.request") out.push(value);
    } catch {
      /* non-JSON log lines are not request logs */
    }
  }
  return out;
}

/* ------------------------------------------------- entry shape (contracts) */

describe("eventSearchLogEntry request_id", () => {
  it("sanity: the fixtures validate exactly like production ids", () => {
    for (const valid of [VALID_ULID, VALID_RAY, VALID_RAY_COLO]) {
      expect(safeRequestId(valid)).toBe(valid);
    }
    for (const [, invalid] of INVALID_IDS) {
      expect(safeRequestId(invalid)).toBeUndefined();
    }
  });

  it("omits request_id when the caller has none", () => {
    const entry = eventSearchLogEntry("  JAM  ", 2) as unknown as Record<string, unknown>;
    expect(entry).toEqual({ event: "event_search", query: "jam", results: 2 });
    expect("request_id" in entry).toBe(false);
  });

  it("carries a valid ULID request_id verbatim", () => {
    expect(entryWithId("  JAM  ", 2, VALID_ULID)).toEqual({
      event: "event_search",
      query: "jam",
      results: 2,
      request_id: VALID_ULID,
    });
  });

  it.each([VALID_RAY, VALID_RAY_COLO])("carries a valid cf-ray request_id %j", (ray) => {
    expect(entryWithId("  JAM  ", 2, ray)).toEqual({
      event: "event_search",
      query: "jam",
      results: 2,
      request_id: ray,
    });
  });

  it.each(INVALID_IDS)("omits an invalid request_id (%s), never raw", (_label, invalid) => {
    const entry = entryWithId("  JAM  ", 2, invalid) as unknown as Record<string, unknown>;
    expect(entry).toEqual({ event: "event_search", query: "jam", results: 2 });
    if (typeof invalid === "string" && invalid !== "") {
      expect(JSON.stringify(entry)).not.toContain(invalid);
    }
  });

  it("blank query stays null even with a valid request id", () => {
    expect(entryWithId("   ", 2, VALID_ULID)).toBeNull();
  });

  it("clamps negative results without dropping a valid request_id", () => {
    expect(entryWithId("x", -3, VALID_ULID)).toEqual({
      event: "event_search",
      query: "x",
      results: 0,
      request_id: VALID_ULID,
    });
  });

  it("emits exactly the allowed keys", () => {
    expect(Object.keys(entryWithId("x", 1, VALID_ULID) as object).sort()).toEqual([
      "event",
      "query",
      "request_id",
      "results",
    ]);
    expect(Object.keys(eventSearchLogEntry("x", 1) as unknown as object).sort()).toEqual([
      "event",
      "query",
      "results",
    ]);
  });
});

/* --------------------------------------------------- recordSearch warns */

describe("recordSearch warn request_id", () => {
  it("carries a valid request_id on write failure", async () => {
    await recordSearchWithId(throwingDb(), "helldiv", 1, undefined, VALID_ULID);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(SEARCH_WARNING, {
      exception: "Error",
      request_id: VALID_ULID,
    });
  });

  it("carries the id on the deadline warn too", async () => {
    await recordSearchWithId(hungDb(), "helldiv", 1, 30, VALID_RAY);
    expect(console.warn).toHaveBeenCalledWith(SEARCH_WARNING, {
      exception: "LogWriteDeadline",
      request_id: VALID_RAY,
    });
  });

  it.each(INVALID_IDS)("omits an invalid request_id (%s), never raw", async (_label, invalid) => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await recordSearchWithId(throwingDb(), "helldiv", 1, undefined, invalid);
    expect(warn).toHaveBeenCalledWith(SEARCH_WARNING, { exception: "Error" });
    if (typeof invalid === "string" && invalid !== "") {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(invalid);
    }
  });

  it("omits request_id when the caller has none", async () => {
    await expect(recordSearch(throwingDb(), "helldiv", 1)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(SEARCH_WARNING, { exception: "Error" });
  });
});

/* ------------------------------------------------- recordBoardView warns */

describe("recordBoardView warn request_id", () => {
  it("carries a valid request_id on write failure", async () => {
    await recordBoardViewWithId(throwingDb(), BOARD_OPTS, undefined, VALID_ULID);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(BOARD_WARNING, {
      exception: "Error",
      request_id: VALID_ULID,
    });
  });

  it("carries the id on the deadline warn too", async () => {
    await recordBoardViewWithId(hungDb(), BOARD_OPTS, 30, VALID_RAY);
    expect(console.warn).toHaveBeenCalledWith(BOARD_WARNING, {
      exception: "LogWriteDeadline",
      request_id: VALID_RAY,
    });
  });

  it.each(INVALID_IDS)("omits an invalid request_id (%s), never raw", async (_label, invalid) => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await recordBoardViewWithId(throwingDb(), BOARD_OPTS, undefined, invalid);
    expect(warn).toHaveBeenCalledWith(BOARD_WARNING, { exception: "Error" });
    if (typeof invalid === "string" && invalid !== "") {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(invalid);
    }
  });

  it("omits request_id when the caller has none", async () => {
    await expect(recordBoardView(throwingDb(), BOARD_OPTS)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(BOARD_WARNING, { exception: "Error" });
  });

  it("null db resolves without a warn", async () => {
    await expect(recordBoardView(null, BOARD_OPTS)).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

/* --------------------------------- pg-proxy harness (model + route level) */

type EventRow = typeof events.$inferSelect;
let eventSeq = 0;
function eventRow(over: Partial<EventRow> = {}): EventRow {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2030, 1, 1, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `ev-${n}`,
    title: `Game night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "Europe/London",
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
const okSource = (): DiscordEventsSource => ({
  upcoming: async () => [],
  lastReadFailed: () => false,
});

type AnalyticsRow = { normalizedQuery: string; resultCount: number };
type AnalyticsInsert = (row: AnalyticsRow) => Promise<void>;

/** pg-proxy fake answering the calendar reads; the analytics insert is swappable. */
function proxyHarness(up: EventRow[], past: EventRow[], analytics: AnalyticsInsert) {
  const logs: AnalyticsRow[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((key) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : value;
    });
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) {
      return {
        rows: [...up, ...past]
          .filter((row) => params.includes(row.discordEventId))
          .map((row) => [row.discordEventId]),
      };
    }
    let rows = /"ends_at" </.test(sql) ? past : up;
    if (sql.includes("'draft'")) rows = rows.filter((row) => row.status !== "draft");
    const bound = params.find(
      (param): param is string =>
        typeof param === "string" && param.startsWith("%") && param.endsWith("%"),
    );
    if (bound) {
      const term = bound.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      rows = rows.filter(
        (row) =>
          row.title.toLowerCase().includes(term) ||
          (row.description ?? "").toLowerCase().includes(term),
      );
    }
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    if (sql.includes("limit")) rows = rows.slice(0, Number(params.at(-1)));
    return { rows: rows.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({
          values: async (row: { normalizedQuery: string; resultCount: number }) => {
            await analytics(row);
            logs.push(row);
          },
        }),
      } as unknown as Db),
  });
  return { db: db as unknown as Db, logs };
}

const SEARCH_Q = "  JAM  ";
function jamRows() {
  return {
    up: [eventRow({ title: "Jam night" })],
    past: [
      eventRow({
        title: "Past jam",
        startsAt: new Date(Date.UTC(2020, 0, 1)),
        endsAt: new Date(Date.UTC(2020, 0, 1, 2)),
      }),
    ],
  };
}

/* ---------------------------------------- page-model emission + threading */

describe("event_search emission through the page model", () => {
  const NOW = new Date("2030-01-20T12:00:00Z");

  async function searchModel(requestId: unknown, analytics?: AnalyticsInsert) {
    const { up, past } = jamRows();
    const { db, logs } = proxyHarness(up, past, analytics ?? (async () => {}));
    const model = await modelWithId(
      {
        db,
        input: resolveCalendarInput({ q: SEARCH_Q }),
        includeDrafts: false,
        discord: okSource(),
        now: NOW,
      },
      requestId,
    );
    return { model, logs };
  }

  it("emits one structured object with the validated request_id", async () => {
    const { logs } = await searchModel(VALID_ULID);
    // Harness proof: the demand write ran, so the emission below is a real search.
    expect(logs).toEqual([{ normalizedQuery: "jam", resultCount: 2 }]);
    const lines = infoLines("event_search");
    expect(lines).toHaveLength(1);
    const payload = lines[0]![1];
    expect(typeof payload).toBe("object");
    expect(payload).toEqual({
      event: "event_search",
      query: "jam",
      results: 2,
      request_id: VALID_ULID,
    });
  });

  it("emits the same three fields with no request_id key when the caller has none", async () => {
    await searchModel(undefined);
    const lines = infoLines("event_search");
    expect(lines).toHaveLength(1);
    const payload = lines[0]![1];
    expect(typeof payload).toBe("object");
    expect(payload).toEqual({ event: "event_search", query: "jam", results: 2 });
  });

  it("omits an invalid request_id without logging it raw", async () => {
    await searchModel("not-a-request-id!!");
    const lines = infoLines("event_search");
    expect(lines).toHaveLength(1);
    const payload = lines[0]![1] as Record<string, unknown>;
    expect(payload).toEqual({ event: "event_search", query: "jam", results: 2 });
    expect(JSON.stringify(lines)).not.toContain("not-a-request-id!!");
  });

  it("threads the caller id to the recordSearch warn on write failure", async () => {
    const { logs } = await searchModel(VALID_RAY, async () => {
      throw new Error("boom");
    });
    // Fail-open: the model serves the page and still emits the result line.
    expect(logs).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(SEARCH_WARNING, {
      exception: "Error",
      request_id: VALID_RAY,
    });
    const lines = infoLines("event_search");
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({
      event: "event_search",
      query: "jam",
      results: 2,
      request_id: VALID_RAY,
    });
  });

  it("records nothing when there is no search", async () => {
    const { up, past } = jamRows();
    const { db, logs } = proxyHarness(up, past, async () => {});
    await modelWithId(
      {
        db,
        input: resolveCalendarInput({}),
        includeDrafts: false,
        discord: okSource(),
        now: NOW,
      },
      VALID_ULID,
    );
    expect(logs).toEqual([]);
    expect(infoLines("event_search")).toEqual([]);
  });

  it("logs the normalized query under exactly the allowed keys", async () => {
    await searchModel(VALID_ULID);
    const payload = infoLines("event_search")[0]![1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["event", "query", "request_id", "results"]);
    expect(payload.query).toBe(normalizeEventSearch(SEARCH_Q));
    expect(payload.query).not.toBe(SEARCH_Q);
    for (const forbidden of ["user", "userId", "session", "ip", "cookie", "token", "discordId"]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });
});

/* ------------------------------------------------- route-level join proof */

describe("route-level join to http.request", () => {
  function routeEnv(analytics?: AnalyticsInsert) {
    const { up, past } = jamRows();
    const { db } = proxyHarness(up, past, analytics ?? (async () => {}));
    return {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      ADMIN_DB: db,
      DISCORD_EVENTS: okSource(),
    } as unknown as Env;
  }

  it("the same cf-ray joins event_search to http.request", async () => {
    const env = routeEnv();
    const response = await app.request(
      "/events?q=%20%20JAM%20%20",
      { headers: { "cf-ray": VALID_RAY } },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(VALID_RAY);
    const requests = httpRequestLines();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request_id).toBe(VALID_RAY);
    const lines = infoLines("event_search");
    expect(lines).toHaveLength(1);
    const payload = lines[0]![1];
    expect(typeof payload).toBe("object");
    expect(payload).toEqual({
      event: "event_search",
      query: "jam",
      results: 2,
      request_id: VALID_RAY,
    });
  });

  it("an invalid cf-ray is never reflected raw", async () => {
    const env = routeEnv();
    const raw = "not-a-ray!!";
    const response = await app.request("/events?q=jam", { headers: { "cf-ray": raw } }, env);
    expect(response.status).toBe(200);
    const echoed = response.headers.get("x-request-id")!;
    expect(echoed).not.toBe(raw);
    expect(safeRequestId(echoed)).toBe(echoed);
    const payload = infoLines("event_search")[0]![1] as Record<string, unknown>;
    expect(payload.request_id).toBe(echoed);
    const allLogged = JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.log).mock.calls,
    ]);
    expect(allLogged).not.toContain(raw);
  });
});

/* ------------------------------------------------------- emission inventory */

describe("emission-site inventory", () => {
  function srcFiles(dir = "src/"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) out.push(...srcFiles(`${rel}/`));
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
    return out.sort();
  }
  const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("exactly one event_search emission site", () => {
    const total = srcFiles().reduce(
      (n, file) => n + countOccurrences(readFileSync(file, "utf8"), 'console.info("event_search"'),
      0,
    );
    expect(total).toBe(1);
  });

  it("exactly one warn site per analytics sink", () => {
    const totals = new Map<string, number>([
      [SEARCH_WARNING, 0],
      [BOARD_WARNING, 0],
    ]);
    for (const file of srcFiles()) {
      const source = readFileSync(file, "utf8");
      for (const message of totals.keys()) {
        totals.set(message, totals.get(message)! + countOccurrences(source, message));
      }
    }
    expect(Object.fromEntries(totals)).toEqual({ [SEARCH_WARNING]: 1, [BOARD_WARNING]: 1 });
  });

  it("request_id exists at the entry, search, and board join sites", () => {
    expect(readFileSync("src/islands/contracts-calendar.ts", "utf8")).toContain("request_id");
    expect(readFileSync("src/events/search-log.ts", "utf8")).toContain("request_id");
    expect(readFileSync("src/hotzones/board-log.ts", "utf8")).toContain("request_id");
  });
});
