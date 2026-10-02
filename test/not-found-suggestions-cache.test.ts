import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminDb from "../src/admin/db";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { assetLikePath, NOT_FOUND_SUGGESTIONS_TTL_MS } from "../src/not-found-suggestions";
import app from "./app";

// TOG-12551: unknown URLs must not open one Postgres transaction each.
const baseEnv: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const T0 = Date.parse("2026-10-02T12:00:00Z");

type Row = { key: string; title: string };
const row = (key: string): Row => ({ key, title: `Event ${key}` });

// Each test gets its own binding, so the per-isolate cache never carries rows
// between tests: it is keyed on the DB source.
function eventsDb(initial: Row[]) {
  const state = { rows: initial };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('from "events"')
      ? state.rows.map((r) => [r.key, r.title, "2026-10-03T18:00:00Z", null])
      : [],
  }));
  const db = drizzle(query);
  const transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db));
  Object.assign(db, { transaction });
  const env: EnvWithAdminDb = { ...baseEnv, ADMIN_DB: db as unknown as Db };
  return { env, state, transaction, query };
}

async function notFound(path: string, env: EnvWithAdminDb) {
  const res = await app.request(path, {}, env);
  const html = await res.text();
  expect(res.status, path).toBe(404);
  expect(res.headers.get("cache-control"), path).toBe("no-store, private");
  expect(html, path).toContain("We cannot find that page");
  expect(html, path).toContain('action="/events" method="get" role="search"');
  return html;
}

const suggested = (html: string) =>
  [...html.matchAll(/href="\/e\/([^"]+)" data-testid="error-event-suggestion"/g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("asset-like paths", () => {
  it.each([
    "/wp-login.php",
    "/wp-admin/admin-ajax.php",
    "/.env",
    "/.git/config",
    "/.well-known/security.txt",
    "/favicon.ico",
    "/logo.png",
    "/app.js",
    "/app.js.map",
    "/sitemap.xml",
    "/robots.txt",
  ])("%s is asset-like", (path) => {
    expect(assetLikePath(path)).toBe(true);
  });

  it.each(["/", "/some-page", "/lost/link", "/events/next-week", "/wp-admin/"])(
    "%s is page-like",
    (path) => {
      expect(assetLikePath(path)).toBe(false);
    },
  );

  it.each(["/wp-login.php", "/.env"])(
    "%s renders the 404 without any DB call, even on a cold cache",
    async (path) => {
      const { env, transaction, query } = eventsDb([row("game-night")]);
      const acquire = vi.spyOn(adminDb, "dbFor");
      const html = await notFound(path, env);
      expect(suggested(html)).toEqual([]);
      expect(html).toContain('data-testid="error-events-empty"');
      expect(acquire).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );
});

describe("per-isolate 404 suggestions cache", () => {
  it("keeps the legacy suggestions and search form on a page-like path", async () => {
    const { env, transaction } = eventsDb([row("game-night"), row("quiz")]);
    const html = await notFound("/some-page", env);
    expect(suggested(html)).toEqual(["game-night", "quiz"]);
    expect(html).not.toContain('data-testid="error-events-empty"');
    expect(html).toContain('href="/events" data-testid="error-all-events"');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("serves 50 sequential 404s within the TTL from at most one DB read", async () => {
    const { env, transaction, query } = eventsDb([row("game-night")]);
    const acquire = vi.spyOn(adminDb, "dbFor");
    for (let i = 0; i < 50; i++) {
      vi.setSystemTime(T0 + i * 1_000);
      expect(suggested(await notFound(`/probe-${i}`, env))).toEqual(["game-night"]);
    }
    expect(acquire).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2); // set_config timeouts + events select
  });

  it("expires after the TTL and reads fresh rows", async () => {
    const { env, state, transaction } = eventsDb([row("before")]);
    expect(suggested(await notFound("/a", env))).toEqual(["before"]);
    state.rows = [row("after")];
    vi.setSystemTime(T0 + NOT_FOUND_SUGGESTIONS_TTL_MS - 1);
    expect(suggested(await notFound("/b", env))).toEqual(["before"]);
    expect(transaction).toHaveBeenCalledOnce();
    vi.setSystemTime(T0 + NOT_FOUND_SUGGESTIONS_TTL_MS);
    expect(suggested(await notFound("/c", env))).toEqual(["after"]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("renders a DB error as the plain 404 and does not retry it within the TTL", async () => {
    const { env, transaction } = eventsDb([row("recovered")]);
    transaction.mockRejectedValueOnce(new Error("private database failure"));
    for (const path of ["/lost", "/lost-again"]) {
      const html = await notFound(path, env);
      expect(suggested(html)).toEqual([]);
      expect(html).toContain('data-testid="error-events-empty"');
      expect(html).not.toContain("private database failure");
    }
    expect(transaction).toHaveBeenCalledOnce();
    vi.setSystemTime(T0 + NOT_FOUND_SUGGESTIONS_TTL_MS);
    expect(suggested(await notFound("/later", env))).toEqual(["recovered"]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("never serves one DB source's rows for another", async () => {
    const first = eventsDb([row("first")]);
    const second = eventsDb([row("second")]);
    expect(suggested(await notFound("/x", first.env))).toEqual(["first"]);
    expect(suggested(await notFound("/x", second.env))).toEqual(["second"]);
    expect(second.transaction).toHaveBeenCalledOnce();
  });

  it("keeps a newer published snapshot when an older concurrent fill settles last", async () => {
    const { env, state, transaction } = eventsDb([row("old")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = env.ADMIN_DB!;
    transaction.mockImplementationOnce(async (fn: (tx: Db) => Promise<unknown>) => {
      await gate;
      return fn(db);
    });
    const slow = notFound("/slow", env);
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce());
    state.rows = [row("new")];
    expect(suggested(await notFound("/fast", env))).toEqual(["new"]);
    state.rows = [row("old")];
    release();
    expect(suggested(await slow)).toEqual(["old"]);
    expect(suggested(await notFound("/cached", env))).toEqual(["new"]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does no lookup when no database is configured or the binding is unreadable", async () => {
    const acquire = vi.spyOn(adminDb, "dbFor");
    expect(suggested(await notFound("/some-page", baseEnv))).toEqual([]);
    const broken: EnvWithAdminDb = { ...baseEnv };
    Object.defineProperty(broken, "DATABASE_URL", {
      get: () => {
        throw new Error("binding unavailable");
      },
    });
    expect(suggested(await notFound("/some-page", broken))).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  });
});
