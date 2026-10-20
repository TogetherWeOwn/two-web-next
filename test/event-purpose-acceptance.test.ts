// Acceptance-owned coverage for the optional event-purpose field.
import { eq, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog, events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { dispatchWriteBack } from "../src/admin/writeback";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const PURPOSE_MAX = 1000;
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};
const moderator = { userId: "100000000000000111", username: "mod", moderator: true };

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
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
}

const eventFields = () => ({
  title: "Go night",
  game: "Go",
  description: "Bring a board and meet other players.",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
  timezone: "UTC",
  location: "Community voice",
  capacity: "8",
});

describe.skipIf(!process.env.DATABASE_URL)("moderator event purpose (disposable Postgres)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let cookie = "";
  const store = createMemorySessionStore();
  const liveEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as Env;
  const admin = () => adminApp(store);
  const form = (fields: Record<string, string>) => ({
    method: "POST" as const,
    headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    cookie = await cookieFor(store, moderator);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fixture.reset();
    vi.useRealTimers();
  });

  const savedEvent = async (key: string) =>
    (await db.select().from(events).where(eq(events.eventKey, key)))[0]!;
  const snapshot = async () => ({
    events: await db.select().from(events),
    audits: await db.select().from(activityLog),
  });
  const createEvent = async (purpose?: string) => {
    const fields = { ...eventFields(), ...(purpose === undefined ? {} : { purpose }) };
    const response = await admin().request("/events", form(fields), liveEnv());
    expect(response.status).toBe(303);
    return new URL(response.headers.get("location")!, APP_URL).pathname.split("/").pop()!;
  };

  it("creates and edits purpose with a database and moderator-form round-trip", async () => {
    const createdPurpose = "A relaxed introduction for new Go players.";
    const create = await admin().request(
      "/events",
      form({ ...eventFields(), purpose: createdPurpose }),
      liveEnv(),
    );
    expect(create.status).toBe(303);
    const key = new URL(create.headers.get("location")!, APP_URL).pathname.split("/").pop()!;

    expect((await savedEvent(key)) as unknown as Record<string, unknown>).toMatchObject({
      purpose: createdPurpose,
      description: eventFields().description,
    });

    const editPage = await admin().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
    expect(editPage.status).toBe(200);
    const editHtml = await editPage.text();
    expect(editHtml).toContain('name="purpose"');
    expect(editHtml).toContain(createdPurpose);

    const editedPurpose = "Bring a friend who has never played before.";
    const edit = await admin().request(
      `/events/${key}`,
      form({ ...eventFields(), title: "Go night updated", purpose: editedPurpose }),
      liveEnv(),
    );
    expect(edit.status).toBe(303);
    expect((await savedEvent(key)) as unknown as Record<string, unknown>).toMatchObject({
      title: "Go night updated",
      purpose: editedPurpose,
      description: eventFields().description,
    });
  });

  it("leaves an omitted purpose null for an event created without the new field", async () => {
    const key = await createEvent();
    const row = (await savedEvent(key)) as unknown as Record<string, unknown>;
    expect(row).toHaveProperty("purpose", null);

    const editPage = await admin().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
    expect(editPage.status).toBe(200);
    const editHtml = await editPage.text();
    expect(editHtml).toContain('name="purpose"');
    expect(editHtml).not.toContain("A relaxed introduction");
  });

  it("refuses an overlong purpose on create without event or audit writes", async () => {
    const before = await snapshot();
    const response = await admin().request(
      "/events",
      form({ ...eventFields(), purpose: "p".repeat(PURPOSE_MAX + 1) }),
      liveEnv(),
    );

    expect(response.status).toBe(422);
    expect(await snapshot()).toEqual(before);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("refuses an overlong purpose on edit without changing the event or audit", async () => {
    const key = await createEvent("Existing purpose");
    vi.clearAllMocks();
    const before = await snapshot();
    const response = await admin().request(
      `/events/${key}`,
      form({ ...eventFields(), purpose: "p".repeat(PURPOSE_MAX + 1) }),
      liveEnv(),
    );

    expect(response.status).toBe(422);
    expect(await snapshot()).toEqual(before);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });
});

type EventWithPurpose = typeof events.$inferSelect & { purpose: string | null };

function detailFixture(over: Partial<EventWithPurpose> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: EventWithPurpose = {
    id: 1,
    icsSequence: 1n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    purpose: null,
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
  const columns = Object.keys(getTableColumns(events)) as (keyof EventWithPurpose)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [[row.id, 3]] };
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
    SESSION_SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return { row, env, request: (path = `/e/${row.eventKey}`) => app.request(path, {}, env) };
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

describe("public event purpose (fixture-only)", () => {
  it("renders the labelled purpose escaped and preserves the existing description", async () => {
    const purpose = `A welcoming intro & "practice" <script>alert('x')</script>`;
    const source = detailFixture({ purpose });
    const response = await source.request();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Purpose");
    expect(html).toContain(escapeHtml(purpose));
    expect(html).not.toContain("<script>alert('x')</script>");
    expect(html).toContain("Bring a friend &amp; a board.");
  });

  it.each([null, "", " \t\n "])(
    "omits blank purpose %s and keeps the description",
    async (purpose) => {
      const source = detailFixture({ purpose });
      const response = await source.request();
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).not.toContain("Purpose");
      expect(html).toContain("Bring a friend &amp; a board.");
    },
  );
});
