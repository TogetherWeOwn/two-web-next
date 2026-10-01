// Actual admin/event handlers and Drizzle observation in workerd. Execution
// rows and audit storage are memory-only; this fixture proves no SQL persistence.
import { Column, getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { getSignedCookie } from "hono/cookie";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../../src/admin/routes";
import { adminSchema, schema, type Db } from "../../src/db/index";
import type { SelectedField } from "../../src/db/read-classification";
import type { Env } from "../../src/env";
import { registerEventRoutes, type SessionReader } from "../../src/events/routes";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

const subject = "100000000000000101";
const viewer = "100000000000000102";
const eventKey = "01J00000000000000000000015";
const secret = "keyed-admin-event-fixture-secret-32-bytes";
const app = new Hono();

app.get("/fixture/:surface/:mode", async (c) => {
  const surface = c.req.param("surface");
  const mode = c.req.param("mode");
  const sessions = createMemorySessionStore();
  const db = drizzle.mock({ schema: { ...schema, ...adminSchema } });
  const entries: unknown[][] = [];
  const owner = mode === "self" ? viewer : subject;
  const event = {
    id: 1, legacy_id: null, event_key: eventKey, title: "Workerd public event", game: null,
    description: null, starts_at: new Date("2099-01-01"), ends_at: new Date("2099-01-02"),
    timezone: "UTC", location: null, capacity: null, status: "published", rsvp_open: true,
    series_id: null, parent_id: null, recurrence_rule: null, discord_event_id: null,
    discord_thread_id: null, created_by: null, created_at: new Date(), updated_at: new Date(),
  };
  const rowsByTable: Record<string, Record<string, unknown>> = {
    events: event,
    users: { id: owner, username: "workerd-attendee-sensitive", avatar: null },
    rsvps: { id: 1, event_id: 1, user_id: owner, status: "going", created_at: new Date(), updated_at: new Date() },
    join_attempts: { id: 1, discord_id: owner, request_id: "workerd-join-sensitive", outcome: "added", source: "site", created_at: new Date() },
  };
  // Keep the real dialect, selection metadata and query builders. Only the
  // execution adapter is deterministic memory; observeMemberReads wraps it.
  const session = (db as unknown as { session: {
    prepareQuery: (query: { sql: string; params: unknown[] }, fields?: SelectedField[]) => unknown;
    transaction: (callback: (tx: Db) => Promise<unknown>) => Promise<unknown>;
  } }).session;
  session.transaction = (callback) => callback(db as unknown as Db);
  session.prepareQuery = (query, fields) => ({ setToken() { return this; }, execute: async () => {
    const statement = query.sql;
    if (statement.startsWith('insert into "member_data_access_logs"')) {
      if (mode === "audit-failure") throw new Error("memory audit fixture refusal");
      entries.push(query.params);
      return [];
    }
    if (!fields?.length) return []; // fixed timeouts / empty self waitlist
    if (statement.includes('from "event_search_logs"') || statement.includes('from "featured_contents"')) return [];
    if (statement.includes('from "events"') && !statement.includes('"event_key" =')) return [];
    if (statement.includes('from "rsvps"') && !statement.includes('join "users"')) {
      return mode === "empty" ? [] : [{ eventId: 1, n: 1 }];
    }
    if (mode === "empty" && (statement.includes('from "join_attempts"') || statement.includes('join "users"'))) return [];
    const row: Record<string, unknown> = {};
    for (const { path, field } of fields) {
      let value: unknown = 1;
      if (is(field, Column)) {
        value = rowsByTable[getTableName(field.table)]?.[field.name] ?? null;
        if ((mode === "invalid" || mode === "partial") &&
          ((getTableName(field.table) === "users" && field.name === "id") ||
           (getTableName(field.table) === "rsvps" && field.name === "user_id") ||
           (getTableName(field.table) === "join_attempts" && field.name === "discord_id"))) value = "invalid-key";
      }
      let target = row;
      for (const part of path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
      target[path.at(-1)!] = value;
    }
    if (mode === "partial" && (statement.includes('from "join_attempts"') || statement.includes('join "users"'))) {
      return [{ ...row, id: owner, userId: owner, memberId: owner, discordId: owner }, row];
    }
    return [row];
  } });

  let cookie = "";
  if (mode !== "guest") {
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId: viewer, username: "fixture-viewer", avatar: null,
      member: mode !== "non-member", moderator: !["member", "non-member"].includes(mode), expiresAt: new Date(Date.now() + 60_000) });
    cookie = (await serializeSigned("__Host-two_session", token, secret, { secure: true, httpOnly: true, path: "/", sameSite: "Lax" })).split(";")[0]!;
  }
  const bindings = { APP_URL: "https://runtime.test", SESSION_SECRET: secret, ADMIN_DB: db, SESSION_STORE: sessions,
    DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture", DISCORD_GUILD_ID: "fixture", DISCORD_BOT_TOKEN: "fixture",
    DISCORD_INVITE_URL: "https://discord.gg/fixture", MEMBER_ACCESS_LOG_ENFORCE: "false" };
  const router = new Hono<{ Bindings: Env }>();
  router.route("/admin", adminApp());
  const reader: SessionReader = async (ctx) => {
    const token = await getSignedCookie(ctx, secret, "__Host-two_session");
    const row = token ? await sessions.get(await hashToken(token)) : null;
    return row ? { id: row.userId, username: row.username, avatar: row.avatar, member: row.member, moderator: row.moderator } : null;
  };
  registerEventRoutes(router, reader, reader);
  const path = surface === "event" ? `/e/${eventKey}` : surface === "roster" ? `/admin/events/${eventKey}` : surface === "joins" ? "/admin/join-attempts" : "/admin/events/new";
  const response = await router.request(path, { headers: { cookie } }, bindings);
  const copy = new Response(response.body, response);
  copy.headers.set("x-fixture-audit", JSON.stringify(entries));
  return copy;
});
export default app;
