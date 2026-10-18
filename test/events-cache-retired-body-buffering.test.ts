// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: PATCH /events/:key
// Acceptance: retirement that lands while a cache candidate's body is still
// being buffered ( clone().text() in flight ) must stop that candidate from
// settling into the shared anonymous cache at all four settlement sites:
// Kit calendar, Kit past archive, Hono calendar and Hono past archive. The
// original caller may still receive its original response; the NEXT guest
// request must resolve fresh content. Existing suites retire during
// resolution/database reads; these cases retire during body consumption.
// Controlled streams/latches only, no sleeps.
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import { newEventKey } from "../src/admin/validation";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import type { QueueMessage } from "../src/jobs/types";
import { dispatchEventsRequest } from "../src/kit-events";
import { dispatchPastArchiveRequest } from "../src/kit-past-events";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Hono harness (mirrors test/anonymous-event-card-cache-retire.test.ts): keep
// the routes real in an owned disposable schema; the postgres constructor is
// still reachable for the fixture itself.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (_env: Env, _message: Extract<QueueMessage, { kind: "sync-event" }>) =>
    true,
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A body stream that delivers its first half, signals that consumption has
 * paused, and only delivers the rest once `gate` resolves. Settlement reads
 * this stream through clone().text(), so the pause is exactly the buffering
 * window between any pre-await generation comparison and the cache write.
 */
function gatedBody(
  text: string,
  onPause: () => void,
  gate: Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const mid = Math.max(1, Math.floor(text.length / 2));
  let phase = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 0) {
        phase = 1;
        controller.enqueue(encoder.encode(text.slice(0, mid)));
        return;
      }
      if (phase === 1) {
        phase = 2;
        onPause();
        await gate;
        controller.enqueue(encoder.encode(text.slice(mid)));
        return;
      }
      controller.close();
    },
  });
}

/**
 * Hono routes build their response internally, so buffering cannot be gated
 * at the source. Gate it at the settlement clone instead: the first clone
 * whose buffered bytes contain `marker` pauses until released. Middleware
 * clones of other responses pass through, and the gate is one-shot so the
 * concurrent moderator write can never deadlock on it.
 */
function gateNextMarkedClone(marker: string): {
  pausedAtBuffering: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const original = Response.prototype.clone;
  const gate = deferred();
  const paused = deferred();
  let used = false;
  Response.prototype.clone = function (this: Response): Response {
    const real = original.call(this);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const text = await real.text();
        if (!used && text.includes(marker)) {
          used = true;
          paused.resolve();
          await gate.promise;
        }
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(body, {
      status: real.status,
      statusText: real.statusText,
      headers: real.headers,
    });
  };
  return {
    pausedAtBuffering: paused.promise,
    release: gate.resolve,
    restore: () => {
      Response.prototype.clone = original;
    },
  };
}

afterEach(() => {
  __resetAnonEventCacheForTests();
  vi.restoreAllMocks();
});

describe("Kit calendar settlement during body buffering", () => {
  const env = {
    APP_URL: "https://example.test",
    DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next_buffering_kit_events",
    DISCORD_INVITE_URL: "https://discord.gg/example",
  } as never;
  const oldHtml = "<main>Old calendar bytes</main>";
  const newHtml = "<main>New calendar bytes</main>";
  const headers = {
    "cache-control": "public, max-age=60",
    vary: "Cookie, X-Two-Island",
    "x-two-events-cacheable": "true",
  };
  const request = () => new Request("https://example.test/events");

  it("does not settle HTML retired while its body is still buffering", async () => {
    const gate = deferred();
    const paused = deferred();
    let renders = 0;
    const resolve = async () => {
      renders++;
      if (renders === 1) {
        return new Response(gatedBody(oldHtml, paused.resolve, gate.promise), {
          status: 200,
          headers,
        });
      }
      return new Response(newHtml, { status: 200, headers });
    };

    const inflight = dispatchEventsRequest(request(), env, resolve, { now: 1000 });
    await paused.promise;
    // Retirement lands strictly inside clone().text(): any comparison made
    // before buffering has already passed, so only a comparison repeated
    // immediately before insertion can stop the stale write.
    retireAnonEventCaches();
    gate.resolve();

    const first = await inflight;
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    // The original caller may receive its original response...
    expect(await first.text()).toBe(oldHtml);

    // ...but the next guest must resolve fresh content, not the retired body.
    const second = await dispatchEventsRequest(request(), env, resolve, { now: 2000 });
    expect(renders).toBe(2);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await second.text()).toBe(newHtml);
  });

  it("settles normally when buffering completes without a retirement", async () => {
    const gate = deferred();
    const paused = deferred();
    let renders = 0;
    const resolve = async () => {
      renders++;
      return new Response(gatedBody(oldHtml, paused.resolve, gate.promise), {
        status: 200,
        headers,
      });
    };

    const inflight = dispatchEventsRequest(request(), env, resolve, { now: 1000 });
    await paused.promise;
    gate.resolve();
    const first = await inflight;
    expect(await first.text()).toBe(oldHtml);

    const second = await dispatchEventsRequest(request(), env, resolve, { now: 2000 });
    expect(renders).toBe(1);
    expect(second.headers.get("cache-control")).toBe("public, max-age=59");
    expect(second.headers.get("content-type")).toContain("text/html");
    expect(second.headers.get("vary")).toBe("Cookie, X-Two-Island");
    expect(await second.text()).toBe(oldHtml);
  });
});

