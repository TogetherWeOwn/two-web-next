// Acceptance contract: featured-read fallback warns (X3 leg C).
//
// Acceptance-owned: the Builder builds on this branch and never edits this file.
// Failing-first: the three fallback tests run RED on main (cachedFeatured
// swallows read failures silently and takes no request id) and go green when
// the build lands. The success + empty controls already pass and must keep
// passing.
//
// Contract for the Builder (exact console.warn line, fired once per fallback):
//   "Home featured unavailable; serving the fallback."
//   { request_id: safeRequestId(requestId), exception: "ReadFailure" }
// This mirrors warnHomeFallback in src/events/reads.ts: the bounded exception
// class plus the validated request id, never driver text, SQL or identities.
// The Builder threads the caller's request id through cachedFeatured as a
// trailing optional param (mirroring cachedHomeUpcoming's requestId position,
// after the execution context) and passes c.get("requestId") at the homepage
// caller in src/index.tsx. Empty-list fallback behavior is unchanged: a
// failed read still answers [] (and a genuinely empty table stays silent).
//
// Hermetic: drizzle pg-proxy fixtures + throwing openDb doubles; no database,
// no network, no live Discord.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { VisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";
import { createMemorySessionStore } from "../src/sessions";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const NOW = new Date("2030-07-04T18:00:00Z");
// Allowlisted synthetic ULID (see .gitleaks.toml).
const RID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FEATURED_WARN = "Home featured unavailable; serving the fallback.";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// The Builder adds this trailing requestId param; the cast keeps this file
// typechecking before and after (extra JS args are ignored today, honored
// after the build).
const cachedFeaturedWithRequestId = cachedFeatured as unknown as (
  env: Env,
  openDb: () => Promise<Db | null>,
  now?: Date,
  ctx?: unknown,
  requestId?: string,
) => Promise<VisibleFeatured[]>;

// Positional projection: id, title, body, url, imageUrl, imageAlt, startsAt,
// endsAt. Null bounds stay visible at every instant.
const FEATURED_ROW = [1, "Community news", "Featured body", null, null, null, null, null];

function featuredDb(rows: unknown[][]): Db {
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "featured_contents"')) return { rows };
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return db;
}

afterEach(() => {
  __resetHomeGuestCacheForTests();
  vi.restoreAllMocks();
});

describe("featured-read fallback warns (failing-first)", () => {
  it("failed read warns with the request id and still answers []", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = featuredDb([]);
    const env = { ...baseEnv, ADMIN_DB: db };
    const rows = await cachedFeaturedWithRequestId(
      env,
      async () => {
        throw new Error("postgres://user:secret@host/db select private-featured-marker");
      },
      NOW,
      undefined,
      RID,
    );
    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(FEATURED_WARN, {
      request_id: RID,
      exception: "ReadFailure",
    });
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["postgres://", "secret@host", "select", "private-featured-marker"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("drops a malformed request id instead of logging raw caller text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = featuredDb([]);
    const env = { ...baseEnv, ADMIN_DB: db };
    const rows = await cachedFeaturedWithRequestId(
      env,
      async () => {
        throw new Error("boom");
      },
      NOW,
      undefined,
      "private-featured caller-secret",
    );
    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]?.[1] as { request_id?: unknown; exception?: unknown };
    expect(fields.request_id).toBeUndefined();
    expect(fields.exception).toBe("ReadFailure");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("private-featured");
    expect(logged).not.toContain("caller-secret");
  });

  it("homepage caller threads its request id into the fallback line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = drizzle(async (sql: string) => {
      if (sql.includes('from "featured_contents"')) {
        throw new Error("private featured outage homepage-featured-marker");
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
    } as unknown as Env;
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const featuredWarns = warn.mock.calls.filter(([message]) => message === FEATURED_WARN);
    expect(featuredWarns).toHaveLength(1);
    expect(featuredWarns[0]![1]).toMatchObject({ request_id: requestId, exception: "ReadFailure" });
    const logged = JSON.stringify(featuredWarns);
    expect(logged).not.toContain("homepage-featured-marker");
    expect(logged).not.toContain("private featured outage");
  });
});

describe("featured-read success + empty silence", () => {
  it("healthy read returns visible rows with no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = featuredDb([FEATURED_ROW]);
    const env = { ...baseEnv, ADMIN_DB: db };
    const rows = await cachedFeatured(env, async () => db, NOW);
    expect(rows).toMatchObject([{ title: "Community news" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("genuinely empty table answers [] with no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = featuredDb([]);
    const env = { ...baseEnv, ADMIN_DB: db };
    const rows = await cachedFeatured(env, async () => db, NOW);
    expect(rows).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
