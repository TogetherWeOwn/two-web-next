// route-inventory: GET /events/:file{.+\.ics}
// Per-event ICS 404 parity: bad-key and missing-row .ics use the branded 404
// (suggestions + noindex), never bare plaintext; draft 403 stays unchanged.
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
const MISSING = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

// Real app, Drizzle reads on a pg-proxy double; no network or session store.
function fixture(status: "draft" | "published" = "published") {
  const row: typeof events.$inferSelect = {
    id: 1,
    eventKey: KEY,
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    startsAt: new Date("2099-01-10T20:00:00Z"),
    endsAt: new Date("2099-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Voice: General",
    capacity: null,
    status,
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    icsSequence: 1782907200n,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-01T12:00:00Z"),
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const values = columns.map((key) =>
    row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
  );
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      return { rows: params[0] === KEY ? [values] : [] };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return { row, env, request: (path: string) => app.request(path, {}, env) };
}

async function expectBranded404(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("etag")).toBeNull();
  const html = await response.text();
  expect(html).toContain("We cannot find that page");
  expect(html).toContain('name="robots" content="noindex, nofollow"');
  // .ics paths are asset-like, so the shared handler skips the DB lookup.
  expect(html).toContain('data-testid="error-events-empty"');
  expect(html).not.toContain("BEGIN:VCALENDAR");
  return html;
}

describe("per-event ICS 404 parity (fixture-only)", () => {
  it("routes a malformed key through the branded 404 with noindex", async () => {
    await expectBranded404(await fixture().request("/events/nope.ics"));
  });

  it("routes a missing row through the branded 404 with noindex", async () => {
    await expectBranded404(await fixture().request(`/events/${MISSING}.ics`));
  });

  it("keeps draft gating at a bare 403 for guests", async () => {
    const response = await fixture("draft").request(`/events/${KEY}.ics`);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("still serves a published event as calendar bytes", async () => {
    const response = await fixture().request(`/events/${KEY}.ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await response.text()).toContain("BEGIN:VEVENT");
  });
});
