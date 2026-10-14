// Homepage server-time slice: concurrent independent reads + guest-invariant
// short-TTL cache. Guest/member isolation and one-shot flash consumption.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  __resetHomeGuestCacheForTests,
  cachedFeatured,
  cachedHomeUpcoming,
  retireHomeGuestCache,
} from "../src/home-cache";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";

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

function fixture(opts: { events?: (typeof events.$inferSelect)[]; featured?: boolean } = {}) {
  const rows = opts.events ?? [eventRow(1)];
  const featured = opts.featured ?? true;
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  let eventQueries = 0;
  let featuredQueries = 0;
  let firstDbQueryAt = 0;
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (firstDbQueryAt === 0) firstDbQueryAt = Date.now();
    if (sql.includes('from "featured_contents"')) {
      featuredQueries += 1;
      // Positional projection: id, title, body, url, imageUrl, imageAlt,
      // startsAt, endsAt. Null bounds stay visible at every instant.
      return {
        rows: featured
          ? [[1, "Community news", "Featured body", null, null, null, null, null]]
          : [],
      };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      eventQueries += 1;
      return { rows: [] };
    }
    if (sql.includes('from "events"')) {
      eventQueries += 1;
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
  return {
    db,
    env,
    counts: () => ({ eventQueries, featuredQueries }),
    dbFirstQueryAt: () => firstDbQueryAt,
  };
}

afterEach(() => {
  __resetHomeGuestCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("homepage concurrent reads", () => {
  it("starts the guest data reads before a slow session read resolves", async () => {
    const f = fixture();
    const store = (f.env as unknown as Record<string, unknown>).SESSION_STORE as ReturnType<
      typeof createMemorySessionStore
    >;
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "user-1",
      username: "member-one",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const origGet = store.get.bind(store);
    let sessionResolvedAt = 0;
    store.get = (async (...args: Parameters<typeof origGet>) => {
      // Slow session storage: sequential code would hold every guest data
      // read behind this delay.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const row = await origGet(...args);
      sessionResolvedAt = Date.now();
      return row;
    }) as typeof origGet;
    const cookie = await serializeSigned("__Host-two_session", token, f.env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }).then((signed) => (signed as string).split(";")[0]!);
    const response = await app.request("/", { headers: { cookie } }, f.env);
    expect(response.status).toBe(200);
    // The first DB query started while the session read was still pending.
    expect(f.dbFirstQueryAt()).toBeGreaterThan(0);
    expect(f.dbFirstQueryAt()).toBeLessThan(sessionResolvedAt);
  });
});

describe("homepage guest-invariant cache", () => {
  it("reuses cached upcoming + featured across guests without a second DB read", async () => {
    const f = fixture();
    const first = await app.request("/", {}, f.env);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Game night 1");
    const afterFirst = f.counts();
    expect(afterFirst.eventQueries).toBeGreaterThan(0);
    expect(afterFirst.featuredQueries).toBeGreaterThan(0);
    const second = await app.request("/", {}, f.env);
    expect(second.status).toBe(200);
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(await second.text()).toContain("Game night 1");
    // No additional event/featured queries on the cache hit.
    expect(f.counts()).toEqual(afterFirst);
  });

  it("renders the member session from cached guest data", async () => {
    const f = fixture();
    await app.request("/", {}, f.env);
    const afterGuest = f.counts();
    const store = (f.env as unknown as Record<string, unknown>).SESSION_STORE as ReturnType<
      typeof createMemorySessionStore
    >;
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "user-1",
      username: "member-one",
      avatar: null,
      member: true,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const cookie = await serializeSigned("__Host-two_session", token, f.env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }).then((signed) => (signed as string).split(";")[0]!);
    const member = await app.request("/", { headers: { cookie } }, f.env);
    expect(member.status).toBe(200);
    const html = await member.text();
    expect(html).toContain("member-one");
    expect(html).toContain("Game night 1");
    expect(f.counts()).toEqual(afterGuest);
  });

  it("consumes a one-shot flash once and never leaks it to the next viewer", async () => {
    const f = fixture();
    const flash = (
      (await serializeSigned(JOIN_RESULT_COOKIE, "added", f.env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })) as string
    ).split(";")[0]!;
    const first = await app.request("/", { headers: { cookie: flash } }, f.env);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Game night 1");
    const firstSetCookie = first.headers.getSetCookie().join(";");
    expect(firstSetCookie).toContain(JOIN_RESULT_COOKIE);
    const second = await app.request("/", {}, f.env);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Game night 1");
  });
});

