// route-inventory: GET /
// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: GET /e/:key
// route-inventory: GET /e/:file{.+\.md}
// route-inventory: GET /events.md
// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// route-inventory: GET /join
// route-inventory: GET /about
// route-inventory: GET /faq
// route-inventory: GET /rules
// route-inventory: GET /privacy
// route-inventory: GET /about.md
// route-inventory: GET /faq.md
// route-inventory: GET /rules.md
// route-inventory: GET /privacy.md
// route-inventory: GET /join.md
// route-inventory: GET /llms.txt
// route-inventory: GET /robots.txt
// route-inventory: GET /sitemap_index.xml
// route-inventory: GET /openapi.json
// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// route-inventory: GET /events.rss
// route-inventory: GET /events.ics
// route-inventory: GET /events/:file{.+\.ics}
// route-inventory: GET /discord
// route-inventory: GET /login
// route-inventory: GET /community
// No-member-data contract on public Hono payloads (acceptance).
//
// Every anonymous Hono GET must serve HTML/JSON/RSS/ICS/Markdown free of
// Discord IDs/usernames, snowflakes, emails and session artifacts. Detector
// shape follows the Kit twin (`test/kit-no-member-data-contract.test.ts`):
// plant hostile needles in member-data fields, drive the real route handler,
// and assert the needles (plus route-specific key shapes) are absent — with
// aggregate-presence pins proving each test is not vacuous.
//
// Enumeration (PUBLIC_HONO_GETS below is the one repo source of truth; the
// S7 gate reports one stable check ID per row): `/`, `/events`,
// `/events/past`, `/e/:key`, `/e/:key.md`, `/events.md`,
// `/api/public/events`, `/api/public/events/:key`, `/api/public/community`,
// `/api/public/join`, `/join`, `/about`, `/faq`, `/rules`, `/privacy`, the
// static Markdown twins (`/about.md`, `/faq.md`, `/rules.md`, `/privacy.md`,
// `/join.md`, `/llms.txt`), `/robots.txt`, `/sitemap_index.xml`,
// `/openapi.json`, `/hotzones`, `/hotzones/joins|voice|games`, the feeds
// (`/events.rss`, `/events.ics`, `/events/:key.ics`), and the vanity
// redirects (`/discord`, `/login`, `/community`).
//
// Notes on the enumeration:
// - No `/e/:key.json` route exists (verified by grep): the public per-event
//   JSON is `/api/public/events/:key`, which this suite pins as the `.json`
//   alternate. `/events/:key` is member-gated JSON (401/302 anonymous) and
//   serves as a negative control instead.
// - The `webcal://` subscription URL is a scheme rewrite of `/events.ics`
//   (`webcalUrl` in `src/events/feeds.ts`), not a separate route.
// - Out of slice by design: `/up` (ops health, own DB client, no member
//   bytes by construction) and the auth/session flow (`/auth/*`,
//   `/join/discord`, `/join/callback`), which the auth suites own.
// - Redirects carry no body: their rows pin 302 + Location allowlist.
//
// Leak model notes (mirroring the twin):
// - `events.created_by` holds the authoring moderator's Discord snowflake.
//   Retention is documented policy; anonymous PUBLICATION is the leak this
//   contract forbids. `PublicEvent` carries the full row, so every renderer
//   must project before serving — this suite verifies each projection.
// - No email column exists anywhere by policy ("we never ask for one"), so
//   the email needle rides the username vectors (users rows, widget members,
//   ranking-shaped rows) to prove those vectors echo nothing email-shaped.
// - Discord *event* ids (discordEventId, transient discordId) and the widget
//   guild id are public by design (subscribe links, widget URL); they use
//   fixed non-needle values and are never asserted absent.
// - Session artifacts are pinned by bearer SHAPE (`two_` + 43 chars), not by
//   the `two_` prefix: the privacy copy legitimately names `__Host-two_*`
//   cookies, so a prefix scan would false-positive on `/privacy` by design.
//
// Base-head verdicts (2026-10-22, commit 551d60ae5; RED run
// `npx vitest run test/hono-no-member-data-contract.test.ts`: 40 passed,
// 1 failed — the failure is the missing S7 gate, never a fixture typo):
// - FAIL the S7 gate test: no `check:hono-payloads` script or gate file
//   exists yet. The paired build implements the gate; this suite pins its
//   contract (invocation, JSON shape, all 34 stable check IDs).
// - PASS every anonymous payload: no leak on the base head; the pins guard
//   the boundary (home, calendar, past, detail + .md, events.md, public
//   JSON API x4, join, leaves x4, static Markdown twins x6, robots,
//   sitemap, openapi, hotzones x4, feeds x3, redirects x3).
// - PASS all negative controls (member profile + own profile + gated event
//   JSON keep their audited reads; the detector fires on member bytes).
// - Sensitivity proven by mutation (both reverted): a `created_by` field
//   added to the public DTO fails the api-events-item test on the
//   authorship needle, and an X- header carrying `createdBy` added to the
//   ICS builder fails the feed-ics test on the same needle.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import { priorGrid } from "../src/hotzones/aggregates";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { profilesApp } from "../src/profiles/routes";
import type { MemberStatsSource } from "../src/profiles/stats";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { discordWidgetHealth } from "../src/discord-widget";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

