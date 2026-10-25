// No-member-data contract on public Kit payloads (acceptance).
//
// Every Kit GET reachable without a member session must serve load data
// (what SvelteKit serializes at `__data.json`, or the response body for the
// endpoint route) free of Discord IDs/usernames, snowflakes, emails and
// session artifacts. Detector shape follows the join-only precedent: plant
// hostile needles in member-data fields, serialize the real load output, and
// assert the needles (plus route-specific key shapes) are absent — with
// aggregate-presence pins proving each test is not vacuous.
//
// Enumeration (public Kit GETs per docs/kit-parity-gates.md): `/`, `/events`,
// `/events/past`, `/about`, `/faq`, `/rules`, `/privacy`, `/join`,
// `/hotzones`, `/hotzones/joins`, `/hotzones/voice`, `/hotzones/games`.
// Out of scope per the card: `/e/:key` (Hono-owned member-read boundary) and
// `/auth/recover` (Hono-owned transient outcome page).
//
// Leak model notes:
// - `events.created_by` / `featured_contents.created_by` hold the authoring
//   moderator's Discord snowflake (Actor.id = session userId). Retention is
//   documented policy (privacy-content authorship marks); anonymous
//   PUBLICATION in `__data.json` is the leak this contract forbids. The
//   column is never rendered by any public renderer (verified by grep).
// - No email column exists anywhere by policy ("we never ask for one"), so
//   the email needle rides the username vectors (widget members, users rows,
//   ranking rows) to prove those vectors echo nothing email-shaped.
// - Discord *event* ids (discordEventId, transient discordId) and the widget
//   guild id are public by design (subscribe links, widget URL); they use
//   fixed non-needle values and are never asserted absent.
// - Session artifacts are pinned by bearer SHAPE (`two_` + 43 chars), not by
//   the `two_` prefix: the privacy copy legitimately names `__Host-two_*`
//   cookies, so a prefix scan would false-positive on `/privacy` by design.
//
// Base-head verdicts (2026-10-22, commit 2b18ade80; CONFIRMED by the red run
// `npx vitest run test/kit-no-member-data-contract.test.ts`: 15 passed,
// 2 failed, each failure on a leaked needle, never on a fixture typo):
// - FAIL `/join`: widgetSnapshot carries member usernames/statuses (fixed by
//   the open join-projection change; this suite pins the contract, not the fix).
// - FAIL `/events/past`: rows carry the authorship snowflake (`createdBy`).
// - PASS `/`, `/events`, `/about`, `/faq`, `/rules`, `/privacy`,
//   `/hotzones`, `/hotzones/joins`, `/hotzones/voice`, `/hotzones/games`:
//   no leak on the base head; the pins guard the boundary.
// - PASS all negative controls (detector positive + audited reads preserved).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { priorGrid } from "../src/hotzones/aggregates";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import { loadMembersBoardData } from "../src/kit-members";
import { resolveKitProfile } from "../src/profiles/kit";
import type { MemberView } from "../src/profiles/store";
import type { PublicEvent } from "../src/events/reads";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

// ---------------------------------------------------------------------------
// Detector: planted needles + bearer shape + route key shapes.
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

/** Bigint-safe serialization: event rows carry bigint revisions SvelteKit
 * serves via devalue; JSON.stringify would throw on them. */
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

const EVENT_STARTS_AT = new Date("2026-11-05T18:00:00.000Z");
const EVENT_ENDS_AT = new Date("2026-11-05T21:00:00.000Z");
const PAST_STARTS_AT = new Date("2026-08-05T18:00:00.000Z");
const PAST_ENDS_AT = new Date("2026-08-05T21:00:00.000Z");

/** Full event row as the database returns it: `select().from(events)` keeps
 * every column, including the authorship snowflake (never rendered publicly). */
function hostileEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    eventKey: "hostile-event-key-zz9",
    title: "Hostile Teaser Title zz9 \u6F22\u5B57",
    game: "Hostile Game qq4",
    description: "Hostile description \u2026 \uD83D\uDC80 with maximal fields",
    accessibilityNotes: "Hostile access notes",
    startsAt: EVENT_STARTS_AT,
    endsAt: EVENT_ENDS_AT,
    timezone: "Europe/London",
    location: "Hostile Hall qq4",
    organizer_name: "Hostile Organizer Display",
    join_url: "https://example.test/join/hostile",
    join_instructions: "Hostile instructions",
    capacity: 25,
    status: "published",
    discordEventId: PUBLIC_DISCORD_EVENT_ID,
    syncRevision: 3,
    syncedRevision: 2,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: PROBE_SNOWFLAKE,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    icsSequence: "0",
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
  return [[11, "Hostile Featured zz9", "Hostile featured body", null, null, null, null, null]];
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
      // Same SELECT-list inspection as the home DTO suite: the published-base
      // read selects the window bounds, the direct visible read only filters.
      const selectList = sql.slice(0, sql.indexOf('from "featured_contents"'));
      const isBaseRead = selectList.includes('"starts_at"');
      return { rows: isBaseRead ? stored.featured : stored.featured.map((row) => row.slice(0, 6)) };
    }
    if (sql.includes('from "rsvps"')) {
      // The going-count pair: the named leg joins users and drops nameless
      // rows, the occupancy leg counts every going row.
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
// Bundle harness: the real route loads, only the Worker env stubbed.
// ---------------------------------------------------------------------------

const ENV_KEY = "__kitNoMemberDataContractEnv";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type LoadCookies = { delete: (name: string, options: Record<string, unknown>) => void };
type AnyLoadArgs = {
  url?: URL;
  request?: Request;
  locals?: Record<string, unknown>;
  params?: Record<string, string>;
  cookies?: LoadCookies;
  setHeaders?: (headers: Record<string, string>) => void;
};
type AnyLoad = (args: AnyLoadArgs) => Promise<Record<string, unknown>>;

type BundleLoads = {
  homeLoad: AnyLoad;
  pastLoad: AnyLoad;
  joinLoad: AnyLoad;
  aboutLoad: AnyLoad;
  faqLoad: AnyLoad;
  rulesLoad: AnyLoad;
  privacyLoad: AnyLoad;
  hotzonesLoad: AnyLoad;
  signalLoad: AnyLoad;
  resetHomeGuestCache: () => void;
};

type SharedStub = {
  env: Record<string, unknown>;
  pending: Promise<unknown>[];
  waitUntil: (work: Promise<unknown>) => void;
  kitError: (status: number, message: string) => never;
  kitRedirect: (status: number, location: string) => never;
};

let loads: BundleLoads;
let scratch = "";

function shared(): SharedStub {
  return (globalThis as Record<string, unknown>)[ENV_KEY] as SharedStub;
}

function useEnv(next: Record<string, unknown>): void {
  const env = shared().env;
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, next);
}

function baseEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "test-discord-client-secret",
    DISCORD_BOT_TOKEN: "test-discord-bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    RULES_LAST_UPDATED: "2026-01-01",
    FEATURED_IMAGE_HOSTS: "example.test",
    ...extra,
  };
}

