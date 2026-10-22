import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { safeRequestId } from "../src/request-log";
import app from "./app";

const BOARD_WARNING = "Board view unavailable for logging; serving results without recording.";
const THROTTLE_NULL_STORE_WARN = "Throttle store unavailable; allowing the request.";
const RAY = "abcdef0123456789-IAD";
const PATHS = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];

// Exercise the real routes, aggregates, and analytics sink with local SQL
// fixtures. Only the board-view INSERT fails, after the board reads succeed.
function fixture() {
  const inserts: unknown[][] = [];
  const db = drizzle(async (sql, params) => {
    if (sql.startsWith('insert into "board_view_logs"')) {
      inserts.push(params);
      throw new Error("fixture insert failure; this message must not be logged");
    }
    if (sql.includes('from "join_attempts"')) return { rows: [] };
    // The event count answers 0; the bounded gatherings list answers empty,
    // so the board renders genuine-empty with no section.
    if (sql.includes('from "events"')) return { rows: sql.includes("count(*)") ? [[0]] : [] };
    if (sql.startsWith("SET LOCAL") || sql.startsWith("select set_config(")) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  });
  Object.assign(db, {
    transaction: async <T>(run: (tx: Db) => Promise<T>) => run(db as unknown as Db),
  });
  const env = {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db,
  } as unknown as Env;
  return { env, inserts };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(PATHS)("%s board warning joins to http.request", (path) => {
  it.each([
    ["valid cf-ray", RAY],
    ["invalid cf-ray", "not-a-ray!!"],
    ["no cf-ray", undefined],
  ] as const)("preserves the request join with %s", async (_label, ray) => {
    const { env, inserts } = fixture();
    const response = await app.request(
      path,
      { headers: ray === undefined ? {} : { "cf-ray": ray } },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // Prove the intended sink failed, not an earlier aggregate or timeout setup.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(path.slice(1));

    const requestId = response.headers.get("x-request-id");
    expect(typeof requestId).toBe("string");
    expect(safeRequestId(requestId)).toBe(requestId);
    if (ray === RAY) expect(requestId).toBe(RAY);
    else if (ray !== undefined) expect(requestId).not.toBe(ray);

    const calls = vi.mocked(console.warn).mock.calls;
    // The null throttle store intentionally warns once per guarded request
    // (fail-open allow); this test only owns the board-warning line, so it
    // filters that contracted line before asserting nothing else warned.
    const unexpected = calls.filter(
      ([msg]) => msg !== BOARD_WARNING && msg !== THROTTLE_NULL_STORE_WARN,
    );
    expect(unexpected).toEqual([]);
    expect(calls.filter(([msg]) => msg === BOARD_WARNING)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(BOARD_WARNING, {
      exception: "DrizzleQueryError",
      request_id: requestId,
    });
    const requests = vi
      .mocked(console.log)
      .mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((line) => line.event === "http.request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      request_id: requestId,
      route: path === "/hotzones" ? "/hotzones" : "/hotzones/:signal",
      status: 200,
    });
  });
});