// ---------------------------------------------------------------------------
// Source of truth: every anonymous Hono GET, one stable check ID per row.
// The S7 gate (`npm run check:hono-payloads`) reports exactly these IDs.
// ---------------------------------------------------------------------------

type HonoPayloadRow = {
  id: string;
  method: "GET";
  route: string;
  kind: "payload" | "redirect";
};

const PUBLIC_HONO_GETS: HonoPayloadRow[] = [
  { id: "hono-payload:home", method: "GET", route: "/", kind: "payload" },
  { id: "hono-payload:events", method: "GET", route: "/events", kind: "payload" },
  { id: "hono-payload:events-past", method: "GET", route: "/events/past", kind: "payload" },
  { id: "hono-payload:event-detail", method: "GET", route: "/e/:key", kind: "payload" },
  { id: "hono-payload:event-detail-md", method: "GET", route: "/e/:key.md", kind: "payload" },
  { id: "hono-payload:events-md", method: "GET", route: "/events.md", kind: "payload" },
  { id: "hono-payload:api-events", method: "GET", route: "/api/public/events", kind: "payload" },
  {
    id: "hono-payload:api-events-item",
    method: "GET",
    route: "/api/public/events/:key",
    kind: "payload",
  },
  {
    id: "hono-payload:api-community",
    method: "GET",
    route: "/api/public/community",
    kind: "payload",
  },
  { id: "hono-payload:api-join", method: "GET", route: "/api/public/join", kind: "payload" },
  { id: "hono-payload:join", method: "GET", route: "/join", kind: "payload" },
  { id: "hono-payload:about", method: "GET", route: "/about", kind: "payload" },
  { id: "hono-payload:faq", method: "GET", route: "/faq", kind: "payload" },
  { id: "hono-payload:rules", method: "GET", route: "/rules", kind: "payload" },
  { id: "hono-payload:privacy", method: "GET", route: "/privacy", kind: "payload" },
  { id: "hono-payload:about-md", method: "GET", route: "/about.md", kind: "payload" },
  { id: "hono-payload:faq-md", method: "GET", route: "/faq.md", kind: "payload" },
  { id: "hono-payload:rules-md", method: "GET", route: "/rules.md", kind: "payload" },
  { id: "hono-payload:privacy-md", method: "GET", route: "/privacy.md", kind: "payload" },
  { id: "hono-payload:join-md", method: "GET", route: "/join.md", kind: "payload" },
  { id: "hono-payload:llms", method: "GET", route: "/llms.txt", kind: "payload" },
  { id: "hono-payload:robots", method: "GET", route: "/robots.txt", kind: "payload" },
  { id: "hono-payload:sitemap", method: "GET", route: "/sitemap_index.xml", kind: "payload" },
  { id: "hono-payload:openapi", method: "GET", route: "/openapi.json", kind: "payload" },
  { id: "hono-payload:hotzones", method: "GET", route: "/hotzones", kind: "payload" },
  {
    id: "hono-payload:hotzones-joins",
    method: "GET",
    route: "/hotzones/joins",
    kind: "payload",
  },
  {
    id: "hono-payload:hotzones-voice",
    method: "GET",
    route: "/hotzones/voice",
    kind: "payload",
  },
  {
    id: "hono-payload:hotzones-games",
    method: "GET",
    route: "/hotzones/games",
    kind: "payload",
  },
  { id: "hono-payload:feed-rss", method: "GET", route: "/events.rss", kind: "payload" },
  { id: "hono-payload:feed-ics", method: "GET", route: "/events.ics", kind: "payload" },
  {
    id: "hono-payload:feed-event-ics",
    method: "GET",
    route: "/events/:key.ics",
    kind: "payload",
  },
  { id: "hono-payload:discord-redirect", method: "GET", route: "/discord", kind: "redirect" },
  { id: "hono-payload:login-redirect", method: "GET", route: "/login", kind: "redirect" },
  { id: "hono-payload:community-redirect", method: "GET", route: "/community", kind: "redirect" },
];

