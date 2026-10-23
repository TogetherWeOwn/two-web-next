// route-inventory: GET /
// route-inventory: GET /events
// route-inventory: GET /e/:key
// route-inventory: GET /members/:user
// route-inventory: GET /profile
//
// Cutover parity net: every public route emits its declared head contract —
// <title>, meta description, OG/Twitter tags and canonical URL — from local
// fixtures only (pg-proxy + memory sessions, no network, no staging/prod DB).
// The 404 is the deliberate exception: error shells carry no share tags, so
// the test pins their absence (an error URL must never present as a
// shareable duplicate) alongside the noindex.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
// Allowlisted synthetic fixture ULID only (see .gitleaks.toml).
const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ALICE = "100000000000000001";
const BOB = "100000000000000002";

const HOME_TITLE = "Together We Own — the lobby is open";
const HOME_DESCRIPTION = "We spent most of our life private. Now you can just turn up.";
const EVENTS_TITLE = "Events — Together We Own";
const EVENTS_DESCRIPTION = "Game nights, tournaments and whatever else the community puts on.";
const EVENT_TITLE = "Chess night";
const EVENT_DESCRIPTION = "Bring a friend and a board.";
const PROFILE_DESCRIPTION = "A member of Together We Own.";
const NOT_FOUND_TITLE = "We cannot find that page — Together We Own";

type EventRow = typeof events.$inferSelect;

function eventRow(): EventRow {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: EVENT_KEY,
    title: EVENT_TITLE,
    game: "Chess",
    description: EVENT_DESCRIPTION,
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
  };
}

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
// One published upcoming event: neighbors/related stay empty, the going-count
// aggregate answers from the same row.
function publicHarness() {
  const row = eventRow();
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = () =>
    columns.map((k) => (row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k]));
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) {
      if (sql.includes("count(*)")) return { rows: [[row.id, 3]] };
      return { rows: [] };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.startsWith('insert into "member_data_access_logs"')) return { rows: [] };
    if (sql.includes('from "events"')) {
      // Neighbor/related selects narrow by id; the fixture has no siblings.
      if (sql.includes("<>")) return { rows: [] };
      if (sql.includes('"event_key" =')) {
        const list = params as unknown[];
        return { rows: list.includes(EVENT_KEY) ? [encode()] : [] };
      }
      let out = [row];
      if (sql.includes('"status" =')) {
        const wanted = (params as unknown[]).find((p) => typeof p === "string");
        out = out.filter((r) => !wanted || r.status === wanted);
      }
      if (/"ends_at" </.test(sql)) out = out.filter((r) => r.endsAt < new Date());
      else if (/"ends_at" >=/.test(sql)) out = out.filter((r) => r.endsAt >= new Date());
      return { rows: out.map(() => encode()) };
    }
    throw new Error(`Unexpected public-route-meta fixture query: ${sql}`);
  });
  // pg-proxy has no transactions; the home/featured reads run them, so keep
  // those reads local the same way the sitemap-meta harness does.
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const env = {
    APP_URL,
    SESSION_SECRET: SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/configured",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
  return { env, request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

function profileHarness() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    {
      id: ALICE,
      username: "alice",
      avatar: null,
      bio: "Co-op after work.",
      games: [],
      timezone: null,
    },
    {
      id: BOB,
      username: "bob",
      avatar: null,
      bio: "Racing on Fridays.",
      games: [],
      timezone: null,
    },
  ]);
  const env = {
    APP_URL,
    SESSION_SECRET: SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/configured",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
  } as unknown as Env;
  return {
    sessions,
    env,
    app: profilesApp({ sessionStore: sessions, store, accessLog: async () => true }),
  };
}

