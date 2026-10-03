// Event-key letter case: one canonical key form per event. ULIDs are stored
// uppercase, so a lowercase ULID 301-redirects to the canonical URL instead
// of 404ing on the case-sensitive lookup. Seed/demo keys are already
// lowercase and unaffected; unknown keys still render the branded 404.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const APP_URL = "https://next.example.test";
// Allowlisted synthetic fixture ULIDs only (see .gitleaks.toml).
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
function fixture(over: Partial<typeof events.$inferSelect> = {}) {
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
    ...over,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    // The going-count aggregate reads two positional columns; the viewer
    // answer read selects its own row and is empty in this fixture.
    if (sql.includes('from "rsvps"'))
      return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    if (sql.includes('"event_key" =')) {
      const wanted = (params as unknown[]).at(-1);
      if (wanted !== KEY) return { rows: [] };
      return {
        rows: [
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: SECRET,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    queries,
    env,
    request: (path = PATH) => app.request(path, {}, env),
  };
}

describe("event-key canonical letter case (fixture-only)", () => {
  it("301s a lowercase ULID to the canonical URL, without a DB read", async () => {
    const moved = await fixture().request(`/e/${KEY.toLowerCase()}`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(PATH);
    expect(moved.headers.get("cache-control")).toBe("private, no-store");
  });

  it("the canonical URL 200s with the event page", async () => {
    const response = await fixture().request();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(">Chess night</h1>");
  });

  it("preserves the query string across the canonical redirect", async () => {
    const moved = await fixture().request(`/e/${KEY.toLowerCase()}?from=discord`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`${PATH}?from=discord`);
  });

  it("renders the branded 404 for an unknown ULID-shaped key", async () => {
    const unknown = "01J00000000000000000000017";
    const response = await fixture().request(`/e/${unknown}`);
    const html = await response.text();
    expect(response.status).toBe(404);
    expect(html).toContain("We cannot find that page");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("leaves non-ULID keys on the refusal path, never the canonical redirect", async () => {
    for (const path of ["/e/not-a-ulid", `/e/${KEY.slice(0, 25)}X`]) {
      const response = await fixture().request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});