const CHECK_ID_RE = /^hono-payload:[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Detector: planted needles + bearer shape + route key shapes.
// (Needle values mirror the Kit twin so both suites grep as one contract.)
// ---------------------------------------------------------------------------

/** Non-guild snowflakes: authorship marks, user ids, join-attempt identities. */
const PROBE_SNOWFLAKE = "987654321098765432";
const PROBE_SNOWFLAKE_2 = "876543210987654321";
const PROBE_SNOWFLAKE_3 = "765432109876543210";

/** Bidi-hostile username: RLO ... PDF plus a trailing RLM (ASCII escapes only). */
const PROBE_USERNAME = "leak-probe-\u202Erebmem-zz9\u202C\u200F";
/** Zalgo/CJK/emoji username (ASCII escapes only). */
const PROBE_USERNAME_2 = "leak-probe-\u0301\uD83D\uDC80\u6F22\u5B57-qq4";
/** Email-shaped username: no email column exists, so the email pin rides the
 * username vectors to prove they echo nothing email-shaped. */
const PROBE_EMAIL = "leak-probe-member-zz9@example.test";

const MEMBER_NEEDLES = [
  PROBE_SNOWFLAKE,
  PROBE_SNOWFLAKE_2,
  PROBE_SNOWFLAKE_3,
  PROBE_USERNAME,
  PROBE_USERNAME_2,
  PROBE_EMAIL,
];

/** Minted bearer shape (`two_` + 43 base64url chars); cookie-name prose never matches. */
const SESSION_BEARER_RE = /two_[A-Za-z0-9_-]{43}/;
const PROBE_SESSION = `two_${"z".repeat(43)}`;

/** Bigint-safe serialization: event rows carry bigint revisions. */
function serializePayload(data: unknown): string {
  return JSON.stringify(data, (_key, value: unknown) =>
    typeof value === "bigint" ? `bigint:${value.toString()}` : value,
  );
}

function findMemberBytes(bytes: string, extraKeys: string[] = []): string[] {
  const found = MEMBER_NEEDLES.filter((needle) => bytes.includes(needle));
  if (SESSION_BEARER_RE.test(bytes)) found.push("session-bearer-shape");
  for (const key of extraKeys) {
    if (bytes.includes(key)) found.push(key);
  }
  return found;
}

function assertNoMemberBytes(bytes: string, route: string, extraKeys: string[] = []): void {
  for (const needle of MEMBER_NEEDLES) {
    expect(bytes, `${route} payload leaked ${needle}`).not.toContain(needle);
  }
  expect(bytes, `${route} payload leaked a session bearer`).not.toMatch(SESSION_BEARER_RE);
  for (const key of extraKeys) {
    expect(bytes, `${route} payload leaked ${key}`).not.toContain(key);
  }
}

// ---------------------------------------------------------------------------
// Hostile fixtures: maximal fields, every member-data column populated.
// ---------------------------------------------------------------------------

/** Public-by-design Discord event/guild ids: fixed values, never needles. */
const PUBLIC_DISCORD_EVENT_ID = "111222333444555667";
const GUILD_ID = "326474832151838730";

/** Canonical uppercase ULID: passes the route's canonical-301 check untouched. */
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_STARTS_AT = new Date("2030-11-05T18:00:00.000Z");
const EVENT_ENDS_AT = new Date("2030-11-05T21:00:00.000Z");
const PAST_STARTS_AT = new Date("2020-08-05T18:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-08-05T21:00:00.000Z");
const HOSTILE_TITLE = "Hostile Teaser Title zz9 \u6F22\u5B57";
const HOSTILE_FEATURED_TITLE = "Hostile Featured zz9";

/** Full event row as the database returns it: `select().from(events)` keeps
 * every column, including the authorship snowflake (never rendered publicly). */
function hostileEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    icsSequence: 1n,
    eventKey: EVENT_KEY,
    title: HOSTILE_TITLE,
    game: "Hostile Game qq4",
    description: "Hostile description \u2026 \uD83D\uDC80 with maximal fields",
    accessibilityNotes: "Hostile access notes",
    startsAt: EVENT_STARTS_AT,
    endsAt: EVENT_ENDS_AT,
    timezone: "Europe/London",
    location: "Hostile Hall qq4",
    capacity: 25,
    status: "published",
    rsvpOpen: true,
    discordEventId: PUBLIC_DISCORD_EVENT_ID,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 3,
    syncedRevision: 2,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: PROBE_SNOWFLAKE,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    ...overrides,
  };
}

function hostileUsers(): { id: string; username: string }[] {
  return [
    { id: PROBE_SNOWFLAKE, username: PROBE_USERNAME },
    { id: PROBE_SNOWFLAKE_2, username: PROBE_EMAIL },
  ];
}

/** Two named going rows plus one orphan going row (no users row at all):
 * named count 2, occupied count 3 — the aggregates stay honest. */
function hostileRsvps(eventId: number): { eventId: number; userId: string; status: string }[] {
  return [
    { eventId, userId: PROBE_SNOWFLAKE, status: "going" },
    { eventId, userId: PROBE_SNOWFLAKE_2, status: "going" },
    { eventId, userId: "100000000000000001", status: "going" },
  ];
}

/** Positional 8-column featured rows (id, title, body, url, imageUrl,
 * imageAlt, startsAt, endsAt); null bounds are always live. */
function hostileFeatured(): unknown[][] {
  return [[11, HOSTILE_FEATURED_TITLE, "Hostile featured body", null, null, null, null, null]];
}

function hostileAttempts(): { discordId: string; outcome: string; createdAt: Date }[] {
  return [
    { discordId: PROBE_SNOWFLAKE, outcome: "added", createdAt: new Date("2026-01-05T18:10:00Z") },
    {
      discordId: PROBE_SNOWFLAKE_2,
      outcome: "already_member",
      createdAt: new Date("2026-01-05T18:40:00Z"),
    },
    { discordId: PROBE_SNOWFLAKE, outcome: "added", createdAt: new Date("2026-01-06T09:00:00Z") },
    { discordId: PROBE_SNOWFLAKE_2, outcome: "error", createdAt: new Date("2026-01-06T10:00:00Z") },
    { discordId: PROBE_SNOWFLAKE_3, outcome: "added", createdAt: new Date("2026-01-06T11:00:00Z") },
  ];
}

