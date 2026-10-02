// TOG-12215: the past-events archive exposes the same Subscribe (webcal),
// RSS and ICS affordances as the calendar page. The /events/past route never
// reads the session, so guest and member HTML must be identical.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  EVENTS_SUBSCRIBE_TESTID,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  pastEventsOutOfRangeCopy,
} from "../src/islands/contracts";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

function eventRow(n: number): typeof events.$inferSelect {
  const date = new Date(Date.UTC(2020, 0, n + 1));
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `archive-${n}`,
    title: `Past game ${n}`,
    game: "Chess",
    description: null,
    startsAt: date,
    endsAt: date,
    timezone: "UTC",
    location: null,
    capacity: 10,
    status: "past",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: date,
    updatedAt: date,
  };
}

// Same pg-proxy archive as islands-past-events.test.ts: real Drizzle selects and
// Hono route, never a database connection.
function archive(total: number, appUrl = APP_URL) {
  const rows = Array.from({ length: total }, (_, i) => eventRow(total - i));
  const db = drizzle(async (sql, params) => {
    if (sql.startsWith('select count(*) from "events"')) return { rows: [[total]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    return {
      rows: rows.slice(offset, offset + limit).map((row) =>
        columns.map((k) => {
          const value = row[k];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  });
  const env = {
    APP_URL: appUrl,
    ADMIN_DB: db as unknown as Db,
    SESSION_SECRET,
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env & { SESSION_STORE: SessionStore };
  return { env, request: (path: string, init?: RequestInit) => app.request(path, init ?? {}, env) };
}

async function memberCookie(env: Env & { SESSION_STORE: SessionStore }) {
  const token = newSessionToken();
  await env.SESSION_STORE!.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000001",
    username: "viewer",
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
}

const origin = (appUrl: string) => appUrl.replace(/\/$/, "");

describe("past-events feed affordances", () => {
  for (const appUrl of [APP_URL, `${APP_URL}/`]) {
    it(`renders exact Subscribe/RSS/ICS hrefs on a seeded page at ${appUrl}`, async () => {
      const html = await (await archive(25, appUrl).request("/events/past?page=1")).text();
      const base = origin(appUrl);
      const subscribe = html.match(/<a\b[^>]*data-testid="events-subscribe"[^>]*>[^<]*<\/a>/g);
      expect(subscribe).toEqual([
        `<a href="webcal://${base.replace(/^https?:\/\//, "")}/events.ics" data-testid="${EVENTS_SUBSCRIBE_TESTID}">Subscribe</a>`,
      ]);
      expect(html).toContain(`<a href="${base}/events.rss">RSS feed</a>`);
      expect(html).toContain(`<a href="${base}/events.ics">Download calendar (.ics)</a>`);
      // Outside the binder's swapped zones: never swallowed by page turns, and
      // never intercepted (the binder only handles a[data-archive-page]).
      expect(html.indexOf(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`)).toBeLessThan(
        html.indexOf("data-archive-state"),
      );
      expect(subscribe![0]).not.toContain("data-archive-page");
    });
  }

  it("keeps pager, canonical and noindex on the seeded page", async () => {
    const response = await archive(25).request("/events/past?page=1");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('href="/events/past?page=2"');
    expect(html).toContain('data-page="1"');
    expect(html).toContain('data-total-pages="2"');
    expect(html).toContain('name="robots" content="noindex, follow"');
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past"`);
    expect(html).toContain('href="/events">Back to upcoming events');
  });

  it("keeps the empty state with join pitch and feed links", async () => {
    const html = await (await archive(0).request("/events/past")).text();
    expect(html).toContain(`data-testid="${PAST_EVENTS_EMPTY_TESTID}"`);
    expect(html).toContain(PAST_EVENTS_COPY.empty);
    expect(html).toContain(`<a href="/join">${PAST_EVENTS_COPY.join}</a>`);
    expect(html).toContain(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`);
    expect(html).toContain(`<a href="${APP_URL}/events.rss">RSS feed</a>`);
    expect(html).not.toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
  });

  it("keeps the out-of-range state with feed links", async () => {
    const html = await (await archive(25).request("/events/past?page=9")).text();
    expect(html).toContain(pastEventsOutOfRangeCopy(9, 2));
    expect(html).toContain(`role="status" data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(html).toContain('name="robots" content="noindex, follow"');
    expect(html).toContain(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`);
    expect(html).toContain(`<a href="${APP_URL}/events.rss">RSS feed</a>`);
    expect(html).toContain(`<a href="${APP_URL}/events.ics">Download calendar (.ics)</a>`);
  });

  it("renders identical feed links for guest and member", async () => {
    const source = archive(25);
    const guest = await (await source.request("/events/past")).text();
    const cookie = await memberCookie(source.env);
    const member = await (await source.request("/events/past", { headers: { cookie } })).text();
    expect(member).toBe(guest);
    expect(guest).toContain(`data-testid="${EVENTS_SUBSCRIBE_TESTID}"`);
    expect(guest).toContain(`<a href="${APP_URL}/events.rss">RSS feed</a>`);
  });
});
