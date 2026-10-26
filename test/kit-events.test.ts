import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import { dispatchEventsRequest, eventsUnavailable, loadEventsPage } from "../src/kit-events";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  decideOwner,
  dispatchHookRequest,
  resolveRouteOwner,
  type OwnedRoute,
} from "../src/route-ownership";

const env = {
  APP_URL: "https://example.test",
  DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next_tog22134events0001",
  DISCORD_INVITE_URL: "https://discord.gg/example",
} as never;

const html = '<main><section data-testid="events-calendar">Game nights</section></main>';
const cachedResponse = () =>
  new Response(html, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=60",
      vary: "Cookie, X-Two-Island",
      "x-two-events-cacheable": "true",
    },
  });
const privateResponse = () =>
  new Response(html, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      vary: "Cookie, X-Two-Island",
      "x-two-events-cacheable": "false",
    },
  });

const request = (url = "https://example.test/events", init?: RequestInit) => new Request(url, init);
const allow = async () => null;
const noSession = async () => null;
const noFlash = async () => null;

const baseModel = () => ({
  state: {
    view: "list",
    month: "2026-10",
    q: "",
    game: "",
    past: false,
    page: 1,
    weekStart: "monday",
  },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  totalPages: 1,
  emptyState: null,
  robots: undefined,
  discordFailed: false,
  games: [],
  gameFilter: null,
});

function loadArgs(overrides: Record<string, unknown> = {}) {
  const setHeaders = vi.fn();
  const deleteJoinCookie = vi.fn();
  return {
    args: {
      env,
      url: new URL("https://example.test/events"),
      method: "GET",
      island: false,
      request: request(),
      setHeaders,
      deleteJoinCookie,
      dbForFn: async () => ({}) as never,
      sessionForFn: noSession as () => Promise<null>,
      journeyForFn: noFlash as () => Promise<null>,
      modelForFn: async () => baseModel(),
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
      ...overrides,
    } as Parameters<typeof loadEventsPage>[0],
    setHeaders: setHeaders as ReturnType<typeof vi.fn>,
    deleteJoinCookie: deleteJoinCookie as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  __resetAnonEventCacheForTests();
  vi.restoreAllMocks();
});

