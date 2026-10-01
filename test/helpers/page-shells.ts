// Local rows only: the mounted worker uses pg-proxy and memory sessions, never a DB or Discord.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import app from "../../src/index";
import { events, featuredContents } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import { joinAttempts } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const MEMBER_ID = "100000000000000001";
export const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export const HTML_READS = [
  "/", "/about", "/faq", "/rules", "/privacy", "/join", "/join/callback",
  "/events", "/events/past", "/e/:key", "/profile", "/members/:user",
  "/admin", "/admin/events", "/admin/events/new", "/admin/events/:key",
  "/admin/featured", "/admin/featured/new", "/admin/featured/:id", "/admin/join-attempts", "/admin/join-attempts/:id",
];

// Redirects, feeds and machine endpoints have no HTML success page. Their branded
// error responses are covered separately; new GET routes must be classified here.
export const NON_HTML_READS = [
  "/discord", "/join/discord", "/auth/discord", "/auth/discord/callback",
  "/sitemap_index.xml", "/robots.txt", "/up",
  "/events.json", "/events.ics", "/events.rss", "/events/:file{.+\\.ics}",
];

export const concretePath = (pattern: string) => pattern
  .replace(":key", EVENT_KEY).replace(":user", MEMBER_ID).replace(":id", "1");

export function pageShellFixture(status = "published") {
  const now = new Date("2030-01-01T20:00:00Z");
  const event: typeof events.$inferSelect = {
    id: 1, eventKey: EVENT_KEY, title: "Fixture game night", game: "Chess", description: "Play together.",
    startsAt: now, endsAt: new Date("2030-01-01T22:00:00Z"), timezone: "UTC", location: "Lobby",
    capacity: null, status, discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: MEMBER_ID, rsvpOpen: true,
    recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
    parentEventId: null, recurrenceIndex: null, createdAt: now, updatedAt: now,
  };
  const featured: typeof featuredContents.$inferSelect = {
    id: 1, title: "Fixture featured slot", body: null, url: null, imageUrl: null, imageAlt: null,
    isPublished: false, position: 0, startsAt: null, endsAt: null, createdBy: MEMBER_ID,
    createdAt: now, updatedAt: now,
  };
  const attempt: typeof joinAttempts.$inferSelect = {
    id: 1, outcome: "added", source: "join", requestId: "page-shell-join-request", discordId: MEMBER_ID,
    createdAt: now,
  };
  const encode = <T extends Record<string, unknown>>(columns: Record<string, unknown>, row: T) =>
    Object.keys(columns).map((key) => row[key] instanceof Date ? row[key].toISOString() : row[key]);
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "users"')) {
      return { rows: params.includes(MEMBER_ID)
        ? [[MEMBER_ID, "Fixture member", null, "A local bio.", ["Chess"], "UTC", now.toISOString()]] : [] };
    }
    if (sql.includes('from "events"')) {
      if (sql.includes('"events"."id" <>')) return { rows: [] }; // No neighboring/related fixture rows.
      if (sql.includes("count(*)")) return { rows: [[1]] };
      if (sql.includes('"event_key" =') && !params.includes(EVENT_KEY)) return { rows: [] };
      return { rows: [encode(getTableColumns(events), event)] };
    }
    if (sql.includes('from "featured_contents"')) {
      if (sql.includes('"id" =') && !params.includes(1)) return { rows: [] };
      return { rows: [encode(getTableColumns(featuredContents), featured)] };
    }
    if (sql.includes('from "join_attempts"')) {
      if (sql.includes("count(*)")) return { rows: [[attempt.outcome, 1]] };
      if (sql.includes('"join_attempts"."id" =') && params[0] !== attempt.id) return { rows: [] };
      const row = encode(getTableColumns(joinAttempts), attempt);
      return { rows: [sql.includes('left join "users"') ? [...row, MEMBER_ID] : row] };
    }
    if (sql.includes("row_number() over (partition by event_id order by created_at, coalesce(legacy_id, id), id)")
      && sql.includes("from rsvps")) return { rows: [] };
    if (sql.includes('from "rsvps"') || sql.includes('from "event_search_log"')
      || sql.startsWith('insert into "member_data_access_logs"') || sql.startsWith("SET LOCAL")) return { rows: [] };
    throw new Error(`Unexpected page-shell fixture query: ${sql}`);
  });
  // pg-proxy does not provide transactions; this test double keeps analytics reads local.
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db) });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: "https://next.example.test", DISCORD_CLIENT_ID: "fixture-client", DISCORD_GUILD_ID: "fixture-guild",
    DISCORD_INVITE_URL: "https://discord.gg/fixture", DISCORD_CLIENT_SECRET: "fixture-secret",
    DISCORD_BOT_TOKEN: "", SESSION_SECRET: "fixture-session-secret-at-least-32-bytes-long",
    SESSION_STORE: sessions, ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as Env;
  const cookie = async () => {
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId: MEMBER_ID, username: "Fixture member",
      avatar: null, member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000) });
    return (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/", secure: true, httpOnly: true, sameSite: "Lax",
    })).split(";")[0]!;
  };
  return { env, request: async (path: string) => app.request(path, {
    headers: { cookie: await cookie(), accept: "text/html" },
  }, env) };
}
