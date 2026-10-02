import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// route-inventory: GET /e/:key

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";

// TOG-12677: pin the event-page attendance line (count + spots-left + RSVP
// control) without touching the hot render files. Mounted app with local
// fixtures only: real Drizzle queries and Hono/session rendering, no DB.
function fixture(over: Partial<typeof events.$inferSelect> = {}, going = 3) {
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
    location: "The lobby & voice channel",
    capacity: 10,
    status: "published",
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
    createdAt: start,
    updatedAt: start,
    ...over,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    // The going-count aggregate reads two positional columns; the viewer
    // answer read selects its own row and is empty in this fixture.
    if (sql.includes('from "rsvps"'))
      return sql.includes("count(*)") ? { rows: [[row.id, going]] } : { rows: [] };
    // Neighbor, related and waitlist reads are empty in this fixture.
    if (sql.includes('"event_key" =')) {
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
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    env,
    async cookie() {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000001",
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
    },
    request(cookie?: string, path = PATH) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

describe("Event page spots-left and capacity display (fixture-only)", () => {
  it("shows seats remaining with the cap number, never a mystery number", async () => {
    const source = fixture({ capacity: 10 }, 3);
    const response = await source.request(await source.cookie());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain('data-testid="event-going-count"');
    expect(html).toContain('data-capacity="10"');
    expect(html).toContain("<span data-count>3 of 10 going</span>");
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">7 of 10 spots left</span>");
    expect(html).toContain('data-testid="rsvp-going"');
    expect(html).not.toContain('data-testid="event-full"');
  });

  it("shows Full with the cap beside it when going reaches capacity", async () => {
    const source = fixture({ capacity: 4 }, 4);
    const response = await source.request(await source.cookie());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<span data-count>4 of 4 going</span>");
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">Full</span>");
    expect(html).toContain("This one&#39;s full. Cap is 4.");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
  });

  it("clamps over-capacity to Full and offers the waitlist, never a going button", async () => {
    const source = fixture({ capacity: 4 }, 6);
    const response = await source.request(await source.cookie());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<span data-count>6 of 4 going</span>");
    expect(html).toContain(">Full</span>");
    expect(html).toContain("This one&#39;s full. Cap is 4.");
    expect(html).toContain('data-testid="waitlist-join"');
    expect(html).not.toContain('data-testid="rsvp-going"');
  });

  it("shows a bare count with no cap for unlimited capacity", async () => {
    const source = fixture({ capacity: null }, 3);
    const response = await source.request(await source.cookie());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-capacity=""');
    expect(html).toContain("<span data-count>3 going</span>");
    expect(html).not.toContain('data-testid="event-spots-left"');
    expect(html).not.toContain("spots left");
    expect(html).not.toContain("Cap is");
    expect(html).toContain('data-testid="rsvp-going"');
    expect(html).not.toContain('data-testid="event-full"');
  });

  it("shows the empty count with a full allocation when nobody is going", async () => {
    const source = fixture({ capacity: 10 }, 0);
    const response = await source.request(await source.cookie());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<span data-count>0 of 10 going</span>");
    expect(html).toContain(">10 of 10 spots left</span>");
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).toContain('data-testid="rsvp-going"');
  });
});
