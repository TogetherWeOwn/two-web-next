// route-inventory: GET /events/:file{.+\.ics}
// route-inventory: GET /events/:key
// One canonical key form per event on the sibling per-key routes, mirroring
// /e/:key: a ULID in another letter case 301s to the canonical uppercase URL
// before any session/DB read. Seed/demo keys and unparsable keys keep their
// current paths; forged keys still refuse, unknown keys still 404.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const APP_URL = "https://next.example.test";
// Allowlisted synthetic fixture ULIDs only (see .gitleaks.toml).
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MISSING = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const VIEWER = "100000000000000131"; // Discord snowflake: the read boundary refuses non-numeric viewers.

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
function fixture() {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const values = columns.map((key) =>
    row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
  );
  let queries = 0;
  const db = drizzle(async (sql, params) => {
    queries++;
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      const wanted = (params as unknown[]).at(-1);
      return { rows: wanted === KEY ? [values] : [] };
    }
    // going-count aggregate and the waitlist-position read: empty line.
    // (waitlistPosition issues raw SQL with an unquoted `from rsvps`.)
    if (sql.includes('from "rsvps"') || sql.includes("from rsvps")) return { rows: [] };
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: SECRET,
    ADMIN_DB: db as unknown as Db,
    SESSION_STORE: store,
  } as unknown as Env;
  return {
    store,
    env,
    queryCount: () => queries,
    request: (path: string, init?: RequestInit) => app.request(path, init ?? {}, env),
  };
}

async function cookieFor(store: SessionStore, env: Env) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: VIEWER,
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function jsonGet(f: ReturnType<typeof fixture>, path: string) {
  return f.request(path, {
    headers: { cookie: await cookieFor(f.store, f.env), accept: "application/json" },
  });
}

describe("per-key canonical letter case (fixture-only)", () => {
  it("301s a lowercase ULID .ics to the canonical URL, without a DB read", async () => {
    const f = fixture();
    const moved = await f.request(`/events/${KEY.toLowerCase()}.ics`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`/events/${KEY}.ics`);
    expect(f.queryCount()).toBe(0);
  });

  it("preserves the query string across the .ics canonical redirect", async () => {
    const moved = await fixture().request(`/events/${KEY.toLowerCase()}.ics?download=1`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`/events/${KEY}.ics?download=1`);
  });

  it("still serves the canonical .ics as calendar bytes", async () => {
    const response = await fixture().request(`/events/${KEY}.ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await response.text()).toContain("BEGIN:VEVENT");
  });

  it("routes unknown and forged .ics keys through the branded 404, never a redirect", async () => {
    for (const path of [`/events/${MISSING}.ics`, "/events/nope.ics"]) {
      const response = await fixture().request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("content-type"), path).toContain("text/html");
    }
  });

  it("301s a lowercase ULID JSON show to the canonical URL before any session read", async () => {
    const moved = await fixture().request(`/events/${KEY.toLowerCase()}`, {
      headers: { accept: "application/json" },
    });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`/events/${KEY}`);
  });

  it("serves the canonical JSON show with the event resource", async () => {
    const response = await jsonGet(fixture(), `/events/${KEY}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { event_key: string } };
    expect(body.data.event_key).toBe(KEY);
  });

  it("keeps forged and unknown JSON show keys on the 404 path, never a redirect", async () => {
    for (const path of [`/events/${MISSING}`, "/events/not-a-ulid"]) {
      const response = await jsonGet(fixture(), path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
      expect(await response.json(), path).toEqual({ error: "not_found" });
    }
  });
});