function hostileProfiles(): { userId: string; leaderboardOptOut: boolean | null }[] {
  return [
    { userId: PROBE_SNOWFLAKE, leaderboardOptOut: false },
    { userId: PROBE_SNOWFLAKE_3, leaderboardOptOut: true },
  ];
}

/** Display-only Discord transient: public event data, distinctive title. */
function hostileTransient(): {
  discordId: string;
  status: "scheduled";
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
} {
  return {
    discordId: "222333444555666778",
    status: "scheduled",
    title: "Hostile Discord Transient qq4",
    description: null,
    location: "Discord Stage",
    startsAt: new Date(Date.now() + 7200_000),
    endsAt: null,
  };
}

function hostileWidgetJson(): Record<string, unknown> {
  return {
    id: GUILD_ID,
    name: "Together We Own",
    instant_invite: "https://discord.gg/widget-invite",
    presence_count: 42,
    channels: [{ id: "1", name: "stage-night", position: 1 }],
    members: [
      { username: PROBE_USERNAME, status: "dnd" },
      { username: PROBE_EMAIL, status: "idle" },
      { username: PROBE_USERNAME_2, status: "online" },
    ],
  };
}

// ---------------------------------------------------------------------------
// pg-proxy fake: stored hostile rows, computed aggregates.
// ---------------------------------------------------------------------------

type FakeStored = {
  eventRows: Record<string, unknown>[];
  users: { id: string; username: string }[];
  rsvps: { eventId: number; userId: string; status: string }[];
  featured: unknown[][];
  attempts: { discordId: string; outcome: string; createdAt: Date }[];
  profiles: { userId: string; leaderboardOptOut: boolean | null }[];
  eventsCount: number;
};

function storedFixture(overrides: Partial<FakeStored> = {}): FakeStored {
  return {
    eventRows: [],
    users: [],
    rsvps: [],
    featured: [],
    attempts: [],
    profiles: [],
    eventsCount: 0,
    ...overrides,
  };
}

