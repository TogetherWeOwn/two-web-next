// Schedule account chrome acceptance: who the /events header names per viewer.
//
// The schedule shell renders three header states: guests see the sign-in call
// to action, signed-in non-members see their username with a sign-out control,
// and members keep the Open Discord shortcut. The past archive keeps its
// session-free guest header for every viewer, and the native Kit list renders
// the same header bytes as Hono for the same viewer.
//
// Mounted app through the real routes on a pg-proxy fake: no database, no
// browser, no live Discord reads. Sessions are real memory-store rows behind
// signed cookies; the Kit renders go through the real session bridge, list
// load and HTML renderer. No token/secret echo.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import {
  addCalendarMonth,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  calendarMonthLabel,
} from "../src/islands/contracts";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

const APP_URL = "https://schedule-chrome.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const NON_MEMBER = "schedule-alice";
const MEMBER = "schedule-bob";

// Pinned header bytes. The guest and member branches are byte-identical to the
// current render; the non-member branch is the shared signed-in session shape
// (same markup every other session-aware shell renders).
const GUEST_HEADER =
  '<nav class="header-account" aria-label="Account"><div>' +
  '<span class="account-caption">Welcome, guest</span>' +
  '<a class="btn" href="/auth/discord?next=%2Fevents" data-testid="signin">Sign in with Discord</a>' +
  "</div></nav>";
const memberHeader = (username: string) =>
  '<nav class="header-account" aria-label="Account">' +
  '<form method="post" action="/logout">' +
  '<span class="account-caption">Signed in</span>' +
  `<span class="who">${username}</span>` +
  '<button type="submit" class="link">Sign out</button>' +
  "</form></nav>";
const MEMBER_HEADER =
  '<nav class="header-account" aria-label="Account">' +
  '<a class="btn" href="/discord">Open Discord</a></nav>';
const PAST_GUEST_HEADER =
  '<nav class="header-account" aria-label="Account"><div>' +
  '<span class="account-caption">Welcome, guest</span>' +
  '<a class="btn" href="/auth/discord?next=%2Fevents%2Fpast" data-testid="signin">Sign in with Discord</a>' +
  "</div></nav>";

type EventRow = typeof events.$inferSelect;

