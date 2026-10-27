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
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const FRAGMENT_HEADERS = { "x-two-island": "attendees-live" };

// Same fixture shape as test/event-page.test.ts: real Drizzle queries and
// Hono/session rendering; all data is local, no DB connection.
function fixture(over: Partial<typeof events.$inferSelect> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend.",
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
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      if (sql.includes('left join "users"') && sql.includes("group by"))
        return { rows: [[row.id, 3, 3]] };
      return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    }
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
    env,
    store,
    async cookie() {
      const token = newSessionToken();
      const tokenHash = await hashToken(token);
      await store.create({
        tokenHash,
        userId: "100000000000000001",
        username: "member",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const signed = (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      return { cookie: signed, tokenHash };
    },
  };
}

describe("attendees-live fragment session", () => {
  it("serves the member roster section without rotating the session bearer", async () => {
    const source = fixture();
    const auth = await source.cookie();
    const fragment = await app.request(
      `${PATH}?attendees=2`,
      {
        headers: { cookie: auth.cookie, ...FRAGMENT_HEADERS },
      },
      source.env,
    );
    expect(fragment.status).toBe(200);
    expect(fragment.headers.get("cache-control")).toBe("private, no-store");
    const html = await fragment.text();
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).not.toContain('data-testid="event-join-pitch"');
    // Non-rotating: no replacement cookie or reliance on predecessor grace
    // when the fragment races a plain page reload.
    expect(fragment.headers.get("set-cookie")).toBeNull();
    expect(await source.store.get(auth.tokenHash)).not.toBeNull();
    const page = await app.request(
      PATH,
      {
        headers: { cookie: auth.cookie },
      },
      source.env,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toContain("__Host-two_session=");
    expect(await source.store.get(auth.tokenHash)).toMatchObject({ member: true });
    expect(await source.store.statusHash(auth.tokenHash)).toBeNull();
  });

  it("still rotates plain page views and unknown island headers", async () => {
    const source = fixture();
    const plain = await app.request(
      PATH,
      {
        headers: { cookie: (await source.cookie()).cookie },
      },
      source.env,
    );
    expect(plain.headers.get("set-cookie")).toContain("__Host-two_session=");
    const other = await app.request(
      PATH,
      {
        headers: { cookie: (await source.cookie()).cookie, "x-two-island": "events-calendar" },
      },
      source.env,
    );
    expect(other.headers.get("set-cookie")).toContain("__Host-two_session=");
  });

  it("renders guests as guests on fragment reads with dead bearers", async () => {
    const source = fixture();
    const auth = await source.cookie();
    await source.store.revoke(auth.tokenHash);
    const fragment = await app.request(
      PATH,
      {
        headers: { cookie: auth.cookie, ...FRAGMENT_HEADERS },
      },
      source.env,
    );
    expect(fragment.status).toBe(200);
    expect(await fragment.text()).toContain('data-testid="event-join-pitch"');
    expect(fragment.headers.get("set-cookie")).toBeNull();
  });
});
