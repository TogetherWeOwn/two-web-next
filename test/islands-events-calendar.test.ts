// EventsCalendar island drift tests (W10 slice 3, TOG-9840): contract pins,
// SSR state resolution through the real /events route on a pg-proxy fake, and
// binder-execution tests mirroring islands-past-events.test.ts. No database,
// no browser, no network — the Discord source comes through DISCORD_EVENTS.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { liveDiscordEventsSource, type DiscordEventsSource } from "../src/events/discord-transients";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_STATUS_TESTID,
  CALENDAR_MONTH_TESTID,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_ISLAND,
  EVENTS_CALENDAR_TESTID,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_EMPTY_COPY,
  EVENTS_EMPTY_ERROR_TESTID,
  EVENTS_EMPTY_GAP_ITEM_TESTID,
  EVENTS_EMPTY_GAP_TESTID,
  EVENTS_EMPTY_NEVER_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  EVENTS_GAP_LIST_LIMIT,
  EVENTS_LIST_TESTID,
  EVENTS_LOADING_TESTID,
  EVENTS_PAST_DRAWER_LIMIT,
  EVENTS_PAST_LIST_TESTID,
  EVENTS_PAST_STATUS_COPY,
  EVENTS_PAST_STATUS_TESTID,
  EVENTS_PAST_TOGGLE_TESTID,
  EVENTS_RETRY_TESTID,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  EVENTS_SEARCH_CLEAR_TESTID,
  EVENTS_SEARCH_DEBOUNCE_MS,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_STATUS_TESTID,
  EVENTS_SEARCH_TESTID,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_GROUP_LABEL,
  EVENTS_VIEW_LIST_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  EVENT_CANCELLED_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  POLLING,
  WEEKDAY_HEADINGS,
  addCalendarMonth,
  calendarEmptyState,
  calendarMonthLabel,
  calendarUrl,
  calendarZone,
  currentCalendarMonth,
  escapeLikeTerm,
  eventSearchLogEntry,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
  gridTitle,
  monthGrid,
  normalizeEventSearch,
  parseCalendarMonth,
  parseCalendarView,
  type CalendarState,
  type DiscordTransient,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const INVITE = "https://discord.gg/invite";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const binder = readFileSync(new NodeURL("../public/islands/events-calendar.js", import.meta.url), "utf8");

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: INVITE,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
} as unknown as Env;

let eventSeq = 0;
function eventRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2030, 0, 10 + n, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n, icsSequence: 1n, eventKey: `ev-${n}`, title: `Game night ${n}`, game: null, description: null,
    startsAt: start, endsAt: end, timezone: "Europe/London", location: null, capacity: null,
    status: "published", discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, rsvpOpen: true,
    recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
    parentEventId: null, recurrenceIndex: null, createdAt: start, updatedAt: start,
    ...over,
  };
}

function transient(id: string, start: Date, title = `Discord raid ${id}`): DiscordTransient {
  return {
    discordId: id, status: "scheduled", title, description: null, location: null,
    startsAt: start, endsAt: new Date(start.getTime() + 3600_000),
  };
}

const okSource = (rows: DiscordTransient[] = []): DiscordEventsSource => ({
  upcoming: async () => rows,
  lastReadFailed: () => false,
});
const failedSource = (): DiscordEventsSource => ({
  upcoming: async () => [],
  lastReadFailed: () => true,
});

