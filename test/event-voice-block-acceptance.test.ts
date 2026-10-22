// Event voice block acceptance contract: TBD -> live -> after-party -> hidden
// on the event detail page, the events list, and the homepage teaser.
//
// What is pinned here (the web voice-block card's acceptance criteria):
// - TBD state: "Voice channel opens 15 min before · opens at <local time>"
//   plus the TBD reason token, with no channel id or link.
// - Live state: channel name plus the member jump link
//   (discord.com/channels/<guild>/<channel>); logged-out visitors get the
//   configured invite fallback plus the event time, never the channel link.
// - After-party state: "Event ended · after-party in <name>" plus the link
//   and the capped-powers note (names the 10-minute cap).
// - Hidden state: "Event ended" text only, no link.
// - Bot DB outage: TBD copy plus the last-known channel name marked stale,
//   HTTP 200, never a 500.
// - Logged-out rendering contains no occupant names, counts, or owner ids.
//
// Test seams (all hermetic: no database, no network, no live Discord reads):
// - The `postgres` driver is mocked with a per-test controllable fake in the
//   style of the counts contract test. The fake answers queries mentioning
//   `upcoming_events` from canned rows and degrades every other bot-view
//   query to no rows, so homepage counts hide exactly as they do on outage.
// - The web database is a drizzle pg-proxy stub in the style of the
//   event-page and guest-calendar suites; sessions are memory-backed.
// - Module state is reset before every test, so each test performs a cold
//   read of the voice view; the outage test advances a Date-only fake clock
//   past the specified 60 s isolate-local TTL between its two requests.
// - The fake is NOT key-aware: it returns the canned rows for every
//   upcoming_events query. Every fixture therefore holds a single event, and
//   the web-row-to-view-row join key (the Discord event id) is asserted only
//   by the Builder's own integration tests against a real view, not here.
//
// Pinned view contract (from the bot view card): the block reads
// web_v1.upcoming_events columns voice_channel_id, voice_channel_name,
// state ('tbd' | 'live' | 'after_party' | 'hidden'), after_party, and
// tbd_reason (opens_soon | rate_limited | perm_denied | no_category |
// unavailable). States here are consistent across every redundant column, so
// reading `state` and deriving from id presence plus the after-party flag
// agree. Hidden is zero rows: the view only lists scheduled and active
// Discord events, so an ended event vanishes from it. Every test asserts the
// view was actually queried, so a hard-coded block cannot pass.
//
// Pinned markup contract (test ids only, no other markup is specified):
// - data-testid="event-voice-block" on the block wrapper in every state,
//   including hidden.
// - data-testid="event-voice-link" on the block's anchor whenever the block
//   renders a link (member jump, logged-out invite, after-party link), and
//   absent whenever it must not link (TBD, hidden).
// - data-testid="event-voice-note" on the note line for the after-party
//   capped-powers note and the stale last-known-name marker.
// Copy assertions are page-scoped: single-event fixtures make them
// unambiguous, and the asserted tokens appear nowhere else on the page.
//
// Deliberately NOT pinned: the loudspeaker glyph or "Join" affordance on the
// live link, the channel name's presence for logged-out visitors (the view
// exposes names to all readers), owner display for members (v1 may omit it),
// the click-through "channel closed" copy, rename-without-deploy freshness,
// and ICS feeds. Those belong to the Builder's own tests.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

type VoiceRow = Record<string, unknown>;

const voiceDb = vi.hoisted(() => ({
  rows: [] as VoiceRow[],
  down: false,
  queries: [] as string[],
}));