async function memberCookie(
  sessions: ReturnType<typeof createMemorySessionStore>,
  userId: string,
  username: string,
): Promise<string> {
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId,
    username,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

// The full indexable head contract: one title, one description, one
// self-pointing canonical mirrored by og:url, the OG/Twitter set, and no
// robots tag (indexable pages) or exactly the declared one (noindexed pages).
function expectHead(
  html: string,
  expected: { canonical: string; title: string; description: string; robots?: string },
) {
  const { canonical, title, description, robots } = expected;
  expect(html.match(/<title>/g) ?? []).toHaveLength(1);
  expect(html).toContain(`<title>${title}</title>`);
  expect(html.match(/<meta name="description"/g) ?? []).toHaveLength(1);
  expect(html).toContain(`<meta name="description" content="${description}"/>`);
  expect(html.match(/rel="canonical"/g) ?? []).toHaveLength(1);
  expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
  for (const needle of [
    '<meta property="og:type" content="website"',
    '<meta property="og:site_name" content="Together We Own"',
    `<meta property="og:url" content="${canonical}"`,
    `<meta property="og:title" content="${title}"`,
    `<meta property="og:description" content="${description}"`,
    '<meta name="twitter:card" content="summary"',
    `<meta name="twitter:title" content="${title}"`,
    `<meta name="twitter:description" content="${description}"`,
  ]) {
    expect(html, needle).toContain(needle);
  }
  if (robots === undefined) expect(html).not.toContain('<meta name="robots"');
  else
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      `<meta name="robots" content="${robots}"/>`,
    ]);
  expect(html).not.toContain("og:image");
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("public-route-meta tests must remain local");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("public-route head parity (fixture-only)", () => {
  it("tags the homepage: title, description, OG/Twitter set and self-canonical", async () => {
    const res = await publicHarness().request("/");
    expect(res.status).toBe(200);
    expectHead(await res.text(), {
      canonical: `${APP_URL}/`,
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
    });
  });

  it("tags the event list: title, description, OG/Twitter set and self-canonical", async () => {
    const res = await publicHarness().request("/events");
    expect(res.status).toBe(200);
    expectHead(await res.text(), {
      canonical: `${APP_URL}/events`,
      title: EVENTS_TITLE,
      description: EVENTS_DESCRIPTION,
    });
  });

  it("tags the event detail: event title and description with the /e/{key} canonical", async () => {
    const res = await publicHarness().request(`/e/${EVENT_KEY}`);
    expect(res.status).toBe(200);
    expectHead(await res.text(), {
      canonical: `${APP_URL}/e/${EVENT_KEY}`,
      title: `${EVENT_TITLE} — Together We Own`,
      description: EVENT_DESCRIPTION,
    });
  });

  it("tags the member profile with the generic description and noindex, never the bio", async () => {
    const { app: profiles, sessions, env } = profileHarness();
    const cookie = await memberCookie(sessions, BOB, "bob");
    const res = await profiles.request(`/members/${ALICE}`, { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expectHead(html, {
      canonical: `${APP_URL}/members/${ALICE}`,
      title: "alice — Member profile",
      description: PROFILE_DESCRIPTION,
      robots: "noindex, nofollow",
    });
    expect(html).toContain("Co-op after work.");
    expect(html).not.toContain('<meta property="og:description" content="Co-op after work.');
  });

  it("the self profile points its canonical at the shareable member URL", async () => {
    const { app: profiles, sessions, env } = profileHarness();
    const cookie = await memberCookie(sessions, BOB, "bob");
    const res = await profiles.request("/profile", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expectHead(await res.text(), {
      canonical: `${APP_URL}/members/${BOB}`,
      title: "bob — Member profile",
      description: PROFILE_DESCRIPTION,
      robots: "noindex, nofollow",
    });
  });

  it("the branded 404 carries its title and noindex but no share tags", async () => {
    const res = await publicHarness().request("/nx-9x7q2-zzz");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("We cannot find that page");
    expect(html).toContain(`<title>${NOT_FOUND_TITLE}</title>`);
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="noindex, nofollow"/>',
    ]);
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("og:");
    expect(html).not.toContain("twitter:");
  });
});
