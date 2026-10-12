import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminDb from "../src/admin/db";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import * as suggestions from "../src/events/suggestions";
import app from "./app";

// TOG-22184: unknown/invalid /e/:key must reuse the same per-isolate,
// DB-source-scoped cached suggestion snapshot as ordinary 404s instead of
// running notFoundSuggestions for every request.
//
// These cases stay hermetic (pg-proxy doubles). The proxy driver has no
// transactions, so a cold in-boundary fill cannot return rows here; row
// rendering through the member-read boundary is covered DB-backed in
// test/event-detail-not-found-db.test.ts. What these prove hermetically:
// the route serves /e misses from the shared snapshot with no fresh
// suggestion DB read while it is valid.
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
function eventsDb(initial: Row[]) {
  const state = { rows: initial };
  const query = vi.fn(async (sql: string) => {
    // Event-detail lookup by key always misses; anything else from events is
    // the suggestions select.
    if (sql.includes('"event_key" =')) return { rows: [] };
    if (sql.includes('from "events"'))
      return {
        rows: state.rows.map((r) => [r.key, r.title, "2026-10-03T18:00:00Z", null]),
      };
    return { rows: [] };
  });
  const db = drizzle(query);
  const transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db));
  Object.assign(db, { transaction });
  const env: EnvWithAdminDb = { ...baseEnv, ADMIN_DB: db as unknown as Db };
  return { env, state, transaction };
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("event-detail miss suggestions cache", () => {
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
    // Ordinary 404 fills outside the member-read boundary, where the
    // proxy double supports transactions.
    const plain = await app.request("/lost/link", {}, env);
    expect(plain.status).toBe(404);
    expect(suggested(await plain.text())).toEqual(["game-night"]);
    expect(fills).toHaveBeenCalledOnce();
    const dbReads = acquire.mock.calls.length;
    // Both miss shapes reuse that snapshot inside the boundary: same rows,
    // no fresh suggestion read (the event lookup still reads per request).
    vi.setSystemTime(T0 + 5_000);
    expect(suggested(await eventMiss(`/e/${UNKNOWN_KEY}`, env))).toEqual(["game-night"]);
    vi.setSystemTime(T0 + 10_000);
    expect(suggested(await eventMiss("/e/nope", env))).toEqual(["game-night"]);
    expect(fills).toHaveBeenCalledOnce();
    expect(acquire.mock.calls.length).toBeGreaterThan(dbReads);
  });
});
