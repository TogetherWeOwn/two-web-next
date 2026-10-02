// W15 series-child variant: legacy Integration/EndedDraftSeriesPublicationTest.
// A1 (TOG-10813) proved ended-draft refusal for ordinary events in
// test/event-mutation-invariants.test.ts; this suite proves the same
// transitionEvent guard covers series parents and series children through the
// identical path: publish of an ended-draft series parent refuses with the
// exact legacy reason, never materialises or announces children, and
// cancellation stays legal. Test-only: no src change expected.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { getEvent } from "../src/admin/store";
import { newEventKey } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = new Date("2026-09-30T12:00:00Z");
const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const ENDED = "An event that has already ended cannot be published. Update its dates first.";
const ACTOR = { id: "moderator", username: "mod" };

describe("series-ended-draft test containment", () => {
  it("refuses a non-test database before constructing a driver", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/events", {})).toThrow("refusing before connecting");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("series ended-draft publication (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore(() => Date.now());
  const sent: SyncMessage[] = [];
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    get ADMIN_DB() { return fixture.db; },
    SESSION_STORE: store,
    EVENT_SYNC_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) },
  } as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    sent.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await fixture?.dispose(); });

  async function cookieFor(userId = ACTOR.id, moderator = true): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId, username: userId, avatar: null,
      member: true, moderator, expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  }

  async function json(method: string, path: string, body?: unknown, member?: string): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        cookie: await cookieFor(member, member === undefined), origin: APP_URL,
        accept: "application/json", "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
  }
  async function browser(path: string, values?: Record<string, string>): Promise<Response> {
    return adminApp({ sessionStore: store, db: fixture.db }).request(path, {
      method: "POST",
      headers: { cookie: await cookieFor(), origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: values === undefined ? undefined : new URLSearchParams(values),
    }, env);
  }
  /** An ended-draft weekly series parent with no children yet (index 1). */
  async function seedParent(over: Partial<typeof events.$inferInsert> = {}) {
    const [row] = await fixture.db.insert(events).values({
      eventKey: newEventKey(), title: "Sunday Squad",
      startsAt: new Date(NOW.getTime() - 2 * 3600_000),
      endsAt: new Date(NOW.getTime() - 1), timezone: "UTC", status: "draft", capacity: 8,
      recurrenceFrequency: "weekly", recurrenceCount: 3, recurrenceEndsOn: null, recurrenceIndex: 1,
      createdAt: NOW, updatedAt: NOW, ...over,
    }).returning();
    return row!;
  }
  /** An ended-draft child of the given parent (index 2). */
  async function seedChild(parent: typeof events.$inferSelect, over: Partial<typeof events.$inferInsert> = {}) {
    const [row] = await fixture.db.insert(events).values({
      eventKey: newEventKey(), title: parent.title,
      startsAt: new Date(parent.startsAt.getTime() + 7 * 24 * 3600_000),
      endsAt: new Date(parent.endsAt.getTime() + 7 * 24 * 3600_000),
      timezone: parent.timezone, status: "draft", capacity: parent.capacity,
      parentEventId: parent.id, recurrenceIndex: 2,
      createdAt: NOW, updatedAt: NOW, ...over,
    }).returning();
    return row!;
  }
  const state = async (key: string) => ({
    row: await getEvent(fixture.db, key),
    answers: await fixture.db.select().from(rsvps).orderBy(rsvps.id),
    audits: await fixture.db.select().from(activityLog).orderBy(activityLog.id),
  });
  const childrenOf = (id: number) => fixture.db.select().from(events).where(eq(events.parentEventId, id));

  it("POST publish refuses an ended-draft series parent with the legacy message and materialises nothing", async () => {
    const parent = await seedParent();
    const before = await state(parent.eventKey);
    const response = await json("POST", `/events/${parent.eventKey}/publish`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid", fields: { ends_at: ENDED } });
    // No mutation, no announcement, no write-back: the parent stays a draft and
    // the refused publish materialises no child rows of its own.
    expect(await state(parent.eventKey)).toEqual(before);
    expect(await childrenOf(parent.id)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("still allows POST cancel of an ended-draft series parent", async () => {
    const parent = await seedParent();
    expect((await json("POST", `/events/${parent.eventKey}/cancel`)).status).toBe(200);
    expect((await getEvent(fixture.db, parent.eventKey))?.status).toBe("cancelled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventKey: parent.eventKey, action: "event.cancel" });
  });

  it("POST publish refuses a series-child draft of an ended parent the same way", async () => {
    const parent = await seedParent();
    const child = await seedChild(parent, { endsAt: new Date(NOW.getTime() - 1) });
    const beforeParent = await state(parent.eventKey);
    const beforeChild = await state(child.eventKey);
    const response = await json("POST", `/events/${child.eventKey}/publish`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid", fields: { ends_at: ENDED } });
    // Neither the child nor its parent moves, and nothing is announced.
    expect(await state(child.eventKey)).toEqual(beforeChild);
    expect(await state(parent.eventKey)).toEqual(beforeParent);
    expect(sent).toEqual([]);
  });

  it("admin POST publish renders the expiry reason for an ended-draft series parent; admin cancel remains legal", async () => {
    const parent = await seedParent();
    const before = await state(parent.eventKey);
    const response = await browser(`/events/${parent.eventKey}/publish`);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(ENDED);
    expect(await state(parent.eventKey)).toEqual(before);
    expect(await childrenOf(parent.id)).toEqual([]);
    expect(sent).toEqual([]);
    expect((await browser(`/events/${parent.eventKey}/cancel`)).status).toBe(303);
    expect((await getEvent(fixture.db, parent.eventKey))?.status).toBe("cancelled");
  });
});
