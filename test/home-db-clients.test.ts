// Homepage DB-client regression: the upcoming and featured reads must not
// share one max:1 web-DB client. Each gets its own dbFor(c) client so the two
// transactions run on parallel connections like pre-#856.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import * as adminDb from "../src/admin/db";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { memberReadDb } from "../src/db/member-reads";
import type { Env } from "../src/env";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import { createMemorySessionStore } from "../src/sessions";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const NOW = new Date("2030-07-04T18:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function eventRow(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: null,
    purpose: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture() {
  const rows = [eventRow(1)];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "featured_contents"')) {
      return {
        rows: [[1, "Community news", "Featured body", null, null, null, null, null]],
      };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('from "events"')) {
      return {
        rows: rows.map((row) =>
          columns.map((key) => {
            const value = row[key];
            return value instanceof Date ? value.toISOString() : value;
          }),
        ),
      };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    SESSION_STORE: createMemorySessionStore(),
    DISCORD_EVENTS: {
      upcoming: async () => [],
      lastReadFailed: () => false,
    },
  } as Env;
  return { db, env };
}

afterEach(() => {
  __resetHomeGuestCacheForTests();
  vi.restoreAllMocks();
});

describe("homepage db clients", () => {
  it("gives the upcoming and featured reads distinct web-DB clients", async () => {
    const f = fixture();
    __resetHomeGuestCacheForTests();
    const spy = vi.spyOn(adminDb, "dbFor");
    const response = await app.request("/", {}, f.env);
    expect(response.status).toBe(200);
    await response.text();
    // One client per homepage read: upcoming + featured open in parallel like
    // pre-#856, never one shared max:1 client serializing both transactions.
    expect(spy).toHaveBeenCalledTimes(2);
    const clients = await Promise.all(spy.mock.results.map((result) => result.value));
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);

    const warmResponse = await app.request("/", {}, f.env);
    expect(warmResponse.status).toBe(200);
    await warmResponse.text();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("opens the upcoming and featured DB clients before either read resolves", async () => {
    const f = fixture();
    __resetHomeGuestCacheForTests();
    let resolveFirst!: (db: Db) => void;
    let resolveSecond!: (db: Db) => void;
    const firstGate = new Promise<Db>((resolve) => {
      resolveFirst = resolve;
    });
    const secondGate = new Promise<Db>((resolve) => {
      resolveSecond = resolve;
    });
    const firstDb = memberReadDb(f.db);
    const secondDb = memberReadDb(f.db);
    const spy = vi
      .spyOn(adminDb, "dbFor")
      .mockImplementationOnce(() => firstGate)
      .mockImplementationOnce(() => secondGate)
      .mockImplementation(async () => memberReadDb(f.db));
    const pending = app.request("/", {}, f.env);
    // Both client opens must be issued before either read can proceed: a
    // serialized implementation (await the upcoming read before opening the
    // featured client) leaves the second dbFor call unissued while the first
    // gate is still shut. The 500 ms bound sits below the 1000 ms upcoming
    // deadline so a deadline-masked serialization still fails instead of
    // resolving via the fallback and opening the second client late.
    await vi.waitUntil(() => spy.mock.calls.length >= 2, { timeout: 500 });
    expect(spy).toHaveBeenCalledTimes(2);
    resolveFirst(firstDb);
    resolveSecond(secondDb);
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();
    const clients = await Promise.all(spy.mock.results.map((result) => result.value));
    expect(clients[0]).not.toBe(clients[1]);
  });
});
