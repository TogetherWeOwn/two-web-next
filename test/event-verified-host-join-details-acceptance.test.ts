// Acceptance contract for optional public event organizer and joining details.
// These tests use a local pg-proxy fixture through the real Hono detail route;
// no database connection, production/staging data, or network calls are made.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const START = new Date("2030-01-10T20:00:00Z");

// New public fields are carried as string-keyed fixture data so this acceptance
// suite compiles before their schema and route implementation are added.
function fixture(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: START,
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
    createdAt: START,
    updatedAt: START,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    ...over,
  };
  const row: typeof events.$inferSelect = values as typeof events.$inferSelect;
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const queries: string[] = [];
  const db = drizzle(async (sql) => {
    queries.push(sql);
    if (sql.includes('from "rsvps"') && sql.includes("count(*)")) {
      if (sql.includes('left join "users"') && sql.includes("group by"))
        return { rows: [[row.id, 3, 3]] };
      return { rows: [[row.id, 3]] };
    }
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) => (row[key] instanceof Date ? row[key]!.toISOString() : row[key])),
        ],
      };
    }
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET,
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    env,
    queries,
    async cookie(moderator = false) {
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000001",
        username: "member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    },
    request: (path = PATH, cookie?: string) =>
      app.request(path, cookie ? { headers: { cookie } } : {}, env),
    async create(fields: Record<string, string>) {
      return app.request(
        "/admin/events",
        {
          method: "POST",
          headers: {
            cookie: await this.cookie(true),
            origin: APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
        },
        env,
      );
    },
  };
}

describe("event public host and join-details acceptance", () => {
  it("renders optional organizer text and verified joining information safely", async () => {
    const response = await fixture({
      organizer_name: 'Riley <img src=x onerror="alert(1)"> & friends',
      join_url: "https://meet.example.test/room-42",
      join_instructions: "Use the public lobby; do not share attendee links.",
    }).request();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Riley &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; friends");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain('href="https://meet.example.test/room-42"');
    expect(html).toContain("Use the public lobby; do not share attendee links.");
    expect(html).toContain('data-testid="event-ics"');
    expect(html).toContain("3 of 10 going");
    expect(html).not.toContain("private-attendee");
  });

  it("keeps the existing detail output when the optional public fields are empty", async () => {
    const html = await (await fixture().request()).text();
    expect(html).toContain('data-testid="event-venue">The lobby');
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).not.toContain('data-testid="event-organizer"');
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain('data-testid="event-public-join-link"');
  });

  it.each([
    ["unsupported URL scheme", { organizer_name: "Riley", join_url: "javascript:alert(1)" }],
    ["malformed URL", { organizer_name: "Riley", join_url: "https://" }],
    ["overlong organizer name", { organizer_name: "x".repeat(501), join_url: "" }],
    [
      "overlong join instructions",
      { organizer_name: "Riley", join_instructions: "x".repeat(5001) },
    ],
  ])("rejects %s before persisting", async (_name, extra) => {
    const source = fixture();
    const response = await source.create({
      title: "Chess night",
      game: "Chess",
      description: "Bring a friend",
      starts_at: "2030-01-10 20:00",
      ends_at: "2030-01-10 22:00",
      timezone: "UTC",
      location: "The lobby",
      capacity: "10",
      ...extra,
    });
    expect(source.queries.some((sql) => /insert into "events"|update "events"/i.test(sql))).toBe(
      false,
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    // Purpose/accessibility retention is owned by their own cards, not pinned here.
    expect(html).toContain('data-testid="form-errors"');
  });

  it("keeps a draft moderator-only even when it contains public join details", async () => {
    const source = fixture({
      status: "draft",
      organizer_name: "Draft organizer",
      join_url: "https://meet.example.test/draft-room",
      join_instructions: "Draft instructions",
    });
    expect((await source.request()).status).toBe(403);
    const modResponse = await source.request(PATH, await source.cookie(true));
    const html = await modResponse.text();
    expect(modResponse.status).toBe(200);
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain("Draft organizer");
    expect(html).not.toContain('data-testid="event-public-join-link"');
  });
});