describe("Kit past archive settlement during body buffering", () => {
  const env = {
    APP_URL: "https://example.test",
    DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next_buffering_kit_past",
  } as never;
  const oldHtml = "<main>Old archive bytes</main>";
  const newHtml = "<main>New archive bytes</main>";
  const headers = {
    "cache-control": "public, max-age=300",
    "x-two-past-cacheable": "true",
  };
  const request = () => new Request("https://example.test/events/past");
  const allow = async () => null;

  it("does not settle HTML retired while its body is still buffering", async () => {
    const gate = deferred();
    const paused = deferred();
    let renders = 0;
    const resolve = async () => {
      renders++;
      if (renders === 1) {
        return new Response(gatedBody(oldHtml, paused.resolve, gate.promise), {
          status: 200,
          headers,
        });
      }
      return new Response(newHtml, { status: 200, headers });
    };

    const inflight = dispatchPastArchiveRequest(request(), env, resolve, allow, 1000);
    await paused.promise;
    retireAnonEventCaches();
    gate.resolve();

    const first = await inflight;
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await first.text()).toBe(oldHtml);

    const second = await dispatchPastArchiveRequest(request(), env, resolve, allow, 2000);
    expect(renders).toBe(2);
    expect(second.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await second.text()).toBe(newHtml);
  });

  it("settles normally when buffering completes without a retirement", async () => {
    const gate = deferred();
    const paused = deferred();
    let renders = 0;
    const resolve = async () => {
      renders++;
      return new Response(gatedBody(oldHtml, paused.resolve, gate.promise), {
        status: 200,
        headers,
      });
    };

    const inflight = dispatchPastArchiveRequest(request(), env, resolve, allow, 1000);
    await paused.promise;
    gate.resolve();
    const first = await inflight;
    expect(await first.text()).toBe(oldHtml);

    const second = await dispatchPastArchiveRequest(request(), env, resolve, allow, 2000);
    expect(renders).toBe(1);
    expect(second.headers.get("cache-control")).toBe("public, max-age=299");
    expect(second.headers.get("content-type")).toContain("text/html");
    expect(await second.text()).toBe(oldHtml);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "Hono calendar/archive settlement during body buffering (agent-testdb)",
  () => {
    const APP_URL = "https://next.example.test";
    const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
    const FUTURE_START = new Date("2099-06-04T18:00:00Z");
    const FUTURE_END = new Date("2099-06-04T20:00:00Z");
    const PAST_START = new Date("2020-03-04T18:00:00Z");
    const PAST_END = new Date("2020-03-04T20:00:00Z");
    const discordStub: DiscordEventsSource = {
      upcoming: async () => [],
      lastReadFailed: () => false,
    };

    let fixture: MemberDataFixture;
    let realPostgres: typeof postgres;
    let store: ReturnType<typeof createMemorySessionStore>;
    let env: Env;

    beforeAll(async () => {
      realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
      vi.mocked(postgres).mockImplementation(realPostgres);
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
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
          location: "Voice",
          status: "published",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...over,
        })
        .returning();
      return row!;
    }

    async function moderatorCookie(): Promise<string> {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "moderator",
        username: "moderator",
        avatar: null,
        member: true,
        moderator: true,
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

    const guestGet = (path: string) => app.request(path, {}, env);

    async function rename(key: string, title: string): Promise<Response> {
      return app.request(
        `/events/${key}`,
        {
          method: "PATCH",
          headers: {
            cookie: await moderatorCookie(),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ title }),
        },
        env,
      );
    }

    it("does not settle /events HTML retired while its body is still buffering", async () => {
      const row = await seed({ title: "Old buffered night" });
      const gate = gateNextMarkedClone("Old buffered night");
      try {
        const inflight = guestGet("/events");
        await gate.pausedAtBuffering;
        // The moderator edit commits and retires strictly inside the
        // settlement clone().text() window of the in-flight render.
        const edited = await rename(row.eventKey, "New buffered night");
        expect(edited.status).toBe(200);
        gate.release();

        const overtaken = await inflight;
        expect(overtaken.status).toBe(200);
        expect(overtaken.headers.get("cache-control")).toBe("public, max-age=60");
        // The original caller may receive its original response...
        expect(await overtaken.text()).toContain("Old buffered night");

        // ...but the next guest must resolve the renamed event fresh.
        const fresh = await guestGet("/events");
        expect(fresh.headers.get("cache-control")).toBe("public, max-age=60");
        const html = await fresh.text();
        expect(html).toContain("New buffered night");
        expect(html).not.toContain("Old buffered night");
      } finally {
        gate.release();
        gate.restore();
      }
    });

    it("settles /events normally when buffering completes without a retirement", async () => {
      const row = await seed({ title: "Calm buffered night" });
      const gate = gateNextMarkedClone("Calm buffered night");
      try {
        const inflight = guestGet("/events");
        await gate.pausedAtBuffering;
        gate.release();
        const first = await inflight;
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("Calm buffered night");
      } finally {
        gate.release();
        gate.restore();
      }

      // A write that bypasses the store leaves a settled entry stale, proving
      // the second fetch is a normal shared-cache hit with remaining TTL.
      await fixture.client`update events set title = 'Smuggled calm' where id = ${row.id}`;
      const hit = await guestGet("/events");
      expect(hit.headers.get("cache-control")).toMatch(/^public, max-age=(59|60)$/);
      const html = await hit.text();
      expect(html).toContain("Calm buffered night");
      expect(html).not.toContain("Smuggled calm");
    });

    it("does not settle /events/past HTML retired while its body is still buffering", async () => {
      const row = await seed({
        title: "Old buffered past",
        startsAt: PAST_START,
        endsAt: PAST_END,
      });
      const gate = gateNextMarkedClone("Old buffered past");
      try {
        const inflight = guestGet("/events/past");
        await gate.pausedAtBuffering;
        const edited = await rename(row.eventKey, "New buffered past");
        expect(edited.status).toBe(200);
        gate.release();

        const overtaken = await inflight;
        expect(overtaken.status).toBe(200);
        expect(overtaken.headers.get("cache-control")).toBe("public, max-age=300");
        expect(await overtaken.text()).toContain("Old buffered past");

        const fresh = await guestGet("/events/past");
        expect(fresh.headers.get("cache-control")).toBe("public, max-age=300");
        const html = await fresh.text();
        expect(html).toContain("New buffered past");
        expect(html).not.toContain("Old buffered past");
      } finally {
        gate.release();
        gate.restore();
      }
    });

    it("settles /events/past normally when buffering completes without a retirement", async () => {
      const row = await seed({
        title: "Calm buffered past",
        startsAt: PAST_START,
        endsAt: PAST_END,
      });
      const gate = gateNextMarkedClone("Calm buffered past");
      try {
        const inflight = guestGet("/events/past");
        await gate.pausedAtBuffering;
        gate.release();
        const first = await inflight;
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("Calm buffered past");
      } finally {
        gate.release();
        gate.restore();
      }

      await fixture.client`update events set title = 'Smuggled past calm' where id = ${row.id}`;
      const hit = await guestGet("/events/past");
      expect(hit.headers.get("cache-control")).toMatch(/^public, max-age=(299|300)$/);
      const html = await hit.text();
      expect(html).toContain("Calm buffered past");
      expect(html).not.toContain("Smuggled past calm");
    });
  },
);
