// route-inventory: GET /e/:key
// route-inventory: GET /events.json
// route-inventory: GET /events/:file{.+\.ics}
// Gone-surface contract (TOG-11710): cancelled 410 copy + JSON-LD, unknown-vs-gone,
// draft noindex across HTML/JSON/ICS, published no-signal and past noindex on the apex.
// Ports tests/Feature/Events/EventGoneTest.php against the Next divergence set:
// no per-event JSON show (the session-gated /events.json collection is the JSON
// surface), past pages carry explicit noindex (docs/parity.md), and the gone page
// uses data-testid="event-cancelled" on current markup (theme restyle owned elsewhere).
// (agent-testdb; skipped without DATABASE_URL like test/events.test.ts).
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import { createDb } from "../src/db/index";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

// Digits are valid Crockford base32, so padded counters are valid route keys.
const key = (n: number) => String(n).padStart(26, "0");
const CANCELLED = key(1);
const DRAFT = key(2);
const PUBLISHED = key(3);
const PAST = key(4);
const UNKNOWN = key(9);

const FUTURE_START = new Date("2099-11-04T20:00:00Z");
const FUTURE_END = new Date("2099-11-04T22:00:00Z");
const PAST_START = new Date("2020-01-04T20:00:00Z");
const PAST_END = new Date("2020-01-04T22:00:00Z");

async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: moderator ? "300000000000000001" : "300000000000000002",
    username: moderator ? "gone-mod" : "gone-member",
    avatar: null,
    member: true,
    moderator,
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

function jsonLdOf(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(match?.[1], "gone page carries a JSON-LD block").toBeDefined();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe.skipIf(!process.env.DATABASE_URL)("event gone surfaces (agent-testdb)", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const store = createMemorySessionStore();
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    SESSION_STORE: store,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
  // Apex config silences the global staging middleware, so every robots
  // assertion below proves a route-level signal, not middleware interference.
  const apexEnv = { ...env, APP_URL: "https://togetherweown.com" } as unknown as Env;

  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const apex = (path: string, init: RequestInit = {}) => app.request(path, init, apexEnv);
  // View sessions rotate on every authenticated page read, so each request
  // mints a fresh cookie.
  const auth = async (moderator: boolean, extra: RequestInit = {}) => ({
    ...extra,
    headers: { ...(extra.headers ?? {}), cookie: await cookieFor(store, moderator) },
  });

  beforeEach(async () => {
    await db.delete(rsvps);
    await db.delete(activityLog);
    await db.delete(events);
    await db.insert(events).values([
      {
        eventKey: CANCELLED,
        title: "Friday night games",
        status: "cancelled",
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
      },
      {
        eventKey: DRAFT,
        title: "Draft night",
        status: "draft",
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
      },
      {
        eventKey: PUBLISHED,
        title: "Published night",
        status: "published",
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
      },
      {
        eventKey: PAST,
        title: "Past night",
        status: "past",
        startsAt: PAST_START,
        endsAt: PAST_END,
      },
    ]);
  });

  it("answers a cancelled page with 410, copy, JSON-LD and noindex for every viewer", async () => {
    const viewers: [string, RequestInit | Promise<RequestInit>][] = [
      ["guest", {}],
      ["member", auth(false)],
      ["moderator", auth(true)],
      ["forged cookie", { headers: { cookie: "__Host-two_session=forged" } }],
    ];
    for (const [who, init] of viewers) {
      const res = await apex(`/e/${CANCELLED}`, await init);
      expect(res.status, who).toBe(410);
      expect(res.headers.get("x-robots-tag"), who).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control"), who).toBe("private, no-store");
    }
    const html = await (await apex(`/e/${CANCELLED}`)).text();
    expect(html).toContain("<h1>Friday night games</h1>");
    expect(html).toContain("This event was cancelled");
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain('href="/events">See upcoming events</a>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(jsonLdOf(html)).toMatchObject({
      "@type": "Event",
      name: "Friday night games",
      eventStatus: "https://schema.org/EventCancelled",
    });
  });

  it("keeps the cancelled page free of canonical, share, nav and attendee leaks", async () => {
    const html = await (await apex(`/e/${CANCELLED}`, await auth(true))).text();
    expect(html).not.toMatch(
      /rel="canonical"|og:|twitter:|event-join-pitch|event-copy-link|event-pagination|event-attendees|event-ics|event-google-calendar/,
    );
  });

  it("keeps an unknown event key a 404, not a 410", async () => {
    expect((await req("/e/not-a-ulid")).status).toBe(404);
    const unknown = await req(`/e/${UNKNOWN}`);
    expect(unknown.status).toBe(404);
    const body = await unknown.text();
    expect(body).not.toContain("was cancelled");
    expect(body).not.toContain('data-testid="event-cancelled"');
    // Contrast in the same test: the cancelled key on the same app is gone, not missing.
    expect((await req(`/e/${CANCELLED}`)).status).toBe(410);
    // The per-event download agrees: unknown/malformed 404, cancelled downloads fine.
    expect((await req(`/events/${UNKNOWN}.ics`)).status).toBe(404);
    expect((await req("/events/nope.ics")).status).toBe(404);
    expect((await req(`/events/${CANCELLED}.ics`)).status).toBe(200);
  });

  it("shows a draft page only to a moderator, with noindex on the moderator view", async () => {
    expect((await apex(`/e/${DRAFT}`)).status).toBe(403);
    expect((await apex(`/e/${DRAFT}`, await auth(false))).status).toBe(403);
    const res = await apex(`/e/${DRAFT}`, await auth(true));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await res.text();
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("hides drafts from member JSON and ICS while moderators still read them", async () => {
    expect((await req("/events.json")).status).toBe(401);
    const hidden = await req(`/events.json?event_key=${DRAFT}`, await auth(false));
    expect(hidden.status).toBe(200);
    expect(((await hidden.json()) as { data: unknown[] }).data).toEqual([]);
    const shown = await req(`/events.json?event_key=${DRAFT}`, await auth(true));
    expect(((await shown.json()) as { data: { event_key: string }[] }).data[0]?.event_key).toBe(
      DRAFT,
    );
    expect((await req(`/events/${DRAFT}.ics`)).status).toBe(403);
    expect((await req(`/events/${DRAFT}.ics`, await auth(false))).status).toBe(403);
    expect((await req(`/events/${DRAFT}.ics`, await auth(true))).status).toBe(200);
  });

  it("keeps a cancelled row listed in member JSON with its status and no JSON robots tag", async () => {
    const res = await req(`/events.json?event_key=${CANCELLED}`, await auth(false));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const rows = ((await res.json()) as { data: { event_key: string; status: string }[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_key: CANCELLED, status: "cancelled" });
  });

  it("leaves a published page without any robots signal on the apex", async () => {
    const res = await apex(`/e/${PUBLISHED}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain('name="robots"');
    expect(html).toContain('rel="canonical"');
  });

  it("carries explicit past noindex on the header and the meta (Next divergence from legacy)", async () => {
    // Legacy EventGoneTest expects no signal for past; Next deliberately
    // noindexes past pages instead (docs/parity.md, src/events/routes.tsx).
    const res = await apex(`/e/${PAST}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await res.text();
    expect(html).toContain('data-testid="event-past">Past event');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });
});
