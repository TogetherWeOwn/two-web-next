// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: PATCH /events/:key
// route-inventory: POST /events/:key/publish
// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// N6 (follow-up to the R12 decision): publish, edit and RSVP-settle retire
// the anonymous `/events` + `/events/past` entries, so the next guest fetch
// shows the new title and going count. Expiry still bounds the worst case,
// home stays untouched, and shared entries carry no member state.
// Live against agent-testdb in an owned disposable schema (like
// test/rsvp.test.ts); never staging, never production.
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import {
  ANON_EVENTS_TTL_MS,
  ANON_PAST_TTL_MS,
  __resetAnonEventCacheForTests,
  anonCacheSource,
  readAnonCache,
  writeAnonCache,
} from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { newEventKey } from "../src/admin/validation";
import type { QueueMessage } from "../src/jobs/types";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Keep the routes, transaction locks and throttle budget real, in the owned
// schema. The postgres constructor is still reachable for the fixture itself.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// The W13 producer, ledger and unique lock stay out of this suite (covered by
// test/event-writeback.test.ts): stub the transport edge and keep the routes,
// store transactions and RSVP budget real.
const sent: Extract<QueueMessage, { kind: "sync-event" }>[] = [];
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (_env: Env, message: Extract<QueueMessage, { kind: "sync-event" }>) => {
    sent.push(message);
    return true;
  },
}));
const FUTURE_START = new Date("2099-06-04T18:00:00Z");
const FUTURE_END = new Date("2099-06-04T20:00:00Z");
const PAST_START = new Date("2020-03-04T18:00:00Z");
const PAST_END = new Date("2020-03-04T20:00:00Z");

const discordStub: DiscordEventsSource = {
  upcoming: async () => [],
  lastReadFailed: () => false,
};

