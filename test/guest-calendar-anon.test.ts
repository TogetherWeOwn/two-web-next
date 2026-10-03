// TOG-12676: guest calendar anonymity contract (legacy
// AnonymousEventCardCacheTest.php, TOG-9277). Mounted app through the real
// /events route on a pg-proxy fake: no database, no browser, no live Discord
// reads. Guests get the card sign-in link carrying the page as ?next= and
// never a live RSVP write control; members see no sign-in link. Amended per
// TOG-12685 (guest-only): no member RSVP assertion — the member calendar RSVP
// control was never built (src/events/pages.tsx renders `member ? null`).
// No token/secret echo.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

let eventSeq = 0;
function eventRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2030, 0, 10 + n, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `ev-${n}`,
    title: `Game night ${n}`,
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

function fakeCalendar(up: (typeof events.$inferSelect)[], store?: unknown) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: typeof events.$inferSelect) =>
    columns.map((k) => {
      const v = row[k];
      return v instanceof Date ? v.toISOString() : v;
    });
  const db = drizzle(async (sql: string) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    if (/"ends_at" </.test(sql)) return { rows: [] };
    const rows = sql.includes("'draft'") ? up.filter((r) => r.status !== "draft") : up;
    return { rows: rows.map(encode) };
  });
  const source: DiscordEventsSource = {
    upcoming: async () => [],
    lastReadFailed: () => false,
  };
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: source,
    ...(store ? { SESSION_STORE: store } : {}),
  } as unknown as Env;
  return {
    env,
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

async function memberSetup() {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "member",
    username: "member",
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

describe("guest calendar anonymity (TOG-9277)", () => {
  it("shows guests the card sign-in link carrying the page as next and no RSVP write control", async () => {
    const src = fakeCalendar([eventRow()]);
    const res = await src.request("/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await res.text();
    // The card CTA starts the join journey with the page as the way back.
    expect(html).toContain('href="/join/discord?next=%2Fevents" data-testid="signin"');
    expect(html).toContain("Sign in with Discord");
    expect(html).toContain("Game night");
    expect(html).not.toContain('data-testid="rsvp-going"');
    expect(html).not.toContain(SESSION_SECRET);
  });

  it("shows members no sign-in link", async () => {
    const { store, cookie } = await memberSetup();
    const src = fakeCalendar([eventRow()], store);
    const res = await src.request("/events", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Game night");
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain(SESSION_SECRET);
  });
});