// The fake answers upcoming vs past by the boundary operator in the SQL and
// returns empty aggregates for the grouped rsvps read.
function calendar(
  up: (typeof events.$inferSelect)[],
  past: (typeof events.$inferSelect)[],
  source: DiscordEventsSource,
  extraEnv: Record<string, unknown> = {},
) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const logs: { normalizedQuery: string; resultCount: number }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: typeof events.$inferSelect) =>
    columns.map((k) => {
      const v = row[k];
      return v instanceof Date ? v.toISOString() : v;
    });
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "rsvps"')) return { rows: [] };
    // Identity probes ignore search, visibility and the past drawer's limit.
    if (sql.startsWith('select "discord_event_id" from "events"')) {
      return { rows: [...up, ...past].filter((r) => params.includes(r.discordEventId)).map((r) => [r.discordEventId]) };
    }
    let rows = /"ends_at" </.test(sql) ? past : up;
    // The fake honors the draft clause: guest reads carry it, moderator reads don't.
    if (sql.includes("'draft'")) rows = rows.filter((r) => r.status !== "draft");
    // And the bound LIKE term: title/description ILIKE %term% (term arrives
    // LIKE-escaped — % → \% — so unescape before matching).
    const bound = params.find((p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"));
    if (bound) {
      const term = bound.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(term) || (r.description ?? "").toLowerCase().includes(term));
    }
    if (sql.includes("limit")) rows = rows.slice(0, Number(params.at(-1)));
    return { rows: rows.map(encode) };
  });
  // pg-proxy has no transactions; model the analytics write without a real DB.
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) => fn({
      execute: async () => {},
      insert: () => ({ values: async (row: (typeof logs)[number]) => { logs.push(row); } }),
    } as unknown as Db),
  });
  const env = { ...baseEnv, ...extraEnv, ADMIN_DB: db as unknown as Db, DISCORD_EVENTS: source } as unknown as Env;
  return { env, queries, logs, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

async function moderatorCookie(env: Record<string, unknown>): Promise<string> {
  const store = createMemorySessionStore();
  env.SESSION_STORE = store;
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "mod",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return cookie.split(";")[0]!;
}

const cardKeys = (html: string) => [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);
// hono JSX escapes ' as &#39; in rendered HTML — compare copy through it.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");

const fragmentHeaders = { "x-two-island": EVENTS_CALENDAR_ISLAND };

async function memberAuth(moderator = false, expiresAt = new Date(Date.now() + 3600_000)) {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({ tokenHash: hash, userId: "member", username: "member", avatar: null, member: true, moderator, expiresAt });
  const cookie = (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
  return { store, hash, cookie };
}

describe("EventsCalendar review regressions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the browser cookie valid when an authenticated fragment is cancelled before headers arrive", async () => {
    const auth = await memberAuth();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { entered = r; });
    let calls = 0;
    const source: DiscordEventsSource = {
      lastReadFailed: () => false,
      upcoming: async () => { if (++calls === 1) { entered(); await gate; } return []; },
    };
    const src = calendar([eventRow()], [], source, { SESSION_STORE: auth.store });
    const controller = new AbortController();
    const headers = { cookie: auth.cookie, ...fragmentHeaders };
    const first = src.request("/events?view=calendar", { headers, signal: controller.signal });
    await reached;
    controller.abort(); // The server may finish, but the browser discards its response/cookie.
    try {
      expect(await auth.store.get(auth.hash)).not.toBeNull();
      const second = await src.request("/events", { headers });
      expect(await second.text()).not.toContain('data-testid="signin"');
      expect(second.headers.get("set-cookie")).toBeNull();
      expect(second.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      release();
      expect((await first).headers.get("set-cookie")).toBeNull();
    }
  });

  it.each([false, true])("does not publicly cache any authenticated page or fragment (moderator=%s)", async (moderator) => {
    const auth = await memberAuth(moderator);
    const src = calendar([eventRow()], [], okSource(), { SESSION_STORE: auth.store });
    const fragment = await src.request("/events", { headers: { cookie: auth.cookie, ...fragmentHeaders } });
    expect(fragment.headers.get("cache-control")).toBe("private, no-store");
    expect(fragment.headers.get("set-cookie")).toBeNull();
    const page = await src.request("/events", { headers: { cookie: auth.cookie } });
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("set-cookie")).toContain("__Host-two_session=");
    expect(await auth.store.get(auth.hash)).toBeNull(); // Full-page rotation remains intact.
  });

  it("rejects revoked, expired and wrongly signed fragment cookies", async () => {
    const revoked = await memberAuth();
    await revoked.store.revoke(revoked.hash);
    const expired = await memberAuth(false, new Date(0));
    const wrong = await memberAuth();
    for (const auth of [revoked, expired, wrong]) {
      const cookie = auth === wrong ? auth.cookie + "tampered" : auth.cookie;
      const html = await (await calendar([eventRow()], [], okSource(), { SESSION_STORE: auth.store })
        .request("/events", { headers: { cookie, ...fragmentHeaders } })).text();
      expect(html).toContain('data-testid="signin"');
    }
  });

  it.each(["VOLLEYBALL", "100%_\\", "  chess  "])("applies the same literal title/description search to transients: %s", async (query) => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const matchingTitle = transient("title", new Date(Date.UTC(2030, 0, 12)), `Night ${query.trim().toLowerCase()}`);
    const matchingDescription = transient("description", new Date(Date.UTC(2030, 0, 13)), "Other night");
    matchingDescription.description = `Play ${query.trim().toLowerCase()} with us`;
    const unrelated = transient("unrelated", new Date(Date.UTC(2030, 0, 14)), "Unrelated night");
    const src = calendar([], [], okSource([matchingTitle, matchingDescription, unrelated]));
    const html = await (await src.request("/events?q=" + encodeURIComponent(query))).text();
    expect(cardKeys(html)).toEqual(["discord-title", "discord-description"]);
    expect(html).not.toContain("Unrelated night");
    expect(JSON.parse(String(spy.mock.calls.find((c) => c[0] === "event_search")![1]))).toEqual({
      event: "event_search", query: normalizeEventSearch(query), results: 2,
    });
    const miss = await (await src.request("/events?q=no-match")).text();
    expect(miss).toContain(EVENTS_EMPTY_SEARCH_TESTID);
    expect(cardKeys(miss)).toEqual([]);
    expect(JSON.parse(String(spy.mock.calls.at(-1)![1])).results).toBe(0);
  });

  it("links upcoming and past persisted titles to detail pages but keeps transients display-only", async () => {
    const up = eventRow({ eventKey: "up-link" });
    const past = eventRow({ eventKey: "past-link", startsAt: new Date(0), endsAt: new Date(1) });
    const html = await (await calendar([up], [past], okSource([transient("display", new Date(Date.UTC(2030, 0, 12)))])).request("/events?past=1")).text();
    expect(html).toContain('href="/e/up-link"');
    expect(html).toContain('href="/e/past-link"');
    expect(html).not.toContain('href="/e/discord-display"');
  });

  it("gives grid links a real SSR list destination retaining the drawer and card fragment", async () => {
    const e = eventRow({ eventKey: "grid-link", startsAt: new Date(Date.UTC(2030, 0, 15, 20)) });
    const src = calendar([e], [], okSource());
    const grid = await (await src.request("/events?view=calendar&month=2030-01&past=1")).text();
    expect(grid).toContain('href="/events?past=1#event-grid-link" data-cal-jump');
    const list = await (await src.request("/events?past=1")).text();
    expect(list).toContain('id="event-grid-link"');
  });

  it.each(["list", "calendar"])("marks the active %s navigation link with valid link ARIA", async (view) => {
    const html = await (await calendar([eventRow()], [], okSource()).request(`/events?view=${view}`)).text();
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain(`aria-current="page" data-testid="events-view-${view}"`);
    // Primary navigation also marks Events current; each navigation set has one active link.
    const views = html.match(/<div[^>]*aria-label="How to show the events"[^>]*>(.*?)<\/div>/)![1]!;
    expect(views.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("suppresses both the visible and live search miss when the read fails", async () => {
    const html = await (await calendar([], [], failedSource()).request("/events?q=x")).text();
    expect(html).toContain(EVENTS_EMPTY_ERROR_TESTID);
    expect(html).not.toContain(EVENTS_EMPTY_SEARCH_TESTID);
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_STATUS_TESTID}"></p>`);
    expect(html).not.toContain(eventsSearchMissCopy("x"));
  });
});