vi.mock("postgres", () => ({
  default: (_url: string, _options?: unknown) => {
    void _url;
    void _options;
    const answer = async (query: string): Promise<Record<string, unknown>[]> => {
      voiceDb.queries.push(query);
      if (!query.includes("upcoming_events")) return [];
      if (voiceDb.down) throw new Error("voice view unavailable");
      return voiceDb.rows.map((row) => ({ ...row }));
    };
    const sql = (parts: TemplateStringsArray, ..._values: unknown[]) => {
      void _values;
      return answer(parts.join(""));
    };
    (sql as unknown as Record<string, unknown>).unsafe = (query: string) => answer(query);
    (sql as unknown as Record<string, unknown>).end = async () => {};
    (sql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(sql);
    return sql;
  },
}));

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
// Proven 26-char key in the style of the event-page suite.
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GUILD_ID = "326474832151838730";
const CHANNEL_ID = "771122334455667788";
const DISCORD_EVENT_ID = "123456789012345671";
const INVITE_URL = "https://discord.gg/voice-fallback-7x2q";
const LIVE_CHANNEL_NAME = "Friday Night 8s";
const AFTER_PARTY_NAME = "Friday 8s After-Party";
const OWNER_TRAP_ID = "999888777666555443";
const OCCUPANT_TRAP_NAME = "Zelda Nightshade-Trap";

// 2030-01-10T19:00:00Z. January in Europe/London is UTC, so wall clocks equal
// the instant clocks and the opens-at needles below are exact.
const NOW_MS = Date.UTC(2030, 0, 10, 19, 0, 0);
const at = (iso: string) => new Date(iso);
const TBD_START = at("2030-01-10T20:00:00Z");
const TBD_END = at("2030-01-10T22:00:00Z");
const LIVE_START = at("2030-01-10T18:30:00Z");
const LIVE_END = at("2030-01-10T21:00:00Z");
const PAST_START = at("2030-01-10T16:00:00Z");
const PAST_END = at("2030-01-10T17:00:00Z");
const SOON_START = at("2030-01-10T19:10:00Z");
const SOON_END = at("2030-01-10T21:00:00Z");

const TBD_LEAD = "Voice channel opens 15 min before · opens at";
const jumpHref = `discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`;

// Display-cache columns the web card may add to the web events row. Unknown
// keys are ignored until the migration lands, so seeding them is safe now.
type VoiceCacheFixture = {
  voiceChannelId?: string | null;
  voiceChannelName?: string | null;
};
type EventRow = typeof events.$inferSelect & VoiceCacheFixture;

let eventSeq = 0;
function eventRow(over: Partial<typeof events.$inferSelect> & VoiceCacheFixture = {}): EventRow {
  const n = ++eventSeq;
  const startsAt = over.startsAt ?? TBD_START;
  const endsAt = over.endsAt ?? TBD_END;
  return {
    id: n,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Friday game night",
    game: null,
    description: null,
    startsAt,
    endsAt,
    timezone: "Europe/London",
    location: "The lobby",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    discordEventId: DISCORD_EVENT_ID,
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
    createdAt: startsAt,
    updatedAt: startsAt,
    ...over,
  };
}

function fakeDb(rows: EventRow[]): Db {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: EventRow) =>
    columns.map((key) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : value;
    });
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "featured_contents"')) {
      return {
        rows: [[1, "Community news", "Featured body", null, null, null, null, null]],
      };
    }
    if (
      sql.includes('from "rsvps"') &&
      sql.includes('inner join "users"') &&
      !sql.includes("group by")
    ) {
      return { rows: [] };
    }
    if (sql.includes('from "rsvps"')) {
      return sql.includes("count(*)") ? { rows: [[rows[0]?.id ?? 1, 0]] } : { rows: [] };
    }
    if (sql.includes('"event_key" =')) {
      return { rows: rows.map(encode) };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) {
      return { rows: rows.map((row) => [row.discordEventId]) };
    }
    if (/"ends_at" </.test(sql)) return { rows: [] };
    if (sql.includes('from "events"')) {
      const visible = sql.includes("'draft'") ? rows.filter((row) => row.status !== "draft") : rows;
      return { rows: visible.map(encode) };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return db;
}

function tbdRow(reason: string): VoiceRow {
  return {
    event_id: DISCORD_EVENT_ID,
    voice_channel_id: null,
    voice_channel_name: null,
    state: "tbd",
    after_party: false,
    tbd_reason: reason,
  };
}

