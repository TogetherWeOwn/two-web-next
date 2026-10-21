// Builder-owned companion to test/degraded-dashboard-logging-acceptance.test.ts
// (which the Test Author owns and this card must not edit): the real widget
// helpers resolve undefined — not rejection — on cancellations, ordinary
// failures and deadline timeouts, so the route must log the omitted section
// for fulfilled-undefined settlements too. These tests drive the real helpers
// through the real route with no module mocks.
import { drizzle } from "drizzle-orm/postgres-js";
import { serializeSigned } from "hono/utils/cookie";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const RAY = "0123456789abcdef-LHR";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

function aggregateDb(n: number) {
  const aggregate = vi.fn(async () => [{ outcome: "added", n }]);
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        prepareQuery: (query: { sql: string }) => unknown;
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
      };
    }
  ).session;
  session.prepareQuery = (query) => ({
    setToken() {
      return this;
    },
    execute: async () => {
      if (query.sql.includes('from "join_attempts"')) return aggregate();
      if (
        query.sql.includes('from "event_search_logs"') ||
        query.sql.startsWith("select set_config(")
      )
        return [];
      throw new Error("Dashboard query has no isolated fixture");
    },
  });
  session.transaction = async (work) => work(db);
  return { db, aggregate, session };
}

async function cookieFor(store: ReturnType<typeof createMemorySessionStore>) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const s = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return s.split(";")[0]!;
}

/** The production mount runs requestLog ahead of the admin routes. */
function dashboardApp(store: ReturnType<typeof createMemorySessionStore>) {
  const router = new Hono<{ Bindings: Env }>();
  router.use("*", requestLog);
  router.route("/", adminApp({ sessionStore: store }));
  return router;
}

/** Serialized console.warn/console.info lines mentioning the widget. */
function widgetLines(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const spy of [vi.mocked(console.warn), vi.mocked(console.info)]) {
    for (const call of spy.mock.calls) {
      const line = call
        .map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
        .join(" ");
      if (pattern.test(line)) out.push(line);
    }
  }
  return out;
}

const cancellation = () =>
  Object.assign(new Error("statement timeout"), {
    code: "57014",
    name: "PostgresError",
  });

describe("degraded dashboard widgets resolve undefined through the real helpers", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a funnel statement cancellation logs one funnel line and omits only the funnel", async () => {
    // Real helpers, no mocks: the funnel SELECT hits its statement timeout,
    // dashboardJoinFunnel resolves undefined, and the route omits the section
    // at 200 with one correlated line. Promise.allSettled evaluates the
    // funnel read first, so its transaction is always call 1.
    const store = createMemorySessionStore();
    const { db, session } = aggregateDb(7);
    let calls = 0;
    const realTransaction = session.transaction;
    session.transaction = async (work) => {
      if (++calls === 1) throw cancellation();
      return realTransaction(work);
    };
    const res = await dashboardApp(store).request(
      "/",
      { headers: { cookie: await cookieFor(store), "cf-ray": RAY } },
      { ...env, ADMIN_DB: db } as Env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const html = await res.text();
    expect(html).not.toContain('data-testid="join-funnel"');
    expect(html).toContain('data-testid="top-zero-searches"');
    const lines = widgetLines(/funnel/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
    expect(widgetLines(/zero.?searches/i)).toEqual([]);
  });

  it("an ordinary zero-search failure logs one zero-search line and omits only that widget", async () => {
    // Real helpers, no mocks: an ordinary (non-outage, non-cancellation)
    // error resolves undefined out of topZeroResultSearches, and the route
    // omits the section at 200 with one correlated line carrying no error text.
    const store = createMemorySessionStore();
    const { db, session } = aggregateDb(7);
    let calls = 0;
    const realTransaction = session.transaction;
    session.transaction = async (work) => {
      if (++calls === 2) throw new TypeError("private widget bug");
      return realTransaction(work);
    };
    const res = await dashboardApp(store).request(
      "/",
      { headers: { cookie: await cookieFor(store), "cf-ray": RAY } },
      { ...env, ADMIN_DB: db } as Env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe(RAY);
    const html = await res.text();
    expect(html).toContain('data-testid="join-funnel"');
    expect(html).not.toContain('data-testid="top-zero-searches"');
    const lines = widgetLines(/zero.?searches/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
    expect(JSON.stringify(lines)).not.toContain("private widget bug");
    expect(widgetLines(/funnel/i)).toEqual([]);
  });
});