describe("EventsCalendar second-review regressions", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["title", "description", "draft", "past-limit"])("suppresses persisted identities independently of %s eligibility", async (variant) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const start = new Date(Date.UTC(2030, 0, 12));
    const canonical = eventRow({ eventKey: "canonical", title: "Go tournament", discordEventId: "same-id", startsAt: start });
    const stale = transient("same-id", start, "Chess tournament");
    if (variant === "description") { stale.title = "Other night"; stale.description = "Chess tournament"; }
    if (variant === "draft") { canonical.status = "draft"; canonical.title = "Chess draft"; }
    const past = variant === "past-limit"
      ? [...Array.from({ length: EVENTS_PAST_DRAWER_LIMIT }, () => eventRow({ title: "Chess archive", startsAt: new Date(0), endsAt: new Date(1) })),
        { ...canonical, title: "Chess canonical", startsAt: new Date(0), endsAt: new Date(1) }]
      : [];
    const src = calendar(variant === "past-limit" ? [] : [canonical], past, okSource([stale]));
    const html = await (await src.request("/events?q=chess")).text();
    expect(cardKeys(html)).not.toContain("discord-same-id");
    expect(cardKeys(html)).not.toContain("canonical");
    expect(cardKeys(html)).toHaveLength(variant === "past-limit" ? EVENTS_PAST_DRAWER_LIMIT : 0);
    if (variant !== "past-limit") expect(html).toContain(EVENTS_EMPTY_SEARCH_TESTID);
    expect(JSON.parse(String(log.mock.calls.find((c) => c[0] === "event_search")![1])).results)
      .toBe(variant === "past-limit" ? EVENTS_PAST_DRAWER_LIMIT : 0);
    const probe = src.queries.find((q) => q.sql.startsWith('select "discord_event_id" from "events"'))!;
    expect(probe.params).toEqual(["same-id"]);
    expect(probe.sql).not.toMatch(/ilike|draft|ends_at|limit/);
    expect(src.queries.some((q) => q.params.includes("%chess%"))).toBe(true);
  });

  it.each([
    [1, -3600_000, null, true], // Scheduled voice/stage events can have no end even after their nominal start.
    [2, -3600_000, null, true], // ACTIVE with no scheduled end must stay visible.
    [1, 3600_000, null, true],
    [2, -3600_000, 3600_000, true],
    [2, -3600_000, -1, false], // Explicit elapsed ends remain authoritative.
    [3, -3600_000, null, false], // Completed/cancelled rows never become transients.
    [4, 3600_000, null, false],
  ])("resolves live Discord status=%s start=%s end=%s visibility=%s", async (status, startOffset, endOffset, visible) => {
    const now = Date.now();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      id: "voice", name: "Voice game night", status,
      scheduled_start_time: new Date(now + startOffset).toISOString(),
      scheduled_end_time: endOffset === null ? null : new Date(now + endOffset).toISOString(),
    }]), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const source = liveDiscordEventsSource(baseEnv);
    const html = await (await calendar([], [], source).request("/events")).text();
    expect(cardKeys(html)).toEqual(visible ? ["discord-voice"] : []);
    expect(html.includes(EVENTS_EMPTY_NEVER_TESTID)).toBe(!visible);
    expect(source.lastReadFailed()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(html).not.toContain('href="/e/discord-voice"');
    if (visible && endOffset === null) {
      const [row] = await source.upcoming();
      expect(row).toMatchObject({ endsAt: null, status: status === 2 ? "active" : "scheduled" });
    }
  });
});

/* ----------------------------------------------------------- contract pins */
describe("EventsCalendar contract drift", () => {
  it("pins the read contract: user-driven, single-flight, page URL only", () => {
    expect(POLLING[EVENTS_CALENDAR_ISLAND].pollMs).toBeNull();
    expect(EVENTS_CALENDAR_TESTID).toBe("events-calendar");
    expect(EVENTS_SEARCH_DEBOUNCE_MS).toBe(300);
    expect(EVENTS_SEARCH_MAX_LENGTH).toBe(255);
    expect(EVENTS_PAST_DRAWER_LIMIT).toBe(20);
    expect(EVENTS_GAP_LIST_LIMIT).toBe(5);
    expect(EVENTS_VIEW_GROUP_LABEL).toBe("How to show the events");
    expect(EVENTS_PAST_STATUS_COPY).toBe("Showing past events.");
    expect(EVENTS_LOADING_TESTID).toBe("events-loading");
    expect(eventsSearchHitCopy("jam")).toBe("Results for “jam”");
    expect(eventsSearchMissCopy("jam")).toBe("Nothing matches “jam”.");
  });

  it("pins URL rules: q raw + non-blank, view/month only for calendar, past flag", () => {
    const s = (o: Partial<CalendarState>): CalendarState => ({ view: "list", month: "2026-10", q: "", past: false, ...o });
    expect(calendarUrl(s({}))).toBe("/events");
    expect(calendarUrl(s({ q: "  " }))).toBe("/events");
    expect(calendarUrl(s({ q: "game night" }))).toBe("/events?q=game+night");
    expect(calendarUrl(s({ past: true }))).toBe("/events?past=1");
    expect(calendarUrl(s({ view: "calendar", month: "2026-11" }))).toBe("/events?view=calendar&month=2026-11");
    // view/month ride along whenever the state is calendar — the force-to-list
    // for a search is resolved server-side at parse, not in the URL builder.
    expect(calendarUrl(s({ q: "x" }))).toBe("/events?q=x");
    expect(calendarUrl(s({ q: "x", view: "calendar", month: "2026-10" }))).toBe("/events?q=x&view=calendar&month=2026-10");
  });

  it("pins parsing and fallback behaviour", () => {
    expect(parseCalendarView("list")).toBe("list");
    expect(parseCalendarView("calendar")).toBe("calendar");
    expect(parseCalendarView("bogus")).toBeNull();
    expect(parseCalendarMonth("2026-9")).toBe("2026-09");
    expect(parseCalendarMonth("2026-13")).toBeNull();
    expect(parseCalendarMonth("banana")).toBeNull();
    expect(addCalendarMonth("2026-12", 1)).toBe("2027-01");
    expect(addCalendarMonth("2026-01", -1)).toBe("2025-12");
    expect(calendarMonthLabel("2026-09")).toBe("September 2026");
    expect(currentCalendarMonth(new Date(Date.UTC(2026, 8, 30)))).toBe("2026-09");
  });

  it("pins search normalization, LIKE escaping and the log entry shape", () => {
    expect(normalizeEventSearch("  GaMe\n  Night  ")).toBe("game night");
    expect(normalizeEventSearch("   ")).toBeNull();
    expect(normalizeEventSearch("x".repeat(300))).toBe("x".repeat(255));
    expect(escapeLikeTerm("100%_\\")).toBe("100\\%\\_\\\\");
    expect(eventSearchLogEntry(" GaMe ", 7)).toEqual({ event: "event_search", query: "game", results: 7 });
    expect(eventSearchLogEntry("   ", 7)).toBeNull();
  });

  it("pins the empty-state precedence and Monday-first whole-week grid", () => {
    const s = (o: Partial<Parameters<typeof calendarEmptyState>[0]>) =>
      calendarEmptyState({ searching: false, upcomingEmpty: true, pastEmpty: true, readFailed: false, ...o });
    expect(s({})).toBe("never");
    expect(s({ pastEmpty: false })).toBe("gap");
    expect(s({ readFailed: true })).toBe("error");
    expect(s({ readFailed: true, searching: true })).toBe("error");
    expect(s({ searching: true })).toBeNull();
    expect(s({ upcomingEmpty: false })).toBeNull();

    const weeks = monthGrid("2026-09", "2026-09-30", new Map());
    expect(weeks.length).toBeGreaterThanOrEqual(4);
    expect(weeks.flat()).toHaveLength(weeks.length * 7);
    const first = weeks[0]![0]!;
    expect(first.iso).toBe("2026-08-31"); // Monday before the 1st
    expect(first.inMonth).toBe(false);
    const today = weeks.flat().find((d) => d.iso === "2026-09-30")!;
    expect(today.isToday).toBe(true);
    expect(gridTitle("a".repeat(30))).toBe(`${"a".repeat(18)}…`);
    expect(calendarZone(["Europe/London", "Europe/London", "UTC"])).toBe("Europe/London");
    expect(calendarZone(["Not/AZone"])).toBe("UTC");
    expect(calendarZone([])).toBe("UTC");
  });
});