function eventRow(over: Partial<EventRow> & { id: number; eventKey: string }): EventRow {
  const start = over.startsAt ?? new Date(Date.UTC(2030, 0, 10, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    icsSequence: 1n,
    title: `Game night ${over.id}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
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
    createdAt: start,
    updatedAt: start,
    syncRevision: 1,
    syncedRevision: 0,
    ...over,
  };
}

const UPCOMING = eventRow({ id: 1, eventKey: "schedule-chrome-upcoming" });
const PAST = eventRow({
  id: 2,
  eventKey: "schedule-chrome-past",
  startsAt: new Date(Date.UTC(2020, 0, 10, 20)),
  endsAt: new Date(Date.UTC(2020, 0, 10, 22)),
});

function fakeDb() {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((key) => (row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]));
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('select distinct trim("game")')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (sql.startsWith('insert into "event_search_log"') || sql.startsWith("SET LOCAL")) {
      return { rows: [] };
    }
    if (!sql.includes('from "events"')) throw new Error(`Unexpected schedule query: ${sql}`);
    const pastQuery = /"ends_at" </.test(sql) || params.includes("past");
    const matching = pastQuery ? [PAST] : [UPCOMING];
    if (/^select count/i.test(sql)) return { rows: [[matching.length]] };
    if (sql.includes("offset")) {
      const offset = Number(params.at(-1));
      return { rows: matching.slice(offset, offset + Number(params.at(-2))).map(encode) };
    }
    if (sql.includes("limit"))
      return { rows: matching.slice(0, Number(params.at(-1))).map(encode) };
    return { rows: matching.map(encode) };
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

const discordStub: DiscordEventsSource = {
  upcoming: async () => [],
  lastReadFailed: () => false,
};

async function viewerCookie(username: string, member: boolean) {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: `schedule-${username}`,
    username,
    avatar: null,
    member,
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

function envFor(store?: unknown): Env {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    ADMIN_DB: fakeDb() as unknown as Db,
    DISCORD_EVENTS: discordStub,
    ...(store ? { SESSION_STORE: store } : {}),
  } as unknown as Env;
}

function headerAccount(html: string): string {
  const match = html.match(/<nav class="header-account"[\s\S]*?<\/nav>/);
  if (!match) throw new Error("Schedule header account block missing from render");
  return match[0];
}

async function kitRender(
  path: string,
  viewer?: "nonmember" | "member",
): Promise<{ body: string; headers: Record<string, string> }> {
  const session =
    viewer === undefined
      ? { store: createMemorySessionStore(), cookie: null as string | null }
      : await viewerCookie(viewer === "member" ? MEMBER : NON_MEMBER, viewer === "member").then(
          ({ store, cookie }) => ({ store, cookie: cookie as string | null }),
        );
  const env = envFor(session.store);
  const url = new URL(path, APP_URL);
  const request = new Request(url, session.cookie ? { headers: { cookie: session.cookie } } : {});
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
    discordForFn: () => discordStub,
  });
  const rendered = await renderEventsHtml(data as never, collected);
  return { body: rendered.body, headers: collected };
}

beforeEach(() => {
  __resetAnonEventCacheForTests();
});

describe("schedule header account chrome", () => {
  it("renders the guest branch byte-identical", async () => {
    const res = await app.request("/events", {}, envFor());
    expect(res.status).toBe(200);
    expect(headerAccount(await res.text())).toBe(GUEST_HEADER);
  });

  it("keeps Open Discord for members", async () => {
    const { store, cookie } = await viewerCookie(MEMBER, true);
    const res = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(headerAccount(html)).toBe(MEMBER_HEADER);
    expect(html).not.toContain(MEMBER);
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Welcome, guest");
  });

  it("names the signed-in non-member with a sign-out control", async () => {
    const { store, cookie } = await viewerCookie(NON_MEMBER, false);
    const res = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(headerAccount(html)).toContain("Signed in");
    expect(headerAccount(html)).toContain(NON_MEMBER);
    expect(headerAccount(html)).toContain("Sign out");
    expect(headerAccount(html)).toContain('action="/logout"');
  });

  it("renders the non-member branch byte-identical to the session shape", async () => {
    const { store, cookie } = await viewerCookie(NON_MEMBER, false);
    const res = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(res.status).toBe(200);
    expect(headerAccount(await res.text())).toBe(memberHeader(NON_MEMBER));
  });

  it("offers the non-member no guest or member action", async () => {
    const { store, cookie } = await viewerCookie(NON_MEMBER, false);
    const res = await app.request("/events", { headers: { cookie } }, envFor(store));
    expect(res.status).toBe(200);
    const header = headerAccount(await res.text());
    expect(header).not.toContain("Welcome, guest");
    expect(header).not.toContain("Sign in with Discord");
    expect(header).not.toContain("Open Discord");
  });

  it("leaks no session or secret into any header branch", async () => {
    const guest = await app.request("/events", {}, envFor());
    expect(await guest.text()).not.toContain(SESSION_SECRET);
    const { store: nmStore, cookie: nmCookie } = await viewerCookie(NON_MEMBER, false);
    const nm = await app.request("/events", { headers: { cookie: nmCookie } }, envFor(nmStore));
    expect(await nm.text()).not.toContain(SESSION_SECRET);
    const { store: mStore, cookie: mCookie } = await viewerCookie(MEMBER, true);
    const mem = await app.request("/events", { headers: { cookie: mCookie } }, envFor(mStore));
    expect(await mem.text()).not.toContain(SESSION_SECRET);
  });
});

describe("schedule cache matrix", () => {
  it("serves anonymous renders public with island variance", async () => {
    const res = await app.request("/events", {}, envFor());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toBe("Cookie, X-Two-Island");
  });

  it("serves signed-in renders private without a shared entry", async () => {
    const { store: nmStore, cookie: nmCookie } = await viewerCookie(NON_MEMBER, false);
    const nm = await app.request("/events", { headers: { cookie: nmCookie } }, envFor(nmStore));
    expect(nm.headers.get("cache-control")).toBe("private, no-store");
    const { store: mStore, cookie: mCookie } = await viewerCookie(MEMBER, true);
    const mem = await app.request("/events", { headers: { cookie: mCookie } }, envFor(mStore));
    expect(mem.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps anonymous searches private", async () => {
    const res = await app.request("/events?q=chess", {}, envFor());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the past archive publicly cacheable for browsing", async () => {
    const res = await app.request("/events/past", {}, envFor());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("vary")).toBe("Cookie");
  });

  it("keeps past-archive searches private with no variance", async () => {
    const res = await app.request("/events/past?q=chess", {}, envFor());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBeNull();
  });
});

describe("schedule no-script render", () => {
  it("filters through a plain GET form with a submit control", async () => {
    const res = await app.request("/events", {}, envFor());
    const html = await res.text();
    expect(html).toContain('<form method="get" action="/events" role="search">');
    expect(html).toContain('data-testid="events-search"');
    expect(html).toContain('<button class="btn" type="submit">');
  });

  it("toggles views and opens the archive through real anchors", async () => {
    const res = await app.request("/events", {}, envFor());
    const html = await res.text();
    const listToggle = html.match(/<a\b[^>]*data-testid="events-view-list"[^>]*>/)?.[0] ?? "";
    const calendarToggle =
      html.match(/<a\b[^>]*data-testid="events-view-calendar"[^>]*>/)?.[0] ?? "";
    // List is the default view, so its toggle is the bare collection path.
    expect(listToggle).toMatch(/href="\/events"/);
    expect(listToggle).toContain('aria-current="page"');
    expect(calendarToggle).toMatch(/href="\/events\?[^"]*view=calendar[^"]*"/);
    expect(html).toContain('data-testid="events-past-archive-link"');
    expect(html).toContain('data-testid="events-past-toggle"');
  });

  it("turns calendar months through real anchors", async () => {
    const res = await app.request("/events?view=calendar&month=2030-01", {}, envFor());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(calendarMonthLabel("2030-01"));
    const prev = addCalendarMonth("2030-01", -1);
    const next = addCalendarMonth("2030-01", 1);
    expect(html).toContain(`month=${prev}`);
    expect(html).toContain(`month=${next}`);
    const navLinks = html.match(/<a\b[^>]*aria-label="(Previous|Next) month"[^>]*>/g) ?? [];
    expect(navLinks).toHaveLength(2);
    for (const link of navLinks) {
      expect(link).toMatch(/href="\/events\?[^"]*month=\d{4}-\d{2}[^"]*"/);
      expect(link).not.toMatch(/disabled|aria-disabled/i);
    }
    expect(html).toContain(`aria-label="${CALENDAR_PREV_LABEL}"`);
    expect(html).toContain(`aria-label="${CALENDAR_NEXT_LABEL}"`);
  });

  it("ships no inline script hooks on the schedule surface", async () => {
    for (const path of ["/events", "/events?view=calendar&month=2030-01", "/events/past"]) {
      const res = await app.request(path, {}, envFor());
      expect(await res.text()).not.toMatch(/\son(?:click|submit|change|keydown)=/i);
    }
  });
});

describe("past archive chrome pin", () => {
  it("renders the guest branch byte-identical", async () => {
    const res = await app.request("/events/past", {}, envFor());
    expect(res.status).toBe(200);
    expect(headerAccount(await res.text())).toBe(PAST_GUEST_HEADER);
  });

  it("keeps the guest branch for signed-in viewers", async () => {
    const { store: nmStore, cookie: nmCookie } = await viewerCookie(NON_MEMBER, false);
    const nm = await app.request(
      "/events/past",
      { headers: { cookie: nmCookie } },
      envFor(nmStore),
    );
    expect(nm.status).toBe(200);
    const nmHtml = await nm.text();
    expect(headerAccount(nmHtml)).toBe(PAST_GUEST_HEADER);
    expect(nmHtml).not.toContain(NON_MEMBER);
    const { store: mStore, cookie: mCookie } = await viewerCookie(MEMBER, true);
    const mem = await app.request("/events/past", { headers: { cookie: mCookie } }, envFor(mStore));
    expect(mem.status).toBe(200);
    const memHtml = await mem.text();
    expect(headerAccount(memHtml)).toBe(PAST_GUEST_HEADER);
    expect(memHtml).not.toContain("Open Discord");
  });

  it("still lists past rows beneath the pinned header", async () => {
    const res = await app.request("/events/past", {}, envFor());
    const html = await res.text();
    expect(html).toContain('data-event-key="schedule-chrome-past"');
    expect(html).toContain("Game night 2");
  });
});

describe("native list header parity", () => {
  it("matches the guest bytes", async () => {
    const rendered = await kitRender("/events");
    expect(headerAccount(rendered.body)).toBe(GUEST_HEADER);
  });

  it("matches the member bytes", async () => {
    const rendered = await kitRender("/events", "member");
    expect(headerAccount(rendered.body)).toBe(MEMBER_HEADER);
  });

  it("names the signed-in non-member with a sign-out control", async () => {
    const rendered = await kitRender("/events", "nonmember");
    const header = headerAccount(rendered.body);
    expect(header).toContain("Signed in");
    expect(header).toContain(NON_MEMBER);
    expect(header).toContain("Sign out");
  });

  it("renders the non-member branch byte-identical to the session shape", async () => {
    const rendered = await kitRender("/events", "nonmember");
    expect(headerAccount(rendered.body)).toBe(memberHeader(NON_MEMBER));
  });

  it("mirrors the cache matrix per viewer", async () => {
    const guest = await kitRender("/events");
    expect(guest.headers["cache-control"]).toBe("public, max-age=60");
    const nonmember = await kitRender("/events", "nonmember");
    expect(nonmember.headers["cache-control"]).toBe("private, no-store");
    const member = await kitRender("/events", "member");
    expect(member.headers["cache-control"]).toBe("private, no-store");
  });

  it("carries the no-script controls", async () => {
    const rendered = await kitRender("/events");
    expect(rendered.body).toContain('<form method="get" action="/events" role="search">');
    expect(rendered.body).toContain('data-testid="events-view-list"');
    expect(rendered.body).toContain('data-testid="events-view-calendar"');
  });
});