beforeAll(async () => {
  // One bundle exporting every public page load: the real serialization
  // boundary with only the Worker env stubbed. The waitUntil/Kit
  // implementations live here in plain TS, never in generated template
  // strings (the generated stubs are member-access re-exports only).
  const pending: Promise<unknown>[] = [];
  (globalThis as Record<string, unknown>)[ENV_KEY] = {
    env: {},
    pending,
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    kitError: (status: number, message: string): never => {
      throw Object.assign(new Error(message), { status });
    },
    kitRedirect: (status: number, location: string): never => {
      throw Object.assign(new Error("redirect"), { status, location });
    },
  } satisfies SharedStub;
  const route = (rel: string): string => join(root, rel);
  scratch = mkdtempSync(join(tmpdir(), "kit-no-member-data-contract-"));
  const outfile = join(scratch, "kit-public-loads-bundle.mjs");
  await build({
    stdin: {
      contents: [
        `export { load as homeLoad } from ${JSON.stringify(route("web/src/routes/+page.server.ts"))};`,
        `export { load as pastLoad } from ${JSON.stringify(route("web/src/routes/events/past/+page.server.ts"))};`,
        `export { load as joinLoad } from ${JSON.stringify(route("web/src/routes/join/+page.server.ts"))};`,
        `export { load as aboutLoad } from ${JSON.stringify(route("web/src/routes/about/+page.server.ts"))};`,
        `export { load as faqLoad } from ${JSON.stringify(route("web/src/routes/faq/+page.server.ts"))};`,
        `export { load as rulesLoad } from ${JSON.stringify(route("web/src/routes/rules/+page.server.ts"))};`,
        `export { load as privacyLoad } from ${JSON.stringify(route("web/src/routes/privacy/+page.server.ts"))};`,
        `export { load as hotzonesLoad } from ${JSON.stringify(route("web/src/routes/hotzones/+page.server.ts"))};`,
        `export { load as signalLoad } from ${JSON.stringify(route("web/src/routes/hotzones/[signal]/+page.server.ts"))};`,
        `export { __resetHomeGuestCacheForTests as resetHomeGuestCache } from ${JSON.stringify(route("src/home-cache.ts"))};`,
        ``,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    plugins: [
      {
        name: "kit-no-member-data-contract-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "kit-no-member-data-contract-env",
            namespace: "kit-no-member-data-contract",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-no-member-data-contract" }, () => ({
            contents: [
              `export const env = globalThis[${JSON.stringify(ENV_KEY)}].env;`,
              `export const waitUntil = globalThis[${JSON.stringify(ENV_KEY)}].waitUntil;`,
              ``,
            ].join("\n"),
            loader: "js",
          }));
          plugin.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "kit-no-member-data-contract-kit",
            namespace: "kit-no-member-data-contract-kit",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-no-member-data-contract-kit" }, () => ({
            contents: [
              `export const error = globalThis[${JSON.stringify(ENV_KEY)}].kitError;`,
              `export const redirect = globalThis[${JSON.stringify(ENV_KEY)}].kitRedirect;`,
              ``,
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  loads = (await import(pathToFileURL(outfile).href)) as unknown as BundleLoads;
}, 120000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[ENV_KEY];
});

afterEach(() => {
  loads.resetHomeGuestCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function guestArgs(url: string): AnyLoadArgs {
  return {
    url: new URL(url),
    request: new Request(url, { method: "GET" }),
    locals: { status: "guest" },
    cookies: { delete: () => {} },
    setHeaders: () => {},
  };
}

// ---------------------------------------------------------------------------
// Detector + fixture self-checks (prove the pins are not vacuous).
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
});

// ---------------------------------------------------------------------------
// Public page payloads.
// ---------------------------------------------------------------------------

describe("Kit GET / anonymous payload", () => {
  it("serves hostile rows with aggregates only: no createdBy, usernames or bearers", async () => {
    const eventId = 7;
    useEnv(
      baseEnv({
        ADMIN_DB: fakeDb(
          storedFixture({
            eventRows: [hostileEventRow({ id: eventId })],
            users: hostileUsers(),
            rsvps: hostileRsvps(eventId),
            featured: hostileFeatured(),
          }),
        ),
        DISCORD_EVENTS: { upcoming: async () => [hostileTransient()], lastReadFailed: () => false },
      }),
    );
    const data = await loads.homeLoad(guestArgs("https://example.test/"));

    // Non-vacuous: the hostile rows flowed through with honest aggregates.
    const upcoming = data["upcomingEvents"] as Array<Record<string, unknown>>;
    const titles = upcoming.map((row) => row["title"]);
    expect(titles).toContain("Hostile Teaser Title zz9 \u6F22\u5B57");
    expect(titles).toContain("Hostile Discord Transient qq4");
    const canonical = upcoming.find((row) => row["source"] === "canonical") as Record<
      string,
      unknown
    >;
    expect(canonical["goingCount"]).toBe(2);
    expect(canonical["goingOccupancy"]).toBe(3);
    const featured = data["featured"] as Array<Record<string, unknown>>;
    expect(featured.map((row) => row["title"])).toContain("Hostile Featured zz9");
    expect(data["session"]).toBeNull();

    assertNoMemberBytes(serializePayload(data), "GET /", ['"createdBy"']);
  });
});

describe("Kit GET /events/past anonymous payload", () => {
  it("serves hostile archive rows with no authorship snowflakes or member bytes", async () => {
    const eventId = 7;
    useEnv(
      baseEnv({
        ADMIN_DB: fakeDb(
          storedFixture({
            eventRows: [
              hostileEventRow({
                id: eventId,
                status: "past",
                startsAt: PAST_STARTS_AT,
                endsAt: PAST_ENDS_AT,
              }),
            ],
            users: hostileUsers(),
            rsvps: hostileRsvps(eventId),
            eventsCount: 1,
          }),
        ),
      }),
    );
    const data = await loads.pastLoad(guestArgs("https://example.test/events/past"));

    // Non-vacuous: the hostile archived row rendered with honest aggregates.
    const rows = data["rows"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["title"]).toBe("Hostile Teaser Title zz9 \u6F22\u5B57");
    expect(rows[0]?.["goingCount"]).toBe(2);
    expect(rows[0]?.["goingOccupancy"]).toBe(3);

    assertNoMemberBytes(serializePayload(data), "GET /events/past", ['"createdBy"']);
  });

  // Search-only exceptions to the archive projection, pinned at the serialized
  // real-load boundary (parsed `__data.json` bytes, not the projection helper or
  // the rendered DOM): `titleSpans` and `passage` ride a row only for a nonblank
  // query, and `passage` only when the row has a description. The description
  // itself, member bytes and internal columns never appear in either mode.
  describe("search-only payload fields", () => {
    const BASE_ROW_KEYS = [
      "eventKey",
      "title",
      "startsAt",
      "timezone",
      "location",
      "game",
      "goingCount",
      "goingOccupancy",
      "capacity",
      "discordEventId",
    ].sort();
    const TEASER_TITLE = "Hostile Teaser Title zz9 漢字";
    const TEASER_DESCRIPTION =
      "The teaser reel returns. Hostile description … 💀 with maximal fields";
    const EMOJI = "😀";
    // 200 + 1 + 6 + 1 + 300 supplementary-aware code points: far past the
    // 318-point passage window, with the match 201 points in.
    const LONG_DESCRIPTION = `${EMOJI.repeat(200)} needle ${EMOJI.repeat(300)}`;

    type ArchiveRow = Record<string, unknown>;

    function archiveRow(id: number, overrides: Record<string, unknown>): Record<string, unknown> {
      return hostileEventRow({
        id,
        status: "past",
        startsAt: PAST_STARTS_AT,
        endsAt: PAST_ENDS_AT,
        ...overrides,
      });
    }

    const descriptionRow = (): Record<string, unknown> =>
      archiveRow(7, { description: TEASER_DESCRIPTION });
    const noDescriptionRow = (): Record<string, unknown> =>
      archiveRow(8, {
        eventKey: "no-description-b",
        title: "Teaser Night Two",
        description: null,
        createdBy: PROBE_SNOWFLAKE_2,
      });
    const emptyDescriptionRow = (): Record<string, unknown> =>
      archiveRow(9, {
        eventKey: "empty-description-c",
        title: "Teaser Night Three",
        description: "",
        createdBy: PROBE_SNOWFLAKE_3,
      });
    const longDescriptionRow = (): Record<string, unknown> =>
      archiveRow(10, {
        eventKey: "long-description-d",
        title: "Archive Needle Night",
        description: LONG_DESCRIPTION,
      });

    async function servedArchive(
      eventRows: Record<string, unknown>[],
      search: string,
    ): Promise<{
      payload: { rows: ArchiveRow[]; q: string };
      bytes: string;
      headers: Record<string, string>;
    }> {
      useEnv(
        baseEnv({
          ADMIN_DB: fakeDb(
            storedFixture({
              eventRows,
              users: hostileUsers(),
              rsvps: hostileRsvps(7),
              eventsCount: eventRows.length,
            }),
          ),
        }),
      );
      const headers: Record<string, string> = {};
      const args = guestArgs(`https://example.test/events/past${search}`);
      args.setHeaders = (set) => Object.assign(headers, set);
      const data = await loads.pastLoad(args);
      const bytes = serializePayload(data);
      // What Kit ships to the anonymous client: the parsed serialized bytes.
      return { payload: JSON.parse(bytes) as { rows: ArchiveRow[]; q: string }, bytes, headers };
    }

    function rowByKey(rows: ArchiveRow[], eventKey: string): ArchiveRow {
      const row = rows.find((candidate) => candidate["eventKey"] === eventKey);
      expect(row, `serialized rows lack ${eventKey}`).toBeDefined();
      return row as ArchiveRow;
    }

    const sortedKeys = (row: ArchiveRow): string[] => Object.keys(row).sort();
    const joined = (segments: unknown): string =>
      (segments as { text: string }[]).map((segment) => segment.text).join("");

    const BLANK_QUERIES: [string, string][] = [
      ["a missing q", ""],
      ["an empty q", "?q="],
      ["a spaces-only q", "?q=%20%20%20"],
      ["a tab/space/NUL-only q", "?q=%09%20%00%20"],
    ];

    for (const [label, search] of BLANK_QUERIES) {
      it(`ships only the ten base keys per row for ${label}, descriptions and all`, async () => {
        const { payload, bytes, headers } = await servedArchive(
          [descriptionRow(), noDescriptionRow(), emptyDescriptionRow(), longDescriptionRow()],
          search,
        );

        // Non-vacuous: four hostile rows flowed through with honest aggregates.
        expect(payload.q).toBe("");
        expect(payload.rows).toHaveLength(4);
        const first = rowByKey(payload.rows, "hostile-event-key-zz9");
        expect(first["title"]).toBe(TEASER_TITLE);
        expect(first["goingCount"]).toBe(2);
        expect(first["goingOccupancy"]).toBe(3);
        expect(first["capacity"]).toBe(25);
        for (const row of payload.rows) {
          expect(sortedKeys(row), `row ${String(row["eventKey"])} keys`).toEqual(BASE_ROW_KEYS);
        }
        for (const key of ['"passage"', '"titleSpans"', '"description"']) {
          expect(bytes, `blank-query payload carried ${key}`).not.toContain(key);
        }
        expect(bytes).not.toContain("with maximal fields");
        expect(bytes).not.toContain(LONG_DESCRIPTION.slice(0, 40));
        assertNoMemberBytes(bytes, "GET /events/past (blank q)", ['"createdBy"']);
        // Browsing keeps its shared-cache policy (cacheable, Cookie-varied).
        expect(headers["cache-control"]).toBe("public, max-age=300");
        expect(headers["x-two-past-cacheable"]).toBe("true");
        expect(headers["vary"]).toBe("Cookie");
      });
    }

    it("adds titleSpans to every row and passage only to rows with a description for a normalized q", async () => {
      // Padding, a tab and a NUL around the query are normalized away.
      const { payload, bytes, headers } = await servedArchive(
        [descriptionRow(), noDescriptionRow(), emptyDescriptionRow()],
        "?q=%20%20teaser%09%00",
      );

      expect(payload.q).toBe("teaser");
      expect(payload.rows).toHaveLength(3);

      const withDescription = rowByKey(payload.rows, "hostile-event-key-zz9");
      expect(sortedKeys(withDescription)).toEqual(
        [...BASE_ROW_KEYS, "passage", "titleSpans"].sort(),
      );
      expect(withDescription["titleSpans"]).toEqual([
        { text: "Hostile ", match: false },
        { text: "Teaser", match: true },
        { text: " Title zz9 漢字", match: false },
      ]);
      expect(withDescription["passage"]).toEqual([
        { text: "The ", match: false },
        { text: "teaser", match: true },
        { text: " reel returns. Hostile description … 💀 with maximal fields", match: false },
      ]);
      // Full title and bounded excerpt keep their literal text; marks are the only addition.
      expect(withDescription["title"]).toBe(TEASER_TITLE);
      expect(joined(withDescription["titleSpans"])).toBe(TEASER_TITLE);
      expect(joined(withDescription["passage"])).toBe(TEASER_DESCRIPTION);
      expect(withDescription["goingCount"]).toBe(2);
      expect(withDescription["goingOccupancy"]).toBe(3);

      for (const [eventKey, title, spans] of [
        [
          "no-description-b",
          "Teaser Night Two",
          [
            { text: "Teaser", match: true },
            { text: " Night Two", match: false },
          ],
        ],
        [
          "empty-description-c",
          "Teaser Night Three",
          [
            { text: "Teaser", match: true },
            { text: " Night Three", match: false },
          ],
        ],
      ] as const) {
        const row = rowByKey(payload.rows, eventKey);
        // A missing or empty description yields no passage key at all.
        expect(sortedKeys(row), `${eventKey} keys`).toEqual(
          [...BASE_ROW_KEYS, "titleSpans"].sort(),
        );
        expect(row["title"]).toBe(title);
        expect(row["titleSpans"]).toEqual(spans);
      }

      // The description itself and every member/internal column stay off the wire.
      expect(bytes).not.toContain('"description"');
      expect(bytes).not.toContain('"createdBy"');
      assertNoMemberBytes(bytes, "GET /events/past (q=teaser)", ['"createdBy"']);
      // Searching renders stay private no-store with no Vary.
      expect(headers["cache-control"]).toBe("private, no-store");
      expect(headers["x-two-past-cacheable"]).toBe("false");
      expect(headers["vary"]).toBeUndefined();
    });

    it("bounds a long supplementary-code-point passage to 320 code points with ellipses", async () => {
      const { payload, bytes } = await servedArchive([longDescriptionRow()], "?q=needle");

      expect(payload.q).toBe("needle");
      expect(payload.rows).toHaveLength(1);
      const row = rowByKey(payload.rows, "long-description-d");
      expect(sortedKeys(row)).toEqual([...BASE_ROW_KEYS, "passage", "titleSpans"].sort());
      expect(row["titleSpans"]).toEqual([
        { text: "Archive ", match: false },
        { text: "Needle", match: true },
        { text: " Night", match: false },
      ]);

      const passage = row["passage"] as { text: string; match: boolean }[];
      // Non-vacuous: the window is a strict excerpt of a description far over the cap.
      const fullPoints = Array.from(LONG_DESCRIPTION).length;
      const excerpt = joined(passage);
      expect(fullPoints).toBeGreaterThan(500);
      expect(Array.from(excerpt).length).toBeLessThanOrEqual(320);
      expect(Array.from(excerpt).length).toBeGreaterThan(300);
      expect(excerpt, "passage split a surrogate pair").not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      // Trimmed on both sides: leading and trailing ellipsis segments, unmarked.
      expect(passage[0]).toEqual({ text: "…", match: false });
      expect(passage[passage.length - 1]).toEqual({ text: "…", match: false });
      expect(passage.filter((segment) => segment.match)).toEqual([{ text: "needle", match: true }]);
      // The full description never rides the payload.
      expect(bytes).not.toContain(LONG_DESCRIPTION);
      expect(bytes).not.toContain('"description"');
      assertNoMemberBytes(bytes, "GET /events/past (q=needle)", ['"createdBy"']);
    });
  });
});

describe("Kit GET /events anonymous payload", () => {
  it("renders hostile rows to HTML with no member bytes", async () => {
    const upcoming = [
      {
        ...hostileEventRow({ id: 7 }),
        goingCount: 2,
        goingOccupancy: 3,
      } as unknown as PublicEvent,
    ];
    const setHeaders = vi.fn();
    const data = await loadEventsPage({
      env: baseEnv() as never,
      url: new URL("https://example.test/events"),
      method: "GET",
      island: false,
      request: new Request("https://example.test/events"),
      setHeaders,
      deleteJoinCookie: () => {},
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      modelForFn: async () => ({
        state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
        upcoming,
        past: [],
        zone: "Europe/London",
        totalPages: 1,
        emptyState: null,
        robots: undefined,
        discordFailed: false,
        games: [],
        gameFilter: null,
      }),
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });
    const rendered = await renderEventsHtml(data, {});

    // Non-vacuous: the hostile row rendered into the calendar body.
    expect(rendered.body).toContain("Hostile Teaser Title zz9 \u6F22\u5B57");

    assertNoMemberBytes(rendered.body, "GET /events");
  });

  it("binding returns the rendered body verbatim (no binding-added bytes)", async () => {
    const { readFileSync } = await import("node:fs");
    const { URL: NodeURL } = await import("node:url");
    const source = readFileSync(
      new NodeURL("../web/src/routes/events/+server.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("new Response(rendered.body");
  });
});

describe("Kit static-leaf anonymous payloads", () => {
  it("GET /about serves its leaf with no member bytes", async () => {
    useEnv(baseEnv());
    const data = await loads.aboutLoad({ setHeaders: () => {} });
    expect(serializePayload(data)).toContain("next.example.test");
    assertNoMemberBytes(serializePayload(data), "GET /about");
  });

  it("GET /faq serves its leaf with no member bytes", async () => {
    useEnv(baseEnv());
    const data = await loads.faqLoad({ setHeaders: () => {} });
    expect(serializePayload(data)).toContain("next.example.test");
    assertNoMemberBytes(serializePayload(data), "GET /faq");
  });

  it("GET /rules serves its leaf with no member bytes", async () => {
    useEnv(baseEnv());
    const data = await loads.rulesLoad({ setHeaders: () => {} });
    expect(serializePayload(data)).toContain("next.example.test");
    assertNoMemberBytes(serializePayload(data), "GET /rules");
  });

  it("GET /privacy serves its leaf with no member bytes", async () => {
    useEnv(baseEnv());
    const data = await loads.privacyLoad({ setHeaders: () => {} });
    expect(serializePayload(data)).toContain("next.example.test");
    assertNoMemberBytes(serializePayload(data), "GET /privacy");
  });
});

describe("Kit GET /join anonymous payload", () => {
  it("serves aggregates only: no member usernames, emails or snapshot keys", async () => {
    useEnv(baseEnv());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(hostileWidgetJson())),
    );
    const args = (): AnyLoadArgs => ({
      url: new URL("https://example.test/join"),
      request: new Request("https://example.test/join", { method: "GET" }),
      cookies: { delete: () => {} },
      setHeaders: () => {},
    });

    // Cold isolate: the probe is scheduled, never awaited — no presence yet.
    const cold = await loads.joinLoad(args());
    expect(cold["widgetSnapshot"]).toBeNull();
    expect(shared().pending).toHaveLength(1);
    await Promise.all(shared().pending);

    // Anonymous follow-up: presence renders from the warmed verdict.
    const data = await loads.joinLoad(args());
    const snapshot = data["widgetSnapshot"] as Record<string, unknown> | null;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.["presenceCount"]).toBe(42);

    assertNoMemberBytes(serializePayload(data), "GET /join", [
      '"members"',
      '"status"',
      '"fetchedAt"',
      '"guildId"',
    ]);
  });
});

describe("Kit GET /hotzones anonymous payload", () => {
  it("serves computed aggregates with no member bytes", async () => {
    useEnv(
      baseEnv({
        ADMIN_DB: fakeDb(
          storedFixture({
            attempts: hostileAttempts(),
            profiles: hostileProfiles(),
            eventsCount: 1,
          }),
        ),
      }),
    );
    const data = await loads.hotzonesLoad(guestArgs("https://example.test/hotzones"));

    // Non-vacuous: three successful retained attempts aggregate (the failed
    // and opted-out rows drop out), plus the canned event count.
    expect(data["season"]).toBe("all");
    expect(data["joinsTotal"]).toBe(3);
    expect(data["eventCount"]).toBe(1);

    assertNoMemberBytes(serializePayload(data), "GET /hotzones");
  });
});

describe("Kit GET /hotzones/:signal anonymous payloads", () => {
  it("joins serves the live aggregate with no member bytes", async () => {
    useEnv(
      baseEnv({
        ADMIN_DB: fakeDb(
          storedFixture({
            attempts: hostileAttempts(),
            profiles: hostileProfiles(),
            eventsCount: 1,
          }),
        ),
      }),
    );
    const data = await loads.signalLoad({
      ...guestArgs("https://example.test/hotzones/joins"),
      params: { signal: "joins" },
    });

    expect(data["signal"]).toBe("joins");
    expect(data["estimated"]).toBe(false);
    expect(data["total"]).toBe(3);
    expect(data["eventCount"]).toBe(1);

    assertNoMemberBytes(serializePayload(data), "GET /hotzones/joins");
  });

  it("voice serves the seeded estimate with no member bytes", async () => {
    useEnv(baseEnv({ ADMIN_DB: fakeDb(storedFixture()) }));
    const data = await loads.signalLoad({
      ...guestArgs("https://example.test/hotzones/voice"),
      params: { signal: "voice" },
    });

    // Non-vacuous: the real seeded prior grid, never a live aggregate.
    expect(data["signal"]).toBe("voice");
    expect(data["estimated"]).toBe(true);
    expect(data["total"]).toBe(priorGrid("voice").total);

    assertNoMemberBytes(serializePayload(data), "GET /hotzones/voice");
  });

  it("games serves the seeded estimate with no member bytes", async () => {
    useEnv(baseEnv({ ADMIN_DB: fakeDb(storedFixture()) }));
    const data = await loads.signalLoad({
      ...guestArgs("https://example.test/hotzones/games"),
      params: { signal: "games" },
    });

    expect(data["signal"]).toBe("games");
    expect(data["estimated"]).toBe(true);
    expect(data["total"]).toBe(priorGrid("games").total);

    assertNoMemberBytes(serializePayload(data), "GET /hotzones/games");
  });
});

// ---------------------------------------------------------------------------
// Negative controls: the detector fires, and member-gated reads stay intact.
// ---------------------------------------------------------------------------

describe("member-gated negative controls", () => {
  it("member board keeps its audited reads: hostile ranking rows still served to members", async () => {
    const ranked = [
      { userId: PROBE_SNOWFLAKE, username: PROBE_USERNAME, count: 5 },
      { userId: PROBE_SNOWFLAKE_2, username: PROBE_EMAIL, count: 3 },
      { userId: PROBE_SNOWFLAKE_3, username: PROBE_USERNAME_2, count: 1 },
    ];
    const data = await loadMembersBoardData({
      env: { APP_URL: "https://example.test" } as never,
      session: { status: "authenticated", userId: PROBE_SNOWFLAKE_2, member: true } as never,
      seasonParam: null,
      scopeParam: null,
      activityParam: null,
      setHeaders: () => {},
      dbForFn: async () => ({}) as never,
      loadRankingFn: async () => ranked,
      queueBoardViewFn: () => {},
    });

    // The audited read is preserved: hostile member rows reach the member.
    expect(data.rows.map((row) => row.username)).toEqual([
      PROBE_USERNAME,
      PROBE_EMAIL,
      PROBE_USERNAME_2,
    ]);
    // And the detector fires on real member data (positive control).
    expect(findMemberBytes(serializePayload(data))).toContain(PROBE_USERNAME);
  });

  it("member profile keeps its audited read: hostile member record still served to members", async () => {
    const member: MemberView = {
      id: PROBE_SNOWFLAKE_3,
      username: PROBE_USERNAME,
      avatar: null,
      bio: PROBE_USERNAME_2,
      games: ["hostile-game"],
      timezone: "Europe/London",
    };
    const outcome = await resolveKitProfile(
      {
        session: {
          status: "authenticated",
          session: {
            userId: PROBE_SNOWFLAKE_3,
            username: PROBE_USERNAME,
            avatar: null,
            member: true,
            moderator: false,
          },
        },
        requestedId: PROBE_SNOWFLAKE_3,
        joinResult: null,
        url: "https://example.test/profile",
      },
      {
        store: {
          find: async () => member,
          save: async () => {},
        },
        sessionSecret: "test-session-secret-at-least-32-bytes-long",
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" ? outcome.member.username : null).toBe(PROBE_USERNAME);
    expect(findMemberBytes(serializePayload(outcome))).toContain(PROBE_USERNAME);
  });
});