/* ------------------------------------------------------------------- SSR */
describe("EventsCalendar SSR drift", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mounts the island: list default, toggle anchors, stable search, live regions, binder", async () => {
    const up = [eventRow({ title: "Sunday Squad", startsAt: new Date(Date.UTC(2030, 0, 10, 20)), endsAt: new Date(Date.UTC(2030, 0, 10, 22)) })];
    const source = calendar(up, [], okSource());
    const res = await source.request("/events");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toBe("Cookie, X-Two-Island");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).toContain(`data-island="${EVENTS_CALENDAR_ISLAND}"`);
    expect(html).toContain('data-view="list"');
    expect(html).toContain(`role="group" aria-label="${EVENTS_VIEW_GROUP_LABEL}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_LIST_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_VIEW_CALENDAR_TESTID}"`);
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_TESTID}"`);
    expect(html).toContain('action="/events"');
    expect(html).toContain(`data-testid="${EVENTS_VIEW_STATUS_TESTID}">Showing events as a list.`);
    expect(html).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
    expect(html).toContain("Sunday Squad");
    expect(html).not.toContain(EVENTS_PAST_TOGGLE_TESTID); // no past rows → no toggle
    expect(html).toContain('src="/islands/events-calendar.js"');
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events"`);
    // Read order: upcoming rows, their grouped going aggregate, then the past
    // drawer read (empty page → no aggregate). Never a per-card query.
    expect(source.queries.map((q) => (q.sql.includes("rsvps") ? "rsvps" : "events"))).toEqual(["events", "rsvps", "events"]);
    expect(source.queries[1]!.sql).toContain('group by "rsvps"."event_id"');
  });

  it("pins the LIKE: bound, wildcard-escaped, title OR description, drafts gated for guests", async () => {
    const source = calendar([eventRow({ title: "100% legit night" })], [], okSource());
    const res = await source.request("/events?q=" + encodeURIComponent("100% legit"));
    const html = await res.text();
    expect(res.status).toBe(200);
    const up = source.queries.find((q) => q.sql.includes('from "events"'))!;
    expect(up.sql).toContain("ilike");
    expect(up.params.filter((p) => p === "%100\\% legit%")).toHaveLength(2);
    expect(up.sql).toContain("'draft'"); // guests never see drafts, even in search
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_STATUS_TESTID}">${eventsSearchHitCopy("100% legit")}`);
    expect(html).toContain('data-view="list"');
    expect(html).toContain(`data-testid="${EVENTS_SEARCH_CLEAR_TESTID}"`);
    // view=calendar is overridden by the search (server-side force-list).
    const cal = await source.request("/events?view=calendar&month=2030-01&q=jam");
    expect(await cal.text()).toContain('data-view="list"');
  });

  it("shows drafts to moderators only and no-stores the moderator page", async () => {
    const draft = eventRow({ title: "Secret draft", status: "draft" });
    // The session store must land in the env BEFORE the app env is built —
    // extraEnv is spread into env at calendar() call time.
    const envSlots: Record<string, unknown> = {};
    const cookie = await moderatorCookie(envSlots);
    // Guest: draft hidden by the query itself.
    const guestSrc = calendar([draft], [], okSource());
    const guestHtml = await (await guestSrc.request("/events")).text();
    expect(guestHtml).not.toContain("Secret draft");
    expect(guestHtml).toContain(EVENTS_EMPTY_NEVER_TESTID);
    expect(guestSrc.queries[0]!.sql).toContain("'draft'");
    // Moderator: the draft clause is absent, page is private.
    const modSrc = calendar([draft], [], okSource(), envSlots);
    const res = await app.request("/events", { headers: { cookie } }, modSrc.env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(modSrc.queries[0]!.sql).not.toContain("'draft'");
    expect(html).toContain("Secret draft");
    expect(html).toContain(`data-testid="${EVENT_DRAFT_TESTID}"`);
  });

  it("keeps cancelled rows listed with the badge", async () => {
    const cancelled = eventRow({ title: "Rained off", status: "cancelled" });
    const html = await (await calendar([cancelled], [], okSource()).request("/events")).text();
    expect(html).toContain("Rained off");
    expect(html).toContain(`data-testid="${EVENT_CANCELLED_TESTID}"`);
  });

  it("reveals past matches inside a search without the drawer flag", async () => {
    const pastRow = eventRow({ title: "Last jam", startsAt: new Date(Date.UTC(2020, 0, 1)), endsAt: new Date(Date.UTC(2020, 0, 1, 2)) });
    const source = calendar([eventRow()], [pastRow], okSource());
    const html = await (await source.request("/events?q=jam")).text();
    expect(html).toContain(`data-testid="${EVENTS_PAST_LIST_TESTID}"`);
    expect(html).toContain("Last jam");
    expect(html).not.toContain(EVENTS_PAST_TOGGLE_TESTID); // already shown by the search
  });

  it("opens the past drawer on ?past=1 with the status line; toggle links there when closed", async () => {
    const pastRow = eventRow({ title: "Old one", startsAt: new Date(Date.UTC(2020, 0, 1)), endsAt: new Date(Date.UTC(2020, 0, 1, 2)) });
    const source = calendar([eventRow()], [pastRow], okSource());
    const closed = await (await source.request("/events")).text();
    expect(closed).toContain(`href="/events?past=1" data-testid="${EVENTS_PAST_TOGGLE_TESTID}"`);
    expect(closed).not.toContain(EVENTS_PAST_LIST_TESTID);
    const open = await (await source.request("/events?past=1")).text();
    expect(open).toContain(`data-testid="${EVENTS_PAST_LIST_TESTID}"`);
    expect(open).toContain(`data-testid="${EVENTS_PAST_STATUS_TESTID}">${EVENTS_PAST_STATUS_COPY}`);
    expect(open).toContain('data-past="1"');
    const pastQ = source.queries.find((q) => /"ends_at" </.test(q.sql))!;
    expect(pastQ.sql).toContain("desc");
    expect(pastQ.params.at(-1)).toBe(EVENTS_PAST_DRAWER_LIMIT);
  });

  it("renders the month grid: Monday-first weekdays, label, day links, prev/next anchors", async () => {
    const up = [eventRow({ title: "Grid night", startsAt: new Date(Date.UTC(2030, 0, 15, 20)), endsAt: new Date(Date.UTC(2030, 0, 15, 22)) })];
    const html = await (await calendar(up, [], okSource()).request("/events?view=calendar&month=2030-01")).text();
    expect(html).toContain('data-view="calendar"');
    expect(html).toContain(`data-testid="${CALENDAR_MONTH_TESTID}">January 2030`);
    expect(html).toContain(`data-testid="${CALENDAR_MONTH_STATUS_TESTID}">January 2030`);
    expect(html).toContain(`data-testid="${EVENTS_CALENDAR_GRID_TESTID}"`);
    for (const d of WEEKDAY_HEADINGS) expect(html).toContain(`<th scope="col">${d}</th>`);
    expect(html).toContain(`data-testid="${CALENDAR_DAY_TESTID}"`);
    expect(html).toContain("data-cal-jump");
    expect(html).toContain("#event-ev-");
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain("month=2029-12");
  });

  it("never 500s on a bad month and keeps the current view on an unknown one", async () => {
    const up = [eventRow()];
    const bad = await calendar(up, [], okSource()).request("/events?view=calendar&month=banana");
    const html = await bad.text();
    expect(bad.status).toBe(200);
    expect(html).toContain(`data-testid="${CALENDAR_MONTH_TESTID}">`); // this month, not an error
    const weird = await calendar(up, [], okSource()).request("/events?view=banana");
    const weirdHtml = await weird.text();
    expect(weird.status).toBe(200);
    expect(weirdHtml).toContain('data-view="list"');
  });

  it("distinguishes never / gap / error / search-miss empty states", async () => {
    const never = await (await calendar([], [], okSource()).request("/events")).text();
    expect(never).toContain(`data-testid="${EVENTS_EMPTY_NEVER_TESTID}"`);
    expect(never).toContain(EVENTS_EMPTY_COPY.neverTitle);
    expect(never).toContain(INVITE);

    const pastRow = eventRow({ title: "Long ago", startsAt: new Date(Date.UTC(2020, 0, 1)), endsAt: new Date(Date.UTC(2020, 0, 1, 2)) });
    const gap = await (await calendar([], [pastRow], okSource()).request("/events")).text();
    expect(gap).toContain(`data-testid="${EVENTS_EMPTY_GAP_TESTID}"`);
    expect(gap).toContain(EVENTS_EMPTY_COPY.gapTitle);
    expect(gap).toContain(`data-testid="${EVENTS_EMPTY_GAP_ITEM_TESTID}"`);
    expect(gap).toContain('href="/events/past"');

    const err = await (await calendar([], [], failedSource()).request("/events")).text();
    expect(err).toContain(`role="alert" data-testid="${EVENTS_EMPTY_ERROR_TESTID}"`);
    expect(err).toContain(`data-testid="${EVENTS_RETRY_TESTID}"`);
    expect(err).toContain(esc(EVENTS_EMPTY_COPY.errorTitle));
    expect(err).toContain(esc(EVENTS_EMPTY_COPY.errorBody));
    // A failed read with a search is still the error, never "no matches".
    const errSearch = await (await calendar([], [], failedSource()).request("/events?q=x")).text();
    expect(errSearch).toContain(EVENTS_EMPTY_ERROR_TESTID);
    expect(errSearch).not.toContain(EVENTS_EMPTY_SEARCH_TESTID);

    const miss = await (await calendar([], [pastRow], okSource()).request("/events?q=nomatch")).text();
    expect(miss).toContain(`data-testid="${EVENTS_EMPTY_SEARCH_TESTID}"`);
    expect(miss).toContain(EVENTS_EMPTY_COPY.searchMissTitle);
    expect(miss).toContain(`data-testid="${EVENTS_SEARCH_CLEAR_EMPTY_TESTID}"`);
  });

  it("merges Discord transients in start order with the rsvp link and no going count", async () => {
    const late = eventRow({ title: "Local late", startsAt: new Date(Date.UTC(2030, 0, 20, 20)), endsAt: new Date(Date.UTC(2030, 0, 20, 22)) });
    const early = eventRow({ title: "Local early", startsAt: new Date(Date.UTC(2030, 0, 5, 20)), endsAt: new Date(Date.UTC(2030, 0, 5, 22)) });
    const trans = transient("d1", new Date(Date.UTC(2030, 0, 12, 20)));
    const html = await (await calendar([early, late], [], okSource([trans])).request("/events")).text();
    const keys = cardKeys(html);
    expect(keys.indexOf("discord-d1")).toBeGreaterThan(keys.indexOf(early.eventKey));
    expect(keys.indexOf(late.eventKey)).toBeGreaterThan(keys.indexOf("discord-d1"));
    expect(html).toContain(`data-testid="${EVENT_DISCORD_RSVP_TESTID}"`);
    const transientCard = html.split('data-event-key="discord-d1"')[1]!.split("</article>")[0]!;
    expect(transientCard).not.toContain("going");
  });

  it("drops a transient that duplicates a synced row and filters ended transients", async () => {
    const local = eventRow({ title: "Synced", discordEventId: "d1" });
    const ended = transient("d2", new Date(Date.UTC(2020, 0, 1)));
    ended.endsAt = new Date(Date.UTC(2020, 0, 1, 2));
    const html = await (await calendar([local], [], okSource([transient("d1", new Date(Date.UTC(2030, 0, 1))), ended])).request("/events")).text();
    expect(cardKeys(html)).toEqual([local.eventKey]);
  });

  it.each([
    [APP_URL, APP_URL, "noindex, nofollow"],
    ["https://togetherweown.com", "https://togetherweown.com", "noindex, follow"],
  ])("preserves search analytics, no-store and NUL sanitization with trusted APP_URL=%s on %s", async (appUrl, servingUrl, robotsTag) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const src = calendar([eventRow({ title: "Chess  night" })], [], okSource(), { APP_URL: appUrl });
    const res = await src.request(`${servingUrl}/events?q=%20CHESS%20%20night%20`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // Non-apex trusted hosts keep the middleware's staging posture.
    expect(res.headers.get("x-robots-tag")).toBe(robotsTag);
    expect(await res.text()).toContain("Chess  night");
    expect(src.logs).toEqual([{ normalizedQuery: "chess night", resultCount: 1 }]);
    await src.request(`${servingUrl}/events?q=%00`);
    await src.request(`${servingUrl}/events?q=Chess%00%20%20night`);
    expect(src.logs).toEqual([
      { normalizedQuery: "chess night", resultCount: 1 },
      { normalizedQuery: "chess night", resultCount: 1 },
    ]);
    expect(src.queries.flatMap((q) => q.params).some((p) => typeof p === "string" && p.includes("\u0000"))).toBe(false);
  });

  it.each([
    ["https://togetherweown.com", APP_URL],
    [APP_URL, "https://togetherweown.com"],
  ])("refuses searches on a foreign serving host before reads or analytics with APP_URL=%s on %s", async (appUrl, servingUrl) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = okSource();
    const upcoming = vi.spyOn(source, "upcoming");
    const src = calendar([eventRow({ title: "Chess  night" })], [], source, { APP_URL: appUrl });
    // Keep the original mismatched-host cases; W16 now deliberately refuses
    // them before the event route, not just with a different robots header.
    for (const query of ["%20CHESS%20%20night%20", "%00", "Chess%00%20%20night"]) {
      const res = await rawApp.request(`${servingUrl}/events?q=${query}`, {}, src.env);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.getSetCookie()).toHaveLength(0);
      const html = await res.text();
      expect(html).toContain("We cannot find that page");
      expect(html).not.toContain("Chess  night");
    }
    expect(src.queries).toEqual([]);
    expect(src.logs).toEqual([]);
    expect(upcoming).not.toHaveBeenCalled();
    expect(info.mock.calls.filter((c) => c[0] === "event_search")).toHaveLength(0);
  });

  it("logs a normalized search with the visible count and nothing else", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const up = [eventRow({ title: "Jam night" })];
    const pastRow = eventRow({ title: "Past jam", startsAt: new Date(Date.UTC(2020, 0, 1)), endsAt: new Date(Date.UTC(2020, 0, 1, 2)) });
    await calendar(up, [pastRow], okSource()).request("/events?q=%20%20JAM%20%20");
    const line = spy.mock.calls.find((c) => c[0] === "event_search");
    expect(line).toBeTruthy();
    expect(JSON.parse(String(line![1]))).toEqual({ event: "event_search", query: "jam", results: 2 });
    expect(String(line![1])).not.toMatch(/user|session|ip/i);
    // No search, no line.
    spy.mockClear();
    await calendar(up, [], okSource()).request("/events");
    expect(spy.mock.calls.filter((c) => c[0] === "event_search")).toHaveLength(0);
  });
});