describe("homepage edge cache layer (production path)", () => {
  const bodies = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  const edgeEnv: Env = {
    ...baseEnv,
    DATABASE_URL: "postgres://edge-cache-test.invalid/db",
  };
  const discordSource = () => ({ upcoming: async () => [], lastReadFailed: () => false });

  function stubEdge() {
    bodies.clear();
    pending.length = 0;
    (globalThis as Record<string, unknown>).caches = {
      default: {
        match: async (request: Request) => {
          const body = bodies.get(request.url);
          return body === undefined
            ? undefined
            : new Response(body, { headers: { "content-type": "application/json" } });
        },
        put: async (request: Request, response: Response) => {
          bodies.set(request.url, await response.text());
        },
        delete: async (request: Request) => bodies.delete(request.url),
      },
    };
  }

  async function flushEdge() {
    await Promise.all(pending.splice(0));
    await Promise.resolve();
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).caches;
  });

  it("serves upcoming from the edge entry with revived dates and no second DB read", async () => {
    stubEdge();
    const f = fixture();
    const first = await cachedHomeUpcoming(edgeEnv, async () => f.db, discordSource, NOW, ctx);
    expect(first.unavailable).toBe(false);
    expect(first.items).toHaveLength(1);
    await flushEdge();
    expect(bodies.size).toBeGreaterThan(0);
    // Drop the isolate-local entries: the next read can only hit the edge.
    __resetHomeGuestCacheForTests();
    const second = await cachedHomeUpcoming(
      edgeEnv,
      async () => {
        throw new Error("DB must not be touched on an edge hit");
      },
      discordSource,
      NOW,
      ctx,
    );
    expect(second.unavailable).toBe(false);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.startsAt).toBeInstanceOf(Date);
    expect(second.items[0]?.startsAt.getTime()).toBe(first.items[0]?.startsAt.getTime());
  });

  it("never stores an unavailable upcoming read, so recovery is visible", async () => {
    stubEdge();
    const down = await cachedHomeUpcoming(edgeEnv, async () => null, discordSource, NOW, ctx);
    expect(down.unavailable).toBe(true);
    await flushEdge();
    expect(bodies.size).toBe(0);
    const f = fixture();
    const recovered = await cachedHomeUpcoming(edgeEnv, async () => f.db, discordSource, NOW, ctx);
    expect(recovered.unavailable).toBe(false);
    expect(recovered.items).toHaveLength(1);
  });

  it("round-trips featured through the edge entry", async () => {
    stubEdge();
    const f = fixture();
    const first = await cachedFeatured(edgeEnv, async () => f.db, NOW, ctx);
    expect(first).toHaveLength(1);
    await flushEdge();
    expect(bodies.size).toBeGreaterThan(0);
    __resetHomeGuestCacheForTests();
    const second = await cachedFeatured(
      edgeEnv,
      async () => {
        throw new Error("DB must not be touched on an edge hit");
      },
      NOW,
      ctx,
    );
    expect(second).toEqual(first);
  });
});

describe("homepage guest cache retire", () => {
  it("re-reads featured after a retire on the same injected database", async () => {
    // Same injected object before and after: only the generation bump can
    // turn the second read into a miss (the WeakMap key never changes).
    let rows: unknown[][] = [[1, "Community news", "Featured body", null, null, null, null, null]];
    const db = drizzle(async (sql: string) => {
      if (sql.includes('from "featured_contents"')) return { rows };
      if (sql.includes("set_config")) return { rows: [] };
      return { rows: [] };
    }) as unknown as Db;
    Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
    const env = { ...baseEnv, ADMIN_DB: db } as Env;
    const first = await cachedFeatured(env, async () => db, NOW, undefined);
    expect(first).toHaveLength(1);
    const hit = await cachedFeatured(env, async () => db, NOW, undefined);
    expect(hit).toHaveLength(1);
    // A committed mutation retires: the next read re-queries and sees the
    // emptied table instead of the retired row.
    rows = [];
    await retireHomeGuestCache();
    await expect(cachedFeatured(env, async () => db, NOW, undefined)).resolves.toEqual([]);
  });

  it("deletes the shared edge entries so they cannot re-seed memory", async () => {
    const bodies = new Map<string, string>();
    (globalThis as Record<string, unknown>).caches = {
      default: {
        match: async (request: Request) => {
          const body = bodies.get(request.url);
          return body === undefined
            ? undefined
            : new Response(body, { headers: { "content-type": "application/json" } });
        },
        put: async (request: Request, response: Response) => {
          bodies.set(request.url, await response.text());
        },
        delete: async (request: Request) => bodies.delete(request.url),
      },
    };
    try {
      const edgeEnv: Env = {
        ...baseEnv,
        DATABASE_URL: "postgres://edge-retire-test.invalid/db",
      };
      const f = fixture();
      const first = await cachedFeatured(edgeEnv, async () => f.db, NOW, undefined);
      expect(first).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bodies.size).toBeGreaterThan(0);
      await retireHomeGuestCache();
      expect(bodies.size).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).caches;
    }
  });
});
