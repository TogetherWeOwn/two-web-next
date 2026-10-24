// Acceptance-owned controls. A presentation-only slice must not add DB reads,
// member-subject audits, session lookups, refreshes, or conceal connection outages.
import { drizzle } from "drizzle-orm/postgres-js";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { dashboardJoinFunnel } from "../src/admin/join-funnel";
import { resolveDashboardWidgets } from "../src/admin/kit-dashboard";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const SECRET = "fixture-session-secret-at-least-32-bytes";
const env: Env = {
  APP_URL: "https://example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "fixture-client-secret",
  DISCORD_BOT_TOKEN: "fixture-bot-token",
  SESSION_SECRET: SECRET,
};
const privateMarker = "private-widget-error-marker";

async function admitted() {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "Fixture moderator",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const get = vi.spyOn(store, "get");
  const renew = vi.spyOn(store, "renew");
  const rotate = vi.spyOn(store, "rotate");
  return { app: adminApp({ sessionStore: store }), cookie, get, renew, rotate };
}

// Real Drizzle builders/dialect; only execution and transaction IO are fixtures.
// Unexpected SQL fails rather than silently supplying an empty result.
function dashboardDb(failing: "none" | "funnel" | "search", code = "42P01") {
  const statements: string[] = [];
  let transactions = 0;
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        prepareQuery: (query: { sql: string }) => unknown;
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
      };
    }
  ).session;
  session.transaction = async (work) => {
    transactions++;
    return work(db);
  };
  session.prepareQuery = ({ sql }) => ({
    setToken() {
      return this;
    },
    execute: async () => {
      statements.push(sql);
      if (sql.startsWith("select set_config(")) return [];
      const widget = sql.includes('from "join_attempts"')
        ? "funnel"
        : sql.includes('from "event_search_logs"')
          ? "search"
          : "unknown";
      if (widget === "unknown") throw new Error("Unexpected dashboard IO");
      if (widget === failing) throw Object.assign(new Error(privateMarker), { code });
      return widget === "funnel" ? [{ outcome: "added", n: 7 }] : [];
    },
  });
  return { db, statements, transactions: () => transactions };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dashboard diagnostic IO/privacy controls", () => {
  it.each(["none", "funnel", "search"] as const)(
    "one admitted %s read keeps the same session and aggregate-only IO budget",
    async (failing) => {
      const fixture = dashboardDb(failing);
      const session = await admitted();
      const res = await session.app.request("/", { headers: { cookie: session.cookie } }, {
        ...env,
        ADMIN_DB: fixture.db,
      } as Env);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      // Admission plus post-render revalidation, with one sliding renewal.
      expect(session.get).toHaveBeenCalledTimes(2);
      expect(session.renew).toHaveBeenCalledTimes(1);
      expect(session.rotate).not.toHaveBeenCalled();
      expect(fixture.transactions()).toBe(2);
      expect(fixture.statements).toHaveLength(4);
      expect(fixture.statements.filter((sql) => sql.startsWith("select set_config("))).toHaveLength(
        2,
      );
      expect(fixture.statements.filter((sql) => sql.includes('from "join_attempts"'))).toHaveLength(
        1,
      );
      expect(
        fixture.statements.filter((sql) => sql.includes('from "event_search_logs"')),
      ).toHaveLength(1);
      expect(fixture.statements.every((sql) => /^select\b/i.test(sql))).toBe(true);
      expect(fixture.statements.join("\n")).not.toMatch(
        /member_access_logs|activity_logs|\b(?:insert|update|delete)\b/i,
      );
      expect(html).not.toContain(privateMarker);
      expect(html).not.toContain("42P01");
      expect(html).not.toContain("100000000000000111");
      if (failing !== "funnel") expect(html).toContain('data-testid="funnel-added">7</td>');
      if (failing !== "search") expect(html).toContain('data-testid="top-zero-searches-empty"');
    },
  );

  it.each(["funnel", "search"] as const)(
    "a %s transport outage is still a sanitized 503, not optional-empty success",
    async (failing) => {
      const fixture = dashboardDb(failing, "ECONNREFUSED");
      const session = await admitted();
      const res = await session.app.request("/", { headers: { cookie: session.cookie } }, {
        ...env,
        ADMIN_DB: fixture.db,
      } as Env);
      const html = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(html).not.toContain(privateMarker);
      expect(html).not.toContain("ECONNREFUSED");
      expect(html).not.toContain('data-testid="admin-actor"');
    },
  );

  it("the funnel remains a 60-second cached count, not a dashboard-refresh recount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const db = {} as Db;
    const identity = {};
    let count = 7;
    const read = vi.fn(async () => ({ added: count }));
    expect(await dashboardJoinFunnel(db, identity, 1500, read)).toEqual({ added: 7 });
    count = 8;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await dashboardJoinFunnel(db, identity, 1500, read)).toEqual({ added: 7 });
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await dashboardJoinFunnel(db, identity, 1500, read)).toEqual({ added: 8 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["funnel", "search"] as const)(
    "Kit retains the successful peer when %s has a non-transport error",
    (failing) => {
      const failure = {
        status: "rejected",
        reason: Object.assign(new Error(privateMarker), { code: "57014" }),
      } as const;
      const funnel =
        failing === "funnel" ? failure : ({ status: "fulfilled", value: { added: 7 } } as const);
      const search = failing === "search" ? failure : ({ status: "fulfilled", value: [] } as const);
      expect(resolveDashboardWidgets(funnel, search)).toEqual({
        outage: false,
        funnel: failing === "funnel" ? undefined : { added: 7 },
        zeroSearches: failing === "search" ? undefined : [],
      });
    },
  );
});