describe("Kit events list response parity", () => {
  it("guards before a cache hit and shares anonymous HTML with remaining TTL", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const guard = vi.fn(allow);
    const first = await dispatchEventsRequest(request(), env, resolve, {
      guard,
      sessionFor: noSession,
      journeyFor: noFlash,
      now: 1000,
    });
    const second = await dispatchEventsRequest(request(), env, resolve, {
      guard,
      sessionFor: noSession,
      journeyFor: noFlash,
      now: 2000,
    });

    expect(guard).toHaveBeenCalledTimes(2);
    expect(renders).toBe(1);
    expect(await second.text()).toBe(html);
    expect(second.headers.get("cache-control")).toBe("public, max-age=59");
    expect(second.headers.get("content-type")).toContain("text/html");
    expect(second.headers.get("x-two-events-cacheable")).toBeNull();
    expect(await first.text()).toBe(html);
  });

  it("keys island fragments separately from full renders", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const island = () =>
      request("https://example.test/events", { headers: { "x-two-island": "events-calendar" } });
    await dispatchEventsRequest(request(), env, resolve, { now: 1000 });
    await dispatchEventsRequest(island(), env, resolve, { now: 1000 });
    await dispatchEventsRequest(request(), env, resolve, { now: 2000 });

    expect(renders).toBe(2);
  });

  it("does not share responses for requests carrying cookies", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const withCookie = () =>
      request("https://example.test/events", { headers: { cookie: "session=opaque" } });

    await dispatchEventsRequest(withCookie(), env, resolve, { now: 1000 });
    await dispatchEventsRequest(withCookie(), env, resolve, { now: 2000 });

    expect(renders).toBe(2);
  });

  it("skips the session store read for cookie-bearing requests", async () => {
    const sessionFor = vi.fn(async () => ({
      username: "kit-member",
      member: true,
      moderator: false,
    }));
    const withCookie = () =>
      request("https://example.test/events", { headers: { cookie: "session=opaque" } });
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    await dispatchEventsRequest(withCookie(), env, resolve, { sessionFor, now: 1000 });
    await dispatchEventsRequest(withCookie(), env, resolve, { sessionFor, now: 2000 });

    // Any Cookie header already excludes the shared cache, so the store read
    // can never change the decision: cookie-bearing views must not pay for it.
    expect(renders).toBe(2);
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("does not share searches or flashed renders", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    await dispatchEventsRequest(request("https://example.test/events?q=chess"), env, resolve, {
      now: 1000,
    });
    await dispatchEventsRequest(request("https://example.test/events?q=chess"), env, resolve, {
      now: 2000,
    });
    expect(renders).toBe(2);

    renders = 0;
    const flashed = () =>
      request("https://example.test/events", {
        headers: { cookie: "__Host-two_join_result=signed" },
      });
    const journeyFor = async () => "added" as const;
    await dispatchEventsRequest(flashed(), env, resolve, { journeyFor, now: 1000 });
    await dispatchEventsRequest(flashed(), env, resolve, { journeyFor, now: 2000 });
    expect(renders).toBe(2);
  });

  it("does not share authenticated renders", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const sessionFor = async () => ({ username: "kit-member", member: true, moderator: false });
    await dispatchEventsRequest(request(), env, resolve, { sessionFor, now: 1000 });
    await dispatchEventsRequest(request(), env, resolve, { sessionFor, now: 2000 });

    expect(renders).toBe(2);
  });

  it("does not settle a render overtaken by an event-cache retirement", async () => {
    let renders = 0;
    const response = await dispatchEventsRequest(
      request(),
      env,
      async () => {
        renders++;
        retireAnonEventCaches();
        return cachedResponse();
      },
      { now: 1000 },
    );
    await response.text();

    await dispatchEventsRequest(
      request(),
      env,
      async () => {
        renders++;
        return cachedResponse();
      },
      { now: 2000 },
    );

    expect(renders).toBe(2);
  });

  it("never settles a private response into the shared cache", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return privateResponse();
    };
    await dispatchEventsRequest(request(), env, resolve, { now: 1000 });
    await dispatchEventsRequest(request(), env, resolve, { now: 2000 });

    expect(renders).toBe(2);
  });

  it("never caches Kit data requests as HTML", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const data = () => request("https://example.test/events/__data.json");
    await dispatchEventsRequest(data(), env, resolve, { now: 1000 });
    await dispatchEventsRequest(data(), env, resolve, { now: 2000 });

    expect(renders).toBe(2);
  });

  it("enforces the shared public-read budget before serving list HTML", async () => {
    let sql: ((parts: TemplateStringsArray) => Promise<unknown[]>) & {
      begin: (run: (tx: never) => Promise<unknown>) => Promise<unknown>;
    };
    sql = Object.assign(
      vi.fn(async (parts: TemplateStringsArray) =>
        parts.join("").includes("SELECT count(*)") ? [{ n: 60, wait: 12 }] : [],
      ),
      {
        begin: async (run: (tx: never) => Promise<unknown>) => run(sql as never),
        // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before
        // the advisory lock; the double passes it through.
        unsafe: async () => [],
      },
    );
    const throttledEnv = {
      APP_URL: "https://example.test",
      THROTTLE_STORE: async () => sql,
    } as never;
    const resolve = vi.fn(async () => cachedResponse());

    const response = await dispatchEventsRequest(request(), throttledEnv, resolve);

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("Kit events list query-state contract", () => {
  it("renders guests as public with a rooted return-to and no drafts", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const { args, setHeaders } = loadArgs({ modelForFn });
    const data = await loadEventsPage(args);

    expect(data).toMatchObject({
      member: false,
      moderator: false,
      canonical: "https://example.test/events",
      loginReturnTo: "/events",
      joinResult: null,
    });
    expect(modelForFn).toHaveBeenCalledWith(expect.objectContaining({ includeDrafts: false }));
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        "cache-control": "public, max-age=60",
        vary: "Cookie, X-Two-Island",
      }),
    );
  });

  it("marks member renders private and moderator renders draft-inclusive", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const member = loadArgs({
      modelForFn,
      sessionForFn: async () => ({ member: true, moderator: false }),
    });
    const memberData = await loadEventsPage(member.args);
    expect(memberData).toMatchObject({ member: true, moderator: false });
    expect(member.setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );
    expect(modelForFn).toHaveBeenCalledWith(expect.objectContaining({ includeDrafts: false }));

    const moderator = loadArgs({
      modelForFn,
      sessionForFn: async () => ({ member: true, moderator: true }),
    });
    const moderatorData = await loadEventsPage(moderator.args);
    expect(moderatorData).toMatchObject({ member: true, moderator: true });
    expect(modelForFn).toHaveBeenCalledWith(expect.objectContaining({ includeDrafts: true }));
  });

  it("normalizes list state and bounds pages like Hono", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const { args } = loadArgs({
      modelForFn,
      url: new URL("https://example.test/events?view=calendar&month=2026-13&page=abc&past=1"),
    });
    const data = await loadEventsPage(args);
    expect(modelForFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ view: "calendar", page: 1, past: true }),
      }),
    );
    expect(data).toMatchObject({
      loginReturnTo: "/events?view=calendar&month=2026-13&page=abc&past=1",
    });
  });

  it("keeps searches private with in-body robots and records noindex on jumps", async () => {
    const modelForFn = vi.fn(async () => ({
      ...baseModel(),
      robots: "noindex, follow",
    }));
    const { args, setHeaders } = loadArgs({
      modelForFn,
      url: new URL("https://example.test/events?q=chess"),
    });
    const data = await loadEventsPage(args);
    expect(data).toMatchObject({ robots: "noindex, follow" });
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, follow",
      }),
    );
    expect(modelForFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ searching: true, view: "list" }),
      }),
    );
  });

  it("answers overlong Unicode searches with a 422 marker that never echoes the query", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const query = "x".repeat(256);
    const { args, setHeaders } = loadArgs({
      modelForFn,
      url: new URL(`https://example.test/events?q=${query}`),
    });
    const data = await loadEventsPage(args);

    expect(data).toEqual({ queryTooLong: true, appUrl: "https://example.test" });
    expect(modelForFn).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        "cache-control": "no-store, private",
        "x-two-events-too-long": "true",
      }),
    );
  });

  it("counts the search limit in code points, not UTF-16 units", async () => {
    const modelForFn = vi.fn(async () => baseModel());
    const query = "😀".repeat(255);
    expect([...query].length).toBe(255);
    const { args } = loadArgs({
      modelForFn,
      url: new URL(`https://example.test/events?q=${encodeURIComponent(query)}`),
    });
    const data = await loadEventsPage(args);

    expect(data).toMatchObject({ queryTooLong: false });
    expect(modelForFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed to a branded 503 with private no-store on DB outage", async () => {
    const { args, setHeaders } = loadArgs({ dbForFn: async () => null });
    await expect(loadEventsPage(args)).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );

    const throwing = loadArgs({
      dbForFn: async () => {
        throw new Error("down");
      },
    });
    await expect(loadEventsPage(throwing.args)).rejects.toMatchObject({ status: 503 });

    const failingModel = loadArgs({
      modelForFn: async () => {
        throw new Error("down");
      },
    });
    await expect(loadEventsPage(failingModel.args)).rejects.toMatchObject({ status: 503 });
    expect(eventsUnavailable()).toMatchObject({ status: 503 });
  });

  it("consumes the join flash on full renders but never on fragments", async () => {
    const full = loadArgs({ journeyForFn: async () => "added" as const });
    const fullData = await loadEventsPage(full.args);
    expect(fullData).toMatchObject({ joinResult: "added" });
    expect(full.deleteJoinCookie).toHaveBeenCalledTimes(1);
    expect(full.setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );

    const journeyFor = vi.fn(async () => "added" as const);
    const fragment = loadArgs({ island: true, journeyForFn: journeyFor });
    const fragmentData = await loadEventsPage(fragment.args);
    expect(fragmentData).toMatchObject({ joinResult: null });
    expect(journeyFor).not.toHaveBeenCalled();
    expect(fragment.deleteJoinCookie).not.toHaveBeenCalled();
  });

  it("keeps flashed HEAD responses private without consuming the flash", async () => {
    const journeyForFn = vi.fn(async () => "added" as const);
    const head = loadArgs({ method: "HEAD", journeyForFn });
    const data = await loadEventsPage(head.args);

    expect(journeyForFn).toHaveBeenCalledOnce();
    expect(data).toMatchObject({ joinResult: null });
    expect(head.deleteJoinCookie).not.toHaveBeenCalled();
    expect(head.setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );
  });

  it("leaves the join flash pending when the model read fails", async () => {
    const failingModel = loadArgs({
      journeyForFn: async () => "added" as const,
      modelForFn: async () => {
        throw new Error("down");
      },
    });
    // Hono consumes the flash only after loadCalendarPageModel succeeds, so a
    // branded 503 must not eat the banner the member never saw.
    await expect(loadEventsPage(failingModel.args)).rejects.toMatchObject({ status: 503 });
    expect(failingModel.deleteJoinCookie).not.toHaveBeenCalled();
  });
});

