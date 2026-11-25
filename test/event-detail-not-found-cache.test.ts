import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminDb from "../src/admin/db";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import * as suggestions from "../src/events/suggestions";
import app from "./app";

// Unknown/invalid /e/:key must reuse the same per-isolate,
// DB-source-scoped cached suggestion snapshot as ordinary 404s instead of
// running notFoundSuggestions for every request.
//
// The proxy fixture supplies the event and suggestion queries without a
// database. The DB-backed sibling covers the same routes with real rows.
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
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

type Row = { key: string; title: string };
const row = (key: string): Row => ({ key, title: `Event ${key}` });

// Each test gets its own binding, so the per-isolate cache never carries rows
// between tests: it is keyed on the DB source.
function eventsDb(initial: Row[], beforeSuggestions?: () => Promise<void>) {
  const state = { rows: initial };
  const query = vi.fn(async (sql: string) => {
    // Event-detail lookup by key always misses; anything else from events is
    // the suggestions select.
    if (sql.includes('"event_key" =')) return { rows: [] };
    if (sql.includes('from "events"')) {
      await beforeSuggestions?.();
      return {
        rows: state.rows.map((r) => [r.key, r.title, "2026-10-03T18:00:00Z", null]),
      };
    }
    return { rows: [] };
  });
  const db = drizzle(query);
  const { session } = db as unknown as { session: object };
  Object.assign(session, { transaction: (run: (tx: typeof db) => Promise<unknown>) => run(db) });
  const env: EnvWithAdminDb = { ...baseEnv, ADMIN_DB: db as unknown as Db };
  return { env, state };
}

async function eventMiss(path: string, env: EnvWithAdminDb) {
  const res = await app.request(path, {}, env);
  const html = await res.text();
  expect(res.status, path).toBe(404);
  expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
  expect(res.headers.get("set-cookie"), path).toBeNull();
  expect(html, path).toContain("We cannot find that page");
  return html;
}

const suggested = (html: string) =>
  [...html.matchAll(/href="\/e\/([^"]+)" data-testid="error-event-suggestion"/g)].map((m) => m[1]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("event-detail miss suggestions cache", () => {
  it("keeps the branded 404 when the suggestion query is still pending at the deadline", async () => {
    const started = deferred();
    const release = deferred();
    const { env } = eventsDb([row("game-night")], () => {
      started.resolve();
      return release.promise;
    });
    const response = app.request(`/e/${UNKNOWN_KEY}`, {}, env);
    try {
      await started.promise;
      const res = await response;
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/html\b/);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).toContain("We cannot find that page");
      expect(suggested(html)).toEqual([]);
    } finally {
      release.resolve();
    }
  });

  it("serves repeated unknown-key misses without a fresh suggestion DB read", async () => {
    const { env } = eventsDb([row("game-night")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    const first = await eventMiss(`/e/${UNKNOWN_KEY}`, env);
    vi.setSystemTime(T0 + 5_000);
    const second = await eventMiss(`/e/${UNKNOWN_KEY}`, env);
    expect(suggested(second)).toEqual(suggested(first));
    expect(fills).toHaveBeenCalledOnce();
  });

  it("serves repeated invalid-key misses without a fresh suggestion DB read", async () => {
    const { env } = eventsDb([row("game-night")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    const first = await eventMiss("/e/nope", env);
    vi.setSystemTime(T0 + 5_000);
    const second = await eventMiss("/e/also-invalid", env);
    expect(suggested(second)).toEqual(suggested(first));
    expect(fills).toHaveBeenCalledOnce();
  });

  it("shares one snapshot between an ordinary 404 and event-detail misses", async () => {
    const { env } = eventsDb([row("game-night")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    const acquire = vi.spyOn(adminDb, "dbFor");
    const plain = await app.request("/lost/link", {}, env);
    expect(plain.status).toBe(404);
    expect(suggested(await plain.text())).toEqual(["game-night"]);
    expect(fills).toHaveBeenCalledOnce();
    const dbReads = acquire.mock.calls.length;
    // Both miss shapes reuse that snapshot. The event lookup still reads per request.
    vi.setSystemTime(T0 + 5_000);
    expect(suggested(await eventMiss(`/e/${UNKNOWN_KEY}`, env))).toEqual(["game-night"]);
    vi.setSystemTime(T0 + 10_000);
    expect(suggested(await eventMiss("/e/nope", env))).toEqual(["game-night"]);
    expect(fills).toHaveBeenCalledOnce();
    expect(acquire.mock.calls.length).toBeGreaterThan(dbReads);
  });
});