function fakeDb(stored: FakeStored): Db {
  const eventColumns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const toRow = (row: Record<string, unknown>): unknown[] =>
    eventColumns.map((key) => {
      const value = row[key as string];
      return value instanceof Date ? value.toISOString() : (value ?? null);
    });
  const db = drizzle(async (sql: string) => {
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "featured_contents"')) {
      // The published-base read selects the window bounds, the direct
      // visible read only filters.
      const selectList = sql.slice(0, sql.indexOf('from "featured_contents"'));
      const isBaseRead = selectList.includes('"starts_at"');
      return { rows: isBaseRead ? stored.featured : stored.featured.map((row) => row.slice(0, 6)) };
    }
    if (sql.includes('from "rsvps"')) {
      // The roster/attendee projection joins users without a group-by and
      // returns individual rows; this suite never drives a member attendee
      // read through the main app, so it stays empty.
      if (sql.includes('"users"') && !sql.includes("group by")) return { rows: [] };
      // The going-count pair: the named leg joins users and drops nameless
      // rows, the occupancy leg counts every going row. The combined
      // aggregate returns (event_id, named, occupied) in one row.
      const countFor = (eventId: number, namedOnly: boolean) => {
        let n = 0;
        for (const rsvp of stored.rsvps) {
          if (rsvp.eventId !== eventId || rsvp.status !== "going") continue;
          if (namedOnly) {
            const user = stored.users.find((u) => u.id === rsvp.userId);
            if (!user || user.username === "") continue;
          }
          n += 1;
        }
        return n;
      };
      if (sql.includes('left join "users"') && sql.includes("group by")) {
        const ids = new Set(stored.rsvps.filter((r) => r.status === "going").map((r) => r.eventId));
        return {
          rows: [...ids].map((eventId) => [
            eventId,
            countFor(eventId, true),
            countFor(eventId, false),
          ]),
        };
      }
      const namedOnly = sql.includes('"users"');
      const byEvent = new Map<number, number>();
      for (const rsvp of stored.rsvps) {
        if (rsvp.status !== "going") continue;
        if (namedOnly) {
          const user = stored.users.find((u) => u.id === rsvp.userId);
          if (!user || user.username === "") continue;
        }
        byEvent.set(rsvp.eventId, (byEvent.get(rsvp.eventId) ?? 0) + 1);
      }
      return { rows: [...byEvent.entries()].map(([eventId, n]) => [eventId, n]) };
    }
    if (sql.includes('from "join_attempts"')) {
      // The joins-grid aggregate: successful outcomes, opted-out profiles
      // excluded, grouped by UTC weekday/hour (the `all` window has no
      // date bounds, so stored dates group directly).
      const buckets = new Map<string, number>();
      for (const attempt of stored.attempts) {
        if (attempt.outcome !== "added" && attempt.outcome !== "already_member") continue;
        const profile = stored.profiles.find((p) => p.userId === attempt.discordId);
        if (profile && profile.leaderboardOptOut === true) continue;
        const key = `${attempt.createdAt.getUTCDay()}:${attempt.createdAt.getUTCHours()}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      return {
        rows: [...buckets.entries()].map(([key, n]) => {
          const [dow, hr] = key.split(":").map(Number);
          return [dow, hr, n];
        }),
      };
    }
    if (sql.includes('from "events"')) {
      if (sql.includes("count(")) return { rows: [[stored.eventsCount]] };
      if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
      if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
      return { rows: stored.eventRows.map(toRow) };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return db;
}

// ---------------------------------------------------------------------------
// Env + hygiene: the real app, only the Worker bindings faked.
// ---------------------------------------------------------------------------

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

function baseEnv(extra: Record<string, unknown> = {}): Env {
  return {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "test-discord-client-secret",
    DISCORD_BOT_TOKEN: "test-discord-bot-token",
    SESSION_SECRET,
    SESSION_STORE: createMemorySessionStore(),
    RULES_LAST_UPDATED: "2026-01-01",
    FEATURED_IMAGE_HOSTS: "example.test",
    ...extra,
  } as unknown as Env;
}

afterEach(() => {
  __resetHomeGuestCacheForTests();
  __resetAnonEventCacheForTests();
  __resetApiPublicCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function memberCookie(
  store: SessionStore,
  actor: { userId: string; username: string; member: boolean; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
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

// ---------------------------------------------------------------------------
// Detector + fixture + enumeration self-checks (prove the pins are not vacuous).
// ---------------------------------------------------------------------------

describe("no-member-data detector", () => {
  it("flags every planted needle and the bearer shape, and passes a clean payload", () => {
    const hostile = {
      createdBy: PROBE_SNOWFLAKE,
      ids: [PROBE_SNOWFLAKE_2, PROBE_SNOWFLAKE_3],
      names: [PROBE_USERNAME, PROBE_USERNAME_2, PROBE_EMAIL],
      bearer: PROBE_SESSION,
    };
    const found = findMemberBytes(serializePayload(hostile), ['"createdBy"']);
    expect(found).toContain(PROBE_SNOWFLAKE);
    expect(found).toContain(PROBE_SNOWFLAKE_2);
    expect(found).toContain(PROBE_SNOWFLAKE_3);
    expect(found).toContain(PROBE_USERNAME);
    expect(found).toContain(PROBE_USERNAME_2);
    expect(found).toContain(PROBE_EMAIL);
    expect(found).toContain("session-bearer-shape");
    expect(found).toContain('"createdBy"');
    expect(findMemberBytes(serializePayload({ title: "clean", n: 1 }))).toEqual([]);
    expect(findMemberBytes("__Host-two_session cookie-name prose")).toEqual([]);
  });

  it("fixtures actually carry the hostile needles", () => {
    const bytes = serializePayload({
      event: hostileEventRow(),
      users: hostileUsers(),
      rsvps: hostileRsvps(7),
      attempts: hostileAttempts(),
      widget: hostileWidgetJson(),
    });
    for (const needle of MEMBER_NEEDLES) {
      expect(bytes, `fixture dropped ${needle}`).toContain(needle);
    }
  });

  it("the route table carries one stable check ID per anonymous GET", () => {
    const ids = PUBLIC_HONO_GETS.map((row) => row.id);
    expect(new Set(ids).size, "duplicate check IDs").toBe(ids.length);
    for (const row of PUBLIC_HONO_GETS) {
      expect(row.id, `unstable check ID ${row.id}`).toMatch(CHECK_ID_RE);
      expect(row.method).toBe("GET");
    }
    expect(PUBLIC_HONO_GETS.length).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// Anonymous payloads.
// ---------------------------------------------------------------------------

describe("Hono GET / anonymous payload", () => {
  it("serves hostile rows with aggregates only: no createdBy, usernames or bearers", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
          featured: hostileFeatured(),
        }),
      ),
      DISCORD_EVENTS: {
        upcoming: async () => [hostileTransient()],
        lastReadFailed: () => false,
      },
    });
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the hostile teaser + transient + featured all rendered.
    expect(html).toContain(HOSTILE_TITLE);
    expect(html).toContain("Hostile Discord Transient qq4");
    expect(html).toContain(HOSTILE_FEATURED_TITLE);
    expect(html).toContain('data-testid="home-events-list"');

    assertNoMemberBytes(html, "GET /", ['"createdBy"', "created_by"]);
  });
});

describe("Hono GET /events anonymous payload", () => {
  it("renders hostile rows with aggregates only and no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
          eventsCount: 1,
        }),
      ),
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    });
    const res = await app.request("/events", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the hostile row rendered into the calendar list body.
    expect(html).toContain('data-testid="events-list"');
    expect(html).toContain(HOSTILE_TITLE);

    assertNoMemberBytes(html, "GET /events", ['"createdBy"', "created_by"]);
  });
});

describe("Hono GET /events/past anonymous payload", () => {
  it("serves hostile archive rows with no authorship snowflakes or member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [
            hostileEventRow({
              id: eventId,
              startsAt: PAST_STARTS_AT,
              endsAt: PAST_ENDS_AT,
            }),
          ],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
          eventsCount: 1,
        }),
      ),
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    });
    const res = await app.request("/events/past", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the hostile archived row rendered with honest aggregates.
    expect(html).toContain('data-testid="past-events-list"');
    expect(html).toContain(HOSTILE_TITLE);

    assertNoMemberBytes(html, "GET /events/past", ['"createdBy"', "created_by"]);
  });
});

describe("Hono GET /e/:key anonymous payload", () => {
  it("serves the hostile event with no authorship snowflake, attendees or bearers", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request(`/e/${EVENT_KEY}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the detail rendered venue, JSON-LD and the .md alternate.
    expect(html).toContain(HOSTILE_TITLE);
    expect(html).toContain("Hostile Hall qq4");
    expect(html).toContain(EVENT_KEY);
    expect(html).toContain(`/e/${EVENT_KEY}.md`);

    assertNoMemberBytes(html, "GET /e/:key", ['"createdBy"', "created_by"]);
  });
});