describe("Kit events list route ownership", () => {
  it("ships GET and HEAD on Kit with POST and the JSON contract on Hono", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/events" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/events" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/events" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events.json" })).toBe("hono");
    expect(decideOwner(new Request("https://example.test/events"))).toBe("kit");
  });

  it("rolls back to Hono through a disabled manifest entry", () => {
    const manifest: OwnedRoute[] = [
      { method: "GET", path: "/events", enabled: false, reads: "public" },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: "/events" }, manifest)).toBe("hono");
  });

  it("ignores the fragment header in the ownership decision", () => {
    const fragment = new Request("https://example.test/events", {
      headers: { "x-two-island": "events-calendar" },
    });
    expect(decideOwner(fragment)).toBe(decideOwner(new Request("https://example.test/events")));
  });

  it("flips to Kit only through an enabled manifest entry", () => {
    const manifest: OwnedRoute[] = [
      { method: "GET", path: "/events", enabled: true, reads: "public" },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events" }, manifest)).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/events" }, manifest)).toBe("hono");
  });
});

describe("Kit events list hook branch", () => {
  const APP_URL = "https://example.test";
  const manifest: OwnedRoute[] = [
    { method: "GET", path: "/events", enabled: true, reads: "public" },
  ];
  const eventFor = (path: string, init?: RequestInit) => {
    const req = new Request(new URL(path, APP_URL).href, {
      ...init,
      headers: { host: "example.test", ...(init?.headers ?? {}) },
    });
    return { request: req, url: new URL(req.url), route: { id: "/events" } };
  };
  const deps = (overrides: Record<string, unknown> = {}) => ({
    appUrl: APP_URL,
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(
      async () =>
        new Response("<html>kit list</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ),
    manifest,
    ...overrides,
  });

  it("runs the list guard/cache wrapper on the Kit branch and decorates", async () => {
    const eventsPage = vi.fn(async (_request: Request, render: () => Promise<Response>) =>
      render(),
    );
    const d = deps({ eventsPage });
    const response = await dispatchHookRequest(eventFor("/events"), d);

    expect(eventsPage).toHaveBeenCalledOnce();
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("resolves directly when no list wrapper is bound", async () => {
    const d = deps();
    const response = await dispatchHookRequest(eventFor("/events"), d);

    expect(d.resolve).toHaveBeenCalledOnce();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("sends POST /events to Hono with the body unread", async () => {
    const d = deps();
    const event = eventFor("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Seed swap" }),
    });
    const response = await dispatchHookRequest(event, d);

    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });
});

describe("Kit events list endpoint binding", () => {
  it("pins the island, cookie, wiring and 503 contract of +server.ts", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "web/src/routes/events/+server.ts"), "utf8");
    // Replacing the catch body with a rethrow stays green without these:
    // only error(503) proves what Kit sends, since SvelteKit's get_status
    // ignores the helper's status:503 Error property and renders a 500.
    expect(source).toContain('error(503, "Events temporarily unavailable")');
    expect(source).toMatch(/catch\s*\{[\s\S]*?error\(503,\s*"Events temporarily unavailable"\)/);
    // Island fragments keep their pending flash: only the full-render island
    // expression preserves the banner the fragment cannot display.
    expect(source).toContain('request.headers.get("x-two-island") === "events-calendar"');
    // The browser ignores a __Host- cookie delete without path and secure.
    expect(source).toContain("cookies.delete(JOIN_RESULT_COOKIE");
    expect(source).toContain('path: "/"');
    expect(source).toContain("secure: true");
    expect(source).toContain("httpOnly: true");
    expect(source).toContain('sameSite: "lax"');
    // Helper wiring: the endpoint renders through the tested load and screen.
    expect(source).toContain("loadEventsPage");
    expect(source).toContain("renderEventsHtml");
    expect(source).toContain("dbForFn: dbFor");
    expect(source).toContain("kitEventsSessionFor(env)");
    expect(source).toContain("kitEventsJourneyFor(env)");
    // Rendering can fail after the helper collected public success headers.
    // The catch must fail closed rather than reapply that success policy.
    expect(source).toMatch(/catch\s*\{[\s\S]*?"cache-control":\s*"private, no-store"/);
    expect(source).toMatch(/catch\s*\{[\s\S]*?vary:\s*"Cookie, X-Two-Island"/);
  });
});