/* --------------------------------------------------------- binder harness */
type Click = {
  defaultPrevented: boolean; button: number; ctrlKey?: boolean; metaKey?: boolean;
  shiftKey?: boolean; altKey?: boolean; target: { closest: (sel: string) => Link | null };
  preventDefault: () => void;
};
type Link = { href: string; hash: string; target: string; hasAttribute: (name: string) => boolean };

class Node {
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  value = "";
  focused = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (e: unknown) => void>();
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string) { this.attributes.delete(k); }
  replaceChildren(...children: unknown[]) { this.childNodes = children; }
  focus() { this.focused = true; }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, fn); }
  closest() { return this === inputNode ? formNode : null; }
}

// Nodes the binder binds to, in zone order: head, actions, miss, content.
let formNode: Node;
let inputNode: Node;

const LIVE_IDS = ["events-view-status", "events-search-status", "events-past-status", "calendar-month-status"];

function browser(entry = "/events") {
  const zones = { head: new Node(), actions: new Node(), miss: new Node(), content: new Node() };
  for (const [name, node] of Object.entries(zones)) node.attributes.set("data-cal-zone", name);
  zones.content.childNodes = ["original content"];
  const skeleton = new Node();
  skeleton.hidden = true;
  const feedback = new Node();
  inputNode = new Node();
  inputNode.value = "";
  formNode = new Node();
  const liveNodes = Object.fromEntries(LIVE_IDS.map((id) => [id, new Node()] as [string, Node])) as Record<string, Node>;
  const canonical = new Node();
  canonical.href = `${APP_URL}/events`;
  const og = new Node();
  og.content = canonical.href;
  const root = new Node();
  root.dataset = { view: "list", month: "2026-09", past: "", loadError: EVENTS_CALENDAR_FETCH_FAILED };
  let click: (event: Click) => void = () => {};
  let popstate: () => void = () => {};
  const focusables: Record<string, Node> = {};
  const mount = Object.assign(root, {
    querySelector: (selector: string) => {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return inputNode;
      if (selector === '[data-cal-zone="content"]') return zones.content; // setLoading toggles it
      const live = /data-testid="([^"]+)"/.exec(selector)?.[1];
      if (live && liveNodes[live]) return liveNodes[live];
      return focusables[selector] ?? null;
    },
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? [zones.head, zones.actions, zones.miss, zones.content] : []),
    addEventListener: (_type: string, listener: typeof click) => { click = listener; },
    contains: () => true,
  });
  const history: string[] = [];
  const reloads: string[] = [];
  const location = { href: new URL(entry, APP_URL).href, origin: APP_URL, assign: (href: string) => reloads.push(href) };
  const requests: { url: string; init: RequestInit; resolve: (r: { ok: boolean; text: () => Promise<string> }) => void; reject: (e: Error) => void }[] = [];
  const parsedPages = new Map<string, { querySelector: (s: string) => unknown }>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  runInNewContext(binder, {
    URL, AbortController,
    setTimeout: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    document: {
      querySelector: (s: string) =>
        s === '[data-island="events-calendar"]' ? mount : s.startsWith("link") ? canonical : s.startsWith("meta") ? og : null,
      importNode: (n: unknown) => n,
    },
    window: {
      location,
      history: { pushState: (_s: unknown, _t: string, url: string) => { history.push(url); location.href = APP_URL + url; } },
      addEventListener: (_type: string, listener: () => void) => { popstate = listener; },
    },
    DOMParser: class { parseFromString(html: string) { return parsedPages.get(html); } },
    fetch: (url: string, init: RequestInit) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });

  function fireTimer() {
    const next = timers.entries().next();
    if (next.done) return;
    timers.delete(next.value[0]);
    next.value[1]();
  }

  function clickLink(href: string, modifiers: Partial<Click> = {}, attrs: string[] = []) {
    const url = new URL(href, APP_URL);
    const link: Link = { href: url.href, hash: url.hash, target: "", hasAttribute: (n) => attrs.includes(n) };
    let prevented = false;
    click({ defaultPrevented: false, button: 0, target: { closest: () => link }, preventDefault: () => { prevented = true; }, ...modifiers });
    return prevented;
  }

  // Build the fetched page: zones keyed by name, dataset, live texts, input value.
  function finish(
    i: number,
    page: string,
    opts: { content?: unknown[]; head?: unknown[]; actions?: unknown[]; miss?: unknown[]; view?: string; month?: string; past?: string; statuses?: string[]; input?: string } = {},
  ) {
    const src = (name: string, kids: unknown[]) => { const n = new Node(); n.attributes.set("data-cal-zone", name); n.childNodes = kids; return n; };
    const sourceZones = [src("head", opts.head ?? ["head2"]), src("actions", opts.actions ?? []), src("miss", opts.miss ?? []), src("content", opts.content ?? ["new content"])];
    const next = {
      dataset: { view: opts.view ?? "list", month: opts.month ?? "2026-09", past: opts.past ?? "" },
      querySelectorAll: (s: string) => (s === "[data-cal-zone]" ? sourceZones : []),
    };
    const statusNodes = (opts.statuses ?? ["v", "s", "p", "m"]).map((t) => { const n = new Node(); n.textContent = t; return n; });
    const srcInput = new Node();
    srcInput.attributes.set("value", opts.input ?? "");
    const pageObj = {
      querySelector: (s: string) => {
        if (s === '[data-island="events-calendar"]') return next;
        if (s.startsWith("link")) return { href: `${APP_URL}${page.startsWith("/") ? page : "/events"}` };
        const live = /data-testid="([^"]+)"/.exec(s)?.[1];
        if (live === "events-search") return srcInput;
        const liveIdx = LIVE_IDS.indexOf(live ?? "");
        if (liveIdx >= 0) return statusNodes[liveIdx];
        return null;
      },
    };
    parsedPages.set(page, pageObj);
    requests[i]!.resolve({ ok: true, text: async () => page });
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    root: mount, zones, skeleton, feedback, input: inputNode, form: formNode, liveNodes, canonical, og,
    requests, history, reloads, location, timers, focusables,
    clickLink, finish, settle, fireTimer, popstate: () => popstate(),
    inputEvent: () => inputNode.listeners.get("input")!({}),
    submit: () => { let prevented = false; formNode.listeners.get("submit")!({ preventDefault: () => { prevented = true; } }); return prevented; },
  };
}