describe("anonymous event-card cache containment", () => {
  it("refuses a non-test database before constructing a driver", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/events", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "anonymous event-card cache retire (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let realPostgres: typeof postgres;
    let store: ReturnType<typeof createMemorySessionStore>;
    let env: Env;

    beforeAll(async () => {
      realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
      vi.mocked(postgres).mockImplementation(realPostgres);
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
      // Producer clients (throttle/discovery paths outside the suite seams)
      // must stay inside the owned schema and the test-URL guard.
      vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
        const safe = testDatabaseUrl(raw);
        return realPostgres(safe.href, {
          ...opts,
          password: () => safe.password,
          connection: { ...opts.connection, search_path: fixture.schemaName },
          onnotice: () => {},
        });
      }) as typeof postgres);
    });

    beforeEach(async () => {
      await fixture.reset();
      __resetAnonEventCacheForTests();
      sent.length = 0;
      store = createMemorySessionStore();
      env = {
        APP_URL,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_BOT_TOKEN: "bot-token",
        SESSION_SECRET,
        get ADMIN_DB() {
          return fixture.db;
        },
        SESSION_STORE: store,
        DISCORD_EVENTS: discordStub,
        // Human-route throttle degrades to allow with no store: the suite
        // never measures the throttle, only the cache. The queue binding only
        // needs to exist: the mocked worker transport records the carrier.
        THROTTLE_STORE: async () => null,
        SYNC_EVENT_QUEUE: {},
      } as unknown as Env;
    });

    afterAll(async () => {
      if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
      await fixture?.dispose();
    });

    async function seed(over: Partial<typeof events.$inferInsert> = {}) {
      const [row] = await fixture.db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Game night",
          startsAt: FUTURE_START,
          endsAt: FUTURE_END,
          timezone: "UTC",
          status: "published",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...over,
        })
        .returning();
      return row!;
    }

    async function cookieFor(userId: string, moderator: boolean): Promise<string> {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId,
        username: userId,
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

    async function flashCookie(): Promise<string> {
      return (
        (await serializeSigned(JOIN_RESULT_COOKIE, "added", SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })) as string
      ).split(";")[0]!;
    }

    const guestGet = (path: string, cookie?: string) =>
      app.request(path, { headers: cookie ? { cookie } : {} }, env);

    async function modWrite(method: string, path: string, body?: unknown): Promise<Response> {
      return app.request(
        path,
        {
          method,
          headers: {
            cookie: await cookieFor("moderator", true),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    }

    async function rsvpWrite(
      method: string,
      key: string,
      userId: string,
      body?: unknown,
    ): Promise<Response> {
      return app.request(
        `/events/${key}/rsvp`,
        {
          method,
          headers: {
            cookie: await cookieFor(userId, false),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    }

    it("serves a stale title until an edit retires the /events entry", async () => {
      const row = await seed({ title: "Game night" });
      const first = await guestGet("/events");
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("public, max-age=60");
      expect(await first.text()).toContain("Game night");

      // A write that bypasses the store leaves the timed entry stale: this
      // proves the second fetch comes from the shared entry, not a re-read.
      await fixture.client`update events set title = 'Smuggled title' where id = ${row.id}`;
      const staleHtml = await (await guestGet("/events")).text();
      expect(staleHtml).toContain("Game night");
      expect(staleHtml).not.toContain("Smuggled title");

      const edited = await modWrite("PATCH", `/events/${row.eventKey}`, { title: "Renamed night" });
      expect(edited.status).toBe(200);
      const fresh = await guestGet("/events");
      expect(fresh.headers.get("cache-control")).toBe("public, max-age=60");
      const html = await fresh.text();
      expect(html).toContain("Renamed night");
      expect(html).not.toContain("Smuggled title");
    });

    it("publish retires the /events entry so the new event appears", async () => {
      const row = await seed({ title: "Debut night", status: "draft" });
      const before = await guestGet("/events");
      expect(before.status).toBe(200);
      expect(await before.text()).not.toContain("Debut night");

      const published = await modWrite("POST", `/events/${row.eventKey}/publish`);
      expect(published.status).toBe(200);
      expect(sent).toHaveLength(1);

      const after = await guestGet("/events");
      expect(await after.text()).toContain("Debut night");
    });

    it("RSVP land and leave retire the going count on /events", async () => {
      const row = await seed({ title: "Game night" });
      expect(await (await guestGet("/events")).text()).toContain("0 going");

      // A seat taken outside the service stays invisible while the entry lives.
      await fixture.client`insert into rsvps (event_id, user_id, status) values (${row.id}, 'ghost-member', 'going')`;
      expect(await (await guestGet("/events")).text()).toContain("0 going");

      const landed = await rsvpWrite("PUT", row.eventKey, "member-a", { status: "going" });
      expect([200, 201]).toContain(landed.status);
      expect(await (await guestGet("/events")).text()).toContain("2 going");

      const left = await rsvpWrite("DELETE", row.eventKey, "member-a");
      expect(left.status).toBe(204);
      expect(await (await guestGet("/events")).text()).toContain("1 going");
    });

    it("edit retires the /events/past entry", async () => {
      const row = await seed({
        title: "Old night",
        startsAt: PAST_START,
        endsAt: PAST_END,
      });
      const first = await guestGet("/events/past");
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await first.text()).toContain("Old night");

      await fixture.client`update events set title = 'Smuggled past' where id = ${row.id}`;
      expect(await (await guestGet("/events/past")).text()).toContain("Old night");

      const edited = await modWrite("PATCH", `/events/${row.eventKey}`, { title: "Renamed past" });
      expect(edited.status).toBe(200);
      const fresh = await guestGet("/events/past");
      const html = await fresh.text();
      expect(html).toContain("Renamed past");
      expect(html).not.toContain("Smuggled past");
    });

    it("keeps member, flash and search variants private without poisoning the shared entry", async () => {
      await seed({ title: "Game night" });
      const shared = await (await guestGet("/events")).text();
      expect(shared).toContain('data-testid="signin"');
      expect(shared).not.toContain('data-testid="rsvp-going"');
      expect(shared).not.toContain("Open Discord");
      expect(shared).not.toContain(SESSION_SECRET);

      // A signed-in member renders privately and stores nothing shared.
      const member = await guestGet("/events", await cookieFor("member-b", false));
      expect(member.headers.get("cache-control")).toBe("private, no-store");
      const memberHtml = await member.text();
      expect(memberHtml).not.toContain('data-testid="signin"');
      expect(await (await guestGet("/events")).text()).toBe(shared);

      // The one-shot join flash renders privately and leaves no banner behind.
      const flashed = await guestGet("/events", await flashCookie());
      expect(flashed.headers.get("cache-control")).toBe("private, no-store");
      expect(await flashed.text()).toContain('data-testid="join-result"');
      expect(await (await guestGet("/events")).text()).toBe(shared);

      // Search renders privately with noindex and never settles a shared entry.
      const searching = await guestGet("/events?q=night");
      expect(searching.headers.get("cache-control")).toBe("private, no-store");
      expect(searching.headers.get("x-robots-tag")).toContain("noindex");
      expect(await (await guestGet("/events")).text()).toBe(shared);
    });

    it("expiry still bounds the worst case and scopes entries to their source", () => {
      expect(ANON_EVENTS_TTL_MS).toBe(60_000);
      expect(ANON_PAST_TTL_MS).toBe(300_000);
      const source = anonCacheSource(env);
      const key = "GET /events retire-unit page=1";
      const res = {
        status: 200,
        cacheControl: "public, max-age=60",
        vary: "Cookie, X-Two-Island",
        body: "<html>unit</html>",
      };
      writeAnonCache(key, source, res, ANON_EVENTS_TTL_MS, 1_000);
      expect(readAnonCache(key, source, 1_000 + ANON_EVENTS_TTL_MS - 1)).toEqual(res);
      expect(readAnonCache(key, source, 1_000 + ANON_EVENTS_TTL_MS)).toBeNull();
      // A re-fill under another source never reads a foreign entry.
      writeAnonCache(key, source, res, ANON_EVENTS_TTL_MS, 2_000);
      expect(
        readAnonCache(key, { ...source, appUrl: "https://other.example.test" }, 2_001),
      ).toBeNull();
      expect(readAnonCache(key, source, 2_001)).toEqual(res);
    });
  },
);
