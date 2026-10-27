// Schedule member-nav pin: members keep Open Discord and gain no board link.
//
// ScheduleShell gates members away from the header session
// (`session={member ? undefined : session}`), because SiteHeader renders the
// Leaderboard link for any session with member=true. These pins render the
// real member /events output on both stacks with a real member session behind
// a signed cookie and assert the primary nav carries no board link. The
// control below proves the assertion bites: the same member session renders
// the link when it reaches the header, so deleting the gate turns these red.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

const APP_URL = "https://schedule-nav-pin.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER = "schedule-nav-member";
const BOARD_LINK = 'href="/leaderboards/members"';

type EventRow = typeof events.$inferSelect;

function fakeDb() {
  const row: EventRow = {
    icsSequence: 1n,
    id: 1,
    eventKey: "schedule-nav-pin-upcoming",
    title: "Schedule nav pin night",
    game: null,
    description: null,
    startsAt: new Date(Date.UTC(2030, 0, 10, 20)),
    endsAt: new Date(Date.UTC(2030, 0, 10, 22)),
    timezone: "Europe/London",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
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
    createdAt: new Date(Date.UTC(2030, 0, 1)),
    updatedAt: new Date(Date.UTC(2030, 0, 1)),
    syncRevision: 1,
    syncedRevision: 0,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (r: EventRow) =>
    columns.map((key) => (r[key] instanceof Date ? (r[key] as Date).toISOString() : r[key]));
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('select distinct trim("game")')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (sql.startsWith('insert into "event_search_log"') || sql.startsWith("SET LOCAL")) {
      return { rows: [] };
    }
    if (!sql.includes('from "events"')) throw new Error(`Unexpected schedule query: ${sql}`);
    if (/^select count/i.test(sql)) return { rows: [[1]] };
    if (sql.includes("limit")) return { rows: [encode(row)].slice(0, Number(params.at(-1))) };
    return { rows: [encode(row)] };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) =>
      fn({
        execute: async () => ({ rows: [] }),
        insert: () => ({ values: async () => undefined }),
      } as unknown as Db),
  });
  return db;
}

async function memberCookie() {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: `schedule-${MEMBER}`,
    username: MEMBER,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  return { store, cookie };
}

function envFor(store: unknown): Env {
  return {
    APP_URL,
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_SECRET,
    ADMIN_DB: fakeDb() as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    SESSION_STORE: store,
  } as unknown as Env;
}

function primaryNavOf(html: string): string {
  const nav = html.match(/<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) throw new Error("Primary nav is missing from the schedule render");
  return nav[1]!;
}

async function kitMemberRender() {
  const { store, cookie } = await memberCookie();
  const env = envFor(store);
  const url = new URL("/events", APP_URL);
  const request = new Request(url, { headers: { cookie } });
  const collected: Record<string, string> = {};
  const data = await loadEventsPage({
    env,
    url,
    method: "GET",
    island: false,
    request,
    setHeaders: (next) => Object.assign(collected, next),
    deleteJoinCookie: () => {},
    dbForFn: async () => (env as unknown as { ADMIN_DB: Db }).ADMIN_DB,
    sessionForFn: kitEventsSessionFor(env),
    journeyForFn: kitEventsJourneyFor(env),
    discordForFn: () => (env as unknown as { DISCORD_EVENTS: never }).DISCORD_EVENTS,
  });
  const rendered = await renderEventsHtml(data as never, collected);
  return { data, body: rendered.body };
}

beforeEach(() => {
  __resetAnonEventCacheForTests();
});

describe("schedule member nav carries no board link", () => {
  it("omits the board link from the Hono member render", async () => {
    const { store, cookie } = await memberCookie();
    const res = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(primaryNavOf(html)).toContain('<a href="/events"');
    expect(primaryNavOf(html)).not.toContain(BOARD_LINK);
    expect(html).not.toContain(BOARD_LINK);
    expect(html).toContain('<a class="btn" href="/discord">Open Discord</a>');
  });

  it("omits the board link from the Kit member render", async () => {
    const { body } = await kitMemberRender();
    expect(primaryNavOf(body)).toContain('<a href="/events"');
    expect(primaryNavOf(body)).not.toContain(BOARD_LINK);
    expect(body).not.toContain(BOARD_LINK);
    expect(body).toContain('<a class="btn" href="/discord">Open Discord</a>');
  });

  it("control: the same member session renders the link when it reaches the header", async () => {
    const { data } = await kitMemberRender();
    // Inconsistent on purpose: production derives member from the session, so
    // only a deleted shell gate lets a member session reach SiteHeader here.
    const rendered = await renderEventsHtml({ ...data, member: false } as never, {});
    expect(primaryNavOf(rendered.body)).toContain(BOARD_LINK);
  });
});