describe("Hono GET /e/:key.md anonymous payload", () => {
  it("serves the hostile event Markdown with no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request(`/e/${EVENT_KEY}.md`, {}, env);
    expect(res.status).toBe(200);
    const md = await res.text();

    expect(md).toContain(HOSTILE_TITLE);

    assertNoMemberBytes(md, "GET /e/:key.md", ["createdBy", "created_by"]);
  });
});

describe("Hono GET /events.md anonymous payload", () => {
  it("serves the hostile schedule Markdown with no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request("/events.md", {}, env);
    expect(res.status).toBe(200);
    const md = await res.text();

    expect(md).toContain(HOSTILE_TITLE);

    assertNoMemberBytes(md, "GET /events.md", ["createdBy", "created_by"]);
  });
});

describe("Hono public JSON API anonymous payloads", () => {
  it("GET /api/public/events/:key serves the projected DTO with no member keys", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request(`/api/public/events/${EVENT_KEY}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    const dto = JSON.parse(body) as Record<string, unknown>;

    // Non-vacuous: the hostile row projected with honest aggregates.
    expect(dto["event_key"]).toBe(EVENT_KEY);
    expect(dto["title"]).toBe(HOSTILE_TITLE);
    expect(dto["going_count"]).toBe(2);
    expect(dto["going_occupancy"]).toBe(3);
    expect(dto["synced_to_discord"]).toBe(true);

    assertNoMemberBytes(body, "GET /api/public/events/:key", [
      '"createdBy"',
      '"created_by"',
      '"discord_event_id"',
      '"discordEventId"',
    ]);
  });

  it("GET /api/public/events serves the projected collection with no member keys", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
          eventsCount: 1,
        }),
      ),
    });
    const res = await app.request("/api/public/events", {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    const payload = JSON.parse(body) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };

    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]?.["event_key"]).toBe(EVENT_KEY);
    expect(payload.data[0]?.["title"]).toBe(HOSTILE_TITLE);
    expect(payload.meta["total"]).toBe(1);

    assertNoMemberBytes(body, "GET /api/public/events", [
      '"createdBy"',
      '"created_by"',
      '"discord_event_id"',
      '"discordEventId"',
    ]);
  });

  it("GET /api/public/community serves counts only with no member bytes", async () => {
    const res = await app.request("/api/public/community", {}, baseEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    const dto = JSON.parse(body) as Record<string, unknown>;

    // Non-vacuous: the count envelope keys, degraded to nulls without a bot DB.
    expect(dto).toHaveProperty("member_count");
    expect(dto).toHaveProperty("online_count");
    expect(dto).toHaveProperty("ranks");

    assertNoMemberBytes(body, "GET /api/public/community");
  });

  it("GET /api/public/join serves the env handoff with no member bytes", async () => {
    const res = await app.request("/api/public/join", {}, baseEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    const dto = JSON.parse(body) as Record<string, unknown>;

    expect(dto).toHaveProperty("intro");
    expect(dto["invite_url"]).toBe("https://discord.gg/invite");

    assertNoMemberBytes(body, "GET /api/public/join");
  });
});

describe("Hono GET /join anonymous payload", () => {
  it("renders aggregates only: no member usernames, emails or statuses", async () => {
    vi.spyOn(discordWidgetHealth, "url").mockReturnValue(null);
    vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue({
      name: "Together We Own",
      presenceCount: 42,
      inviteUrl: "https://discord.gg/widget-invite",
      channels: [{ id: "1", name: "stage-night", position: 1 }],
      members: [
        { username: PROBE_USERNAME, status: "dnd" },
        { username: PROBE_EMAIL, status: "idle" },
        { username: PROBE_USERNAME_2, status: "online" },
      ],
      fetchedAt: new Date("2026-01-06T12:00:00Z").getTime(),
      guildId: GUILD_ID,
    });
    const res = await app.request("/join", {}, baseEnv());
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the hostile snapshot rendered its aggregates.
    expect(html).toContain('data-testid="join-widget-presence"');
    expect(html).toContain("42");
    expect(html).toContain("stage-night");

    assertNoMemberBytes(html, "GET /join");
  });
});

describe("Hono static-leaf anonymous payloads", () => {
  it.each([
    { route: "/about", marker: "next.example.test" },
    { route: "/faq", marker: "next.example.test" },
    { route: "/rules", marker: "next.example.test" },
    { route: "/privacy", marker: "__Host-two_" },
  ])("GET $route serves its leaf with no member bytes", async ({ route, marker }) => {
    const res = await app.request(route, {}, baseEnv());
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: the leaf rendered (privacy names the cookie prefix by design).
    expect(html).toContain(marker);

    assertNoMemberBytes(html, `GET ${route}`);
  });
});

describe("Hono GET /hotzones anonymous payload", () => {
  it("serves computed aggregates with no member bytes", async () => {
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          attempts: hostileAttempts(),
          profiles: hostileProfiles(),
          eventsCount: 1,
        }),
      ),
    });
    const res = await app.request("/hotzones", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Non-vacuous: three successful retained attempts aggregate (the failed
    // and opted-out rows drop out), plus the canned event count.
    expect(html).toContain("for season all: 3 joins across 1 scheduled gatherings.");

    assertNoMemberBytes(html, "GET /hotzones");
  });
});

describe("Hono GET /hotzones/:signal anonymous payloads", () => {
  it("joins serves the live aggregate with no member bytes", async () => {
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          attempts: hostileAttempts(),
          profiles: hostileProfiles(),
          eventsCount: 1,
        }),
      ),
    });
    const res = await app.request("/hotzones/joins", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Join activity for season all: 3 joins");

    assertNoMemberBytes(html, "GET /hotzones/joins");
  });

  it.each(["voice", "games"] as const)(
    "%s serves the seeded estimate with no member bytes",
    async (signal) => {
      const env = baseEnv({ ADMIN_DB: fakeDb(storedFixture()) });
      const res = await app.request(`/hotzones/${signal}`, {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Non-vacuous: the real seeded prior grid, never a live aggregate.
      expect(html).toContain(`Total estimate: ${priorGrid(signal).total}.`);

      assertNoMemberBytes(html, `GET /hotzones/${signal}`);
    },
  );
});

describe("Hono feed anonymous payloads", () => {
  it("GET /events.rss serves hostile items with no member fields", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request("/events.rss", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const rss = await res.text();

    expect(rss).toContain(HOSTILE_TITLE);
    expect(rss).toContain(`/e/${EVENT_KEY}`);

    assertNoMemberBytes(rss, "GET /events.rss", ["createdBy", "created_by"]);
  });

  it("GET /events.ics serves hostile events with eventKey@host UIDs and no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request("/events.ics", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const ics = await res.text();

    expect(ics).toContain(HOSTILE_TITLE);
    expect(ics).toContain(`UID:${EVENT_KEY}@next.example.test`);

    assertNoMemberBytes(ics, "GET /events.ics", ["createdBy", "created_by"]);
  });

  it("GET /events/:key.ics serves the hostile event with no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request(`/events/${EVENT_KEY}.ics`, {}, env);
    expect(res.status).toBe(200);
    const ics = await res.text();

    expect(ics).toContain(HOSTILE_TITLE);
    expect(ics).toContain(`UID:${EVENT_KEY}@next.example.test`);

    assertNoMemberBytes(ics, "GET /events/:key.ics", ["createdBy", "created_by"]);
  });
});

describe("Hono static discovery anonymous payloads", () => {
  it.each([
    { route: "/llms.txt", marker: "next.example.test" },
    { route: "/robots.txt", marker: "next.example.test" },
    { route: "/openapi.json", marker: "next.example.test" },
    { route: "/about.md", marker: "next.example.test" },
    { route: "/faq.md", marker: "next.example.test" },
    { route: "/rules.md", marker: "next.example.test" },
    { route: "/privacy.md", marker: "next.example.test" },
    { route: "/join.md", marker: "discord.gg/invite" },
  ])("GET $route serves static bytes with no member data", async ({ route, marker }) => {
    const res = await app.request(route, {}, baseEnv());
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain(marker);

    assertNoMemberBytes(body, `GET ${route}`);
  });

  it("GET /sitemap_index.xml lists the hostile event URL with no member bytes", async () => {
    const eventId = 7;
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
    });
    const res = await app.request("/sitemap_index.xml", {}, env);
    expect(res.status).toBe(200);
    const xml = await res.text();

    expect(xml).toContain(`/e/${EVENT_KEY}`);

    assertNoMemberBytes(xml, "GET /sitemap_index.xml", ["createdBy", "created_by"]);
  });
});

describe("Hono vanity-redirect anonymous GETs", () => {
  it.each([
    { route: "/discord", location: "https://discord.gg/invite" },
    { route: "/login", location: "/auth/discord" },
    { route: "/community", location: "/" },
  ])("GET $route redirects with no body bytes", async ({ route, location }) => {
    const res = await app.request(route, {}, baseEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(location);
    const body = await res.text();

    expect(body.length).toBeLessThan(1024);

    assertNoMemberBytes(body, `GET ${route}`);
  });
});

// ---------------------------------------------------------------------------
// Negative controls: member-gated reads still work, and the detector fires.
// ---------------------------------------------------------------------------

function hostileMember(): MemberView {
  return {
    id: PROBE_SNOWFLAKE_3,
    username: PROBE_USERNAME,
    avatar: null,
    bio: PROBE_USERNAME_2,
    games: ["hostile-game-qq4"],
    timezone: "Europe/London",
  };
}

function memberGatedApp(member: MemberView) {
  const sessions = createMemorySessionStore();
  const gated = profilesApp({
    sessionStore: sessions,
    store: createMemoryProfileStore([member]),
    stats: ((_id: string, _signal: AbortSignal) => Promise.resolve(null)) as MemberStatsSource,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  return { sessions, gated };
}

describe("member-gated negative controls", () => {
  it("GET /members/:user keeps its audited read: hostile member still served to members", async () => {
    const member = hostileMember();
    const { sessions, gated } = memberGatedApp(member);
    const cookie = await memberCookie(sessions, {
      userId: PROBE_SNOWFLAKE,
      username: PROBE_USERNAME_2,
      member: true,
      moderator: false,
    });
    const res = await gated.request(`/members/${member.id}`, { headers: { cookie } }, baseEnv());
    expect(res.status).toBe(200);
    const html = await res.text();

    // The audited read is preserved: the hostile username reaches the member.
    expect(html).toContain(PROBE_USERNAME);
    // And the detector fires on real member data (positive control).
    expect(findMemberBytes(html)).toContain(PROBE_USERNAME);
  });

  it("GET /profile keeps its audited read: the hostile own-profile still renders", async () => {
    const member = hostileMember();
    const { sessions, gated } = memberGatedApp(member);
    const cookie = await memberCookie(sessions, {
      userId: member.id,
      username: member.username,
      member: true,
      moderator: false,
    });
    const res = await gated.request("/profile", { headers: { cookie } }, baseEnv());
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(PROBE_USERNAME);
    expect(findMemberBytes(html)).toContain(PROBE_USERNAME);
  });

  it("GET /events/:key keeps its gated JSON read: member session still served", async () => {
    const eventId = 7;
    const store = createMemorySessionStore();
    const env = baseEnv({
      ADMIN_DB: fakeDb(
        storedFixture({
          eventRows: [hostileEventRow({ id: eventId })],
          users: hostileUsers(),
          rsvps: hostileRsvps(eventId),
        }),
      ),
      SESSION_STORE: store,
    });
    const cookie = await memberCookie(store, {
      userId: PROBE_SNOWFLAKE_2,
      username: PROBE_EMAIL,
      member: true,
      moderator: false,
    });
    const res = await app.request(
      `/events/${EVENT_KEY}`,
      { headers: { cookie, accept: "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: Record<string, unknown> };

    // The gated read still works: the projected event with its aggregates.
    expect(payload.data["event_key"]).toBe(EVENT_KEY);
    expect(payload.data["title"]).toBe(HOSTILE_TITLE);
    expect(payload.data["going_count"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AX: one JSON-reporting agent-runnable check with stable check IDs.
// ---------------------------------------------------------------------------

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("S7 agent-runnable gate", () => {
  it("npm run check:hono-payloads reports every route-table ID as JSON", () => {
    const scripts = readPackageScripts();
    const command = scripts["check:hono-payloads"];
    expect(
      command,
      "missing S7 gate: package.json needs a check:hono-payloads script reporting PUBLIC_HONO_GETS",
    ).toBeTruthy();
    const target = command!.match(/node\s+(\S+\.mjs)/)?.[1];
    expect(target, `unparseable gate command: ${command}`).toBeTruthy();
    const targetPath = resolve(root, target!);
    expect(existsSync(targetPath), `missing gate file: ${target}`).toBe(true);

    const run = spawnSync("node", [targetPath, "--format", "json"], {
      cwd: root,
      timeout: 120_000,
      encoding: "utf8",
    });
    expect(run.status, `gate failed: ${run.stderr}`.slice(0, 2000)).toBe(0);
    const report = JSON.parse(run.stdout) as {
      checks?: Array<{ id?: unknown; route?: unknown; status?: unknown }>;
    };
    expect(Array.isArray(report.checks), "gate must report a checks array").toBe(true);
    const checks = report.checks!;
    const byId = new Map(checks.map((check) => [check.id, check]));
    for (const row of PUBLIC_HONO_GETS) {
      const check = byId.get(row.id);
      expect(check, `gate report missing stable check ID ${row.id}`).toBeTruthy();
      expect(check!.route).toBe(row.route);
      expect(check!.status).toBe("pass");
    }
    expect(checks.length).toBe(PUBLIC_HONO_GETS.length);
  });
});