describe("EventsCalendar shipped binder request/state drift", () => {
  it("swaps the native past control with drawer navigation without replacing the search input", async () => {
    const src = calendar([eventRow({ title: "Jam" })], [], okSource());
    const opened = await (await src.request("/events?past=1")).text();
    const closed = await (await src.request("/events")).text();
    const actions = (html: string) => html.match(/<span data-cal-zone="actions">([\s\S]*?)<\/span>/)![1]!;
    expect(actions(opened)).toBe('<input type="hidden" name="past" value="1"/>');
    expect(actions(closed)).toBe("");
    const b = browser();
    const input = b.input;
    input.focus();
    b.clickLink("/events?past=1");
    b.finish(0, "opened", { past: "1", actions: [actions(opened)] });
    await b.settle();
    expect(b.zones.actions.childNodes).toEqual([actions(opened)]);
    expect(b.input).toBe(input);
    expect(input.focused).toBe(true);
    b.clickLink("/events");
    b.finish(1, "closed", { actions: [] });
    await b.settle();
    expect(b.zones.actions.childNodes).toEqual([]);
    expect(b.input).toBe(input);
    expect(input.focused).toBe(true);
  });

  it.each([
    { entry: "/events?view=calendar&month=2030-02&past=1&page=7&extra=bad", past: true },
    { entry: "/events?view=calendar&month=2030-02", past: false },
    { entry: "/events?view=list&month=2030-02&past=0&q=old", past: false },
    { entry: "/events?view=bad&month=bad&past=true", past: false },
  ])("drops view/month on changed and blank enhanced searches from $entry", ({ entry, past }) => {
    const b = browser(entry);
    for (const query of ["raid & friends", "", "   "]) {
      b.input.value = query;
      b.submit();
      const url = new URL(b.requests.at(-1)!.url, APP_URL);
      expect([...url.searchParams.keys()].sort()).toEqual([
        ...(query.trim() ? ["q"] : []), ...(past ? ["past"] : []),
      ].sort());
      expect(url.searchParams.get("q")).toBe(query.trim() ? query : null);
      expect(url.searchParams.getAll("past")).toEqual(past ? ["1"] : []);
    }
  });

  it("adds and removes Clear in a swapped form-actions zone without replacing the focused input", async () => {
    const src = calendar([eventRow({ title: "Jam" })], [], okSource());
    const initial = await (await src.request("/events")).text();
    const searched = await (await src.request("/events?q=jam")).text();
    const actions = (html: string) => html.match(/<span data-cal-zone="actions">([\s\S]*?)<\/span>/)?.[1];
    expect(actions(initial)).toBe("");
    expect(actions(searched)).toContain(`data-testid="${EVENTS_SEARCH_CLEAR_TESTID}"`);
    const b = browser();
    const input = b.input;
    input.focus();
    input.value = "jam";
    b.inputEvent();
    b.fireTimer();
    b.finish(0, "searched", { input: "jam", actions: [actions(searched)] });
    await b.settle();
    expect(b.zones.actions.childNodes).toEqual([actions(searched)]);
    expect(b.input).toBe(input);
    expect(input.focused).toBe(true);
    b.clickLink("/events");
    b.finish(1, "cleared", { input: "", actions: [] });
    await b.settle();
    expect(b.input).toBe(input);
    expect(input.value).toBe("");
    expect(input.focused).toBe(true);
    expect(b.zones.actions.childNodes).toEqual([]);
    expect(b.history).toEqual(["/events?q=jam", "/events"]);
  });

  it("SSR-restores the current address when failed Clear supersedes Back", async () => {
    const b = browser("/events?q=old");
    b.input.value = "old";
    b.zones.content.childNodes = ["old search results"];
    b.location.href = APP_URL + "/events";
    b.popstate();
    b.clickLink("/events");
    expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    b.requests[1]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([APP_URL + "/events"]);
    expect(b.history).toEqual([]);
    b.finish(0, "late Back", { input: "", content: ["all events"] });
    await b.settle();
    expect(b.zones.content.childNodes).toEqual(["old search results"]); // A late aborted response cannot commit.
    expect(b.reloads).toHaveLength(1);
  });

  it("retains the committed render URL after successful search when failed navigation supersedes Back", async () => {
    const b = browser();
    b.input.value = "old";
    b.submit();
    b.finish(0, "/events?q=old", { input: "old", content: ["search results"] });
    await b.settle();
    b.location.href = APP_URL + "/events";
    b.popstate();
    b.clickLink("/events?past=1");
    b.requests[2]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([APP_URL + "/events"]); // Restore Back's address, not the failed destination.
    expect(b.history).toEqual(["/events?q=old"]);
  });

  it("keeps last-good content on failure after a successful Back commit", async () => {
    const b = browser("/events?q=old");
    b.location.href = APP_URL + "/events";
    b.popstate();
    b.finish(0, "/events", { content: ["all events"] });
    await b.settle();
    b.clickLink("/events?past=1");
    b.requests[1]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([]);
    expect(b.zones.content.childNodes).toEqual(["all events"]);
    expect(b.feedback.textContent).toBe(EVENTS_CALENDAR_FETCH_FAILED);
  });

  it("cancels pending debounce before a slow Back restoration", async () => {
    const b = browser("/events?q=old");
    b.input.value = "new";
    b.inputEvent();
    b.location.href = APP_URL + "/events";
    b.popstate();
    b.fireTimer();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe("/events");
    expect(b.requests[0]!.init.signal!.aborted).toBe(false);
    b.finish(0, "restored", { input: "", content: ["back"] });
    await b.settle();
    expect(b.history).toEqual([]);
    expect(b.input.value).toBe("");
    expect(b.zones.content.childNodes).toEqual(["back"]);
  });

  it("cancels pending debounce on explicit anchors and does not overwrite newer typing", async () => {
    const b = browser("/events?q=old");
    b.input.value = "pending";
    b.inputEvent();
    b.clickLink("/events?past=1");
    b.fireTimer();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.init.signal!.aborted).toBe(false);
    b.input.value = "newer";
    b.inputEvent();
    b.finish(0, "drawer", { input: "", past: "1" });
    await b.settle();
    expect(b.input.value).toBe("newer");
    b.fireTimer();
    expect(b.requests[1]!.url).toBe("/events?q=newer&past=1");
  });

  it("copies an empty SSR search status over stale miss text on a read error", async () => {
    const html = await (await calendar([], [], failedSource()).request("/events?q=x")).text();
    const status = html.match(/data-testid="events-search-status">([^<]*)<\/p>/)![1]!;
    const b = browser("/events?q=x");
    b.liveNodes["events-search-status"]!.textContent = eventsSearchMissCopy("x");
    b.clickLink("/events?q=x");
    b.finish(0, "error", { input: "x", statuses: ["list", status, "", ""], content: [EVENTS_EMPTY_ERROR_TESTID] });
    await b.settle();
    expect(b.liveNodes["events-search-status"]!.textContent).toBe("");
    expect(b.zones.content.childNodes).toEqual([EVENTS_EMPTY_ERROR_TESTID]);
  });

  it("fires nothing on mount and issues exactly one GET per anchor click with skeleton", async () => {
    const b = browser();
    expect(b.requests).toHaveLength(0);
    expect(binder).not.toMatch(/setInterval|events\.json|\/rsvp/);
    expect(b.clickLink("/events?view=calendar&month=2026-10")).toBe(true);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({ url: "/events?view=calendar&month=2026-10", init: { method: "GET" } });
    expect(b.requests[0]!.init.headers).toEqual({ accept: "text/html", ...fragmentHeaders });
    expect(b.skeleton.hidden).toBe(false);
    expect(b.zones.content.hidden).toBe(true);
    b.finish(0, "p1", { view: "calendar", month: "2026-10", content: ["grid"] });
    await b.settle();
    expect(b.zones.content.childNodes).toEqual(["grid"]);
    expect(b.zones.content.hidden).toBe(false);
    expect(b.skeleton.hidden).toBe(true);
    expect(b.root.dataset.view).toBe("calendar");
    expect(b.history).toEqual(["/events?view=calendar&month=2026-10"]);
    expect(b.liveNodes["events-view-status"]!.textContent).toBe("v");
  });

  it("debounces the search box into a single settled ?q= read without a skeleton", async () => {
    const b = browser();
    b.input.value = "j";
    b.inputEvent();
    b.input.value = "ja";
    b.inputEvent();
    b.input.value = "jam";
    b.inputEvent();
    expect(b.requests).toHaveLength(0);
    b.fireTimer();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe("/events?q=jam");
    expect(b.skeleton.hidden).toBe(true); // typing is deliberately unskeletoned
    expect(b.zones.content.hidden).toBe(false);
    b.finish(0, "p1", { input: "jam" });
    await b.settle();
    expect(b.input.value).toBe("jam"); // untouched by push loads
    expect(b.history).toEqual(["/events?q=jam"]);
  });

  it("submits the GET form as the same settled read, cancelling a pending debounce", async () => {
    const b = browser();
    b.input.value = "jam";
    b.inputEvent();
    expect(b.submit()).toBe(true);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe("/events?q=jam");
    b.fireTimer(); // the debounce was cleared
    expect(b.requests).toHaveLength(1);
  });

  it("keeps the drawer flag on a settled search and drops view/month", async () => {
    const b = browser("/events?view=calendar&month=2026-10&past=1");
    b.input.value = "raid";
    b.inputEvent();
    b.fireTimer();
    expect(b.requests[0]!.url).toBe("/events?q=raid&past=1");
  });

  it("aborts a superseded read and ignores its late response", async () => {
    const b = browser();
    b.clickLink("/events?view=calendar&month=2026-10");
    b.clickLink("/events?past=1");
    expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    b.finish(1, "p2", { past: "1", content: ["past open"] });
    await b.settle();
    b.finish(0, "p1", { content: ["stale"] });
    await b.settle();
    expect(b.zones.content.childNodes).toEqual(["past open"]);
    expect(b.history).toEqual(["/events?past=1"]);
  });

  it("preserves content and reports through the feedback line on transport failure", async () => {
    const b = browser();
    b.clickLink("/events?view=calendar&month=2026-10");
    b.requests[0]!.reject(new Error("offline"));
    await b.settle();
    expect(b.zones.content.childNodes).toEqual(["original content"]);
    expect(b.feedback.textContent).toBe(EVENTS_CALENDAR_FETCH_FAILED);
    expect(b.skeleton.hidden).toBe(true);
    expect(b.history).toEqual([]);
  });

  it("restores zones, dataset, live text and the input on popstate", async () => {
    const b = browser();
    b.clickLink("/events?q=jam");
    b.finish(0, "p1", { input: "jam", content: ["results"] });
    await b.settle();
    b.location.href = `${APP_URL}/events`;
    b.input.value = "stale"; // the restored page rewrites the box
    b.popstate();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events");
    b.finish(1, "p2", { input: "", content: ["back to list"] });
    await b.settle();
    expect(b.zones.content.childNodes).toEqual(["back to list"]);
    expect(b.input.value).toBe("");
    expect(b.history).toEqual(["/events?q=jam"]);
  });

  it("grid jumps re-render the list and move focus onto the card", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    const card = new Node();
    b.focusables["#event-ev-7"] = card;
    expect(b.clickLink("/events#event-ev-7", {}, ["data-cal-jump"])).toBe(true);
    expect(b.requests[0]!.url).toBe("/events");
    b.finish(0, "p1");
    await b.settle();
    expect(card.focused).toBe(true);
    expect(b.history).toEqual(["/events#event-ev-7"]);
  });

  it("leaves modified clicks, other paths and external URLs to normal navigation", () => {
    const b = browser();
    expect(b.clickLink("/events?view=calendar", { ctrlKey: true })).toBe(false);
    expect(b.clickLink("/events?view=calendar", { metaKey: true })).toBe(false);
    expect(b.clickLink("/events?view=calendar", { button: 1 })).toBe(false);
    expect(b.clickLink("/events/past")).toBe(false);
    expect(b.clickLink("https://elsewhere.example/events")).toBe(false);
    expect(b.clickLink("/auth/discord")).toBe(false);
    expect(b.requests).toHaveLength(0);
  });
});