function liveRow(): VoiceRow {
  return {
    event_id: DISCORD_EVENT_ID,
    voice_channel_id: CHANNEL_ID,
    voice_channel_name: LIVE_CHANNEL_NAME,
    state: "live",
    after_party: false,
    tbd_reason: null,
  };
}

function afterPartyRow(): VoiceRow {
  return {
    event_id: DISCORD_EVENT_ID,
    voice_channel_id: CHANNEL_ID,
    voice_channel_name: AFTER_PARTY_NAME,
    state: "after_party",
    after_party: true,
    tbd_reason: null,
  };
}

let app: typeof import("./app").default;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  voiceDb.rows = [];
  voiceDb.down = false;
  voiceDb.queries = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  app = (await import("./app")).default;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(rows: EventRow[]) {
  const store = createMemorySessionStore(() => Date.now());
  const db = fakeDb(rows);
  const source: DiscordEventsSource = {
    upcoming: async () => [],
    lastReadFailed: () => false,
  };
  const env = {
    APP_URL,
    SESSION_SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db,
    DISCORD_EVENTS: source,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_INVITE_URL: INVITE_URL,
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_DATABASE_URL: "postgres://voice-fixture.test/bot",
  } as unknown as Env;
  return {
    env,
    async memberCookie() {
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
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    },
    request(path: string, cookie?: string) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

/** The voice block renders from the view on every SSR: no view read, no pass. */
function expectViewRead() {
  expect(voiceDb.queries.some((query) => query.includes("upcoming_events"))).toBe(true);
}

/** The block's anchor tag, bounded to one open tag so extraction cannot overshoot. */
function voiceLinkTag(html: string): string | null {
  return html.match(/<a\b[^>]*data-testid="event-voice-link"[^>]*>/)?.[0] ?? null;
}

/** The anchor tag or the empty string, so href assertions fail honestly when absent. */
function voiceLinkTagOrEmpty(html: string): string {
  return voiceLinkTag(html) ?? "";
}

/** "opens at" must be followed by the wall clock, 24-hour or 12-hour style. */
function expectOpensAt(html: string, needle24: string, needle12: string) {
  const atWord = html.indexOf("opens at");
  expect(atWord).toBeGreaterThan(-1);
  const found24 = html.indexOf(needle24, atWord);
  const found12 = html.indexOf(needle12, atWord);
  expect(found24 > atWord || found12 > atWord).toBe(true);
}

describe("event voice block acceptance", () => {
  it("tbd state renders opens-at copy with the tbd reason and no channel link", async () => {
    voiceDb.rows = [tbdRow("no_category")];
    const f = fixture([eventRow({ startsAt: TBD_START, endsAt: TBD_END })]);
    const res = await f.request(`/e/${KEY}`, await f.memberCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain(TBD_LEAD);
    expectOpensAt(html, "19:45", "7:45");
    expect(html).toContain("no_category");
    expect(voiceLinkTag(html)).toBeNull();
    expect(html).not.toContain("discord.com/channels/");
    expectViewRead();
  });

  it("live state renders the channel name with a member jump link", async () => {
    voiceDb.rows = [liveRow()];
    const f = fixture([eventRow({ startsAt: LIVE_START, endsAt: LIVE_END })]);
    const res = await f.request(`/e/${KEY}`, await f.memberCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain(LIVE_CHANNEL_NAME);
    expect(voiceLinkTagOrEmpty(html)).toContain(jumpHref);
    expectViewRead();
  });

  it("live state gives logged-out visitors the invite fallback without the channel link", async () => {
    voiceDb.rows = [liveRow()];
    const f = fixture([eventRow({ startsAt: LIVE_START, endsAt: LIVE_END })]);
    const res = await f.request(`/e/${KEY}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(voiceLinkTagOrEmpty(html)).toContain(INVITE_URL);
    expect(html).not.toContain("discord.com/channels/");
    expect(html).toContain("18:30");
    expectViewRead();
  });

  it("after-party state renders the handoff copy, link, and capped-powers note", async () => {
    voiceDb.rows = [afterPartyRow()];
    const f = fixture([eventRow({ startsAt: PAST_START, endsAt: PAST_END })]);
    const res = await f.request(`/e/${KEY}`, await f.memberCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain(`Event ended · after-party in ${AFTER_PARTY_NAME}`);
    expect(voiceLinkTagOrEmpty(html)).toContain(jumpHref);
    expect(html).toContain('data-testid="event-voice-note"');
    expect(html).toMatch(/10 min/);
    expectViewRead();
  });

  it("hidden state renders ended text with no link", async () => {
    voiceDb.rows = [];
    const f = fixture([eventRow({ startsAt: PAST_START, endsAt: PAST_END })]);
    const res = await f.request(`/e/${KEY}`, await f.memberCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain("Event ended");
    expect(voiceLinkTag(html)).toBeNull();
    expect(html).not.toContain("discord.com/channels/");
    expectViewRead();
  });

  it("logged-out rendering leaks no occupant names, counts, or owner ids", async () => {
    voiceDb.rows = [
      {
        ...liveRow(),
        occupant_names: [OCCUPANT_TRAP_NAME],
        occupant_count: 7,
        after_party_owner: OWNER_TRAP_ID,
      },
    ];
    const f = fixture([eventRow({ startsAt: LIVE_START, endsAt: LIVE_END })]);
    const res = await f.request(`/e/${KEY}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-voice-block"');
    expect(voiceLinkTagOrEmpty(html)).toContain(INVITE_URL);
    expect(html).not.toContain(OCCUPANT_TRAP_NAME);
    expect(html).not.toContain(OWNER_TRAP_ID);
    expect(html).not.toMatch(/occupant/i);
    expect(html).not.toMatch(/\b\d+\s+(in voice|in the channel|occupants?|listening)\b/i);
    expect(html).not.toContain("discord.com/channels/");
    expectViewRead();
  });

  it("bot db outage renders tbd copy with the last-known name marked stale and never a 500", async () => {
    voiceDb.rows = [liveRow()];
    const f = fixture([
      eventRow({
        startsAt: SOON_START,
        endsAt: SOON_END,
        voiceChannelId: CHANNEL_ID,
        voiceChannelName: LIVE_CHANNEL_NAME,
      }),
    ]);
    const cookie = await f.memberCookie();
    const live = await f.request(`/e/${KEY}`, cookie);
    expect(live.status).toBe(200);
    expect(voiceLinkTagOrEmpty(await live.text())).toContain(jumpHref);

    vi.setSystemTime(NOW_MS + 61_000);
    voiceDb.down = true;
    const res = await f.request(`/e/${KEY}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain(TBD_LEAD);
    expectOpensAt(html, "18:55", "6:55");
    expect(html).toContain(LIVE_CHANNEL_NAME);
    expect(html).toContain('data-testid="event-voice-note"');
    expect(html).toMatch(/stale/i);
    expectViewRead();
  });

  it("events list renders the live voice link on the event row", async () => {
    voiceDb.rows = [liveRow()];
    const f = fixture([
      eventRow({ eventKey: "voice-live-list", startsAt: SOON_START, endsAt: SOON_END }),
    ]);
    const res = await f.request("/events", await f.memberCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(html).toContain(LIVE_CHANNEL_NAME);
    expect(voiceLinkTagOrEmpty(html)).toContain(jumpHref);
    expectViewRead();
  });

  it("homepage teaser renders the invite fallback for the live event", async () => {
    voiceDb.rows = [liveRow()];
    const f = fixture([
      eventRow({ eventKey: "voice-live-home", startsAt: SOON_START, endsAt: SOON_END }),
    ]);
    const res = await f.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Friday game night");
    expect(html).toContain('data-testid="event-voice-block"');
    expect(voiceLinkTagOrEmpty(html)).toContain(INVITE_URL);
    expect(html).not.toContain("discord.com/channels/");
    expectViewRead();
  });
});
