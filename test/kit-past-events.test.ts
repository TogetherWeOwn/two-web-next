import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import { dispatchPastArchiveRequest } from "../src/kit-past-events";
import { dispatchHookRequest, type HookDispatchDeps } from "../src/route-ownership";

const env = {
  APP_URL: "https://example.test",
  DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next_tog1234567890123456",
} as never;
const html = '<main><li class="schedule-row">Past event</li></main>';
const cachedResponse = () =>
  new Response(html, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=300",
      "x-two-past-cacheable": "true",
    },
  });
const request = (url = "https://example.test/events/past") => new Request(url);
const allow = async () => null;

afterEach(() => {
  __resetAnonEventCacheForTests();
  vi.restoreAllMocks();
});

describe("Kit past archive response parity", () => {
  it("guards before a cache hit and shares anonymous HTML with remaining TTL", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const guard = vi.fn(allow);
    const first = await dispatchPastArchiveRequest(request(), env, resolve, guard, 1000);
    const second = await dispatchPastArchiveRequest(request(), env, resolve, guard, 2000);

    expect(guard).toHaveBeenCalledTimes(2);
    expect(renders).toBe(1);
    expect(await second.text()).toBe(html);
    expect(second.headers.get("cache-control")).toBe("public, max-age=299");
    expect(second.headers.get("content-type")).toContain("text/html");
    expect(second.headers.get("x-two-past-cacheable")).toBeNull();
    expect(await first.text()).toBe(html);
  });

  it("does not settle a render overtaken by an event-cache retirement", async () => {
    let renders = 0;
    const response = await dispatchPastArchiveRequest(
      request(),
      env,
      async () => {
        renders++;
        retireAnonEventCaches();
        return cachedResponse();
      },
      allow,
      1000,
    );
    await response.text();

    await dispatchPastArchiveRequest(
      request(),
      env,
      async () => {
        renders++;
        return cachedResponse();
      },
      allow,
      2000,
    );

    expect(renders).toBe(2);
  });

  it("does not share responses for requests carrying cookies", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };
    const withCookie = () =>
      new Request("https://example.test/events/past", { headers: { cookie: "session=opaque" } });

    await dispatchPastArchiveRequest(withCookie(), env, resolve, allow, 1000);
    await dispatchPastArchiveRequest(withCookie(), env, resolve, allow, 2000);

    expect(renders).toBe(2);
  });

  it("enforces the shared public-read budget before serving archive HTML", async () => {
    let sql: ((parts: TemplateStringsArray) => Promise<unknown[]>) & {
      begin: (run: (tx: never) => Promise<unknown>) => Promise<unknown>;
    };
    sql = Object.assign(
      vi.fn(async (parts: TemplateStringsArray) =>
        parts.join("").includes("SELECT count(*)") ? [{ n: 60, wait: 12 }] : [],
      ),
      { begin: async (run: (tx: never) => Promise<unknown>) => run(sql as never) },
    );
    const throttledEnv = {
      APP_URL: "https://example.test",
      THROTTLE_STORE: async () => sql,
    } as never;
    const resolve = vi.fn(async () => cachedResponse());

    const response = await dispatchPastArchiveRequest(request(), throttledEnv, resolve);

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns a guard refusal without rendering or caching the page", async () => {
    const refusal = new Response("limited", { status: 429 });
    const resolve = vi.fn(async () => cachedResponse());
    const guard = vi.fn(async () => refusal);

    const response = await dispatchPastArchiveRequest(request(), env, resolve, guard, 1000);

    expect(response).toBe(refusal);
    expect(resolve).not.toHaveBeenCalled();
    await dispatchPastArchiveRequest(request(), env, resolve, allow, 2000);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not bridge a session into the public archive route", async () => {
    const sessionFor = vi.fn(async () => {
      throw new Error("public archive must not read sessions");
    });
    const deps: HookDispatchDeps = {
      appUrl: "https://example.test",
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve: vi.fn(async () => new Response("archive")),
      manifest: [{ method: "GET", path: "/events/past", enabled: true, reads: "public" }],
      sessionFor,
    };
    const req = request();

    const response = await dispatchHookRequest(
      { request: req, url: new URL(req.url), route: { id: "/events/past" } },
      deps,
    );

    expect(await response.text()).toBe("archive");
    expect(sessionFor).not.toHaveBeenCalled();
  });

  it("does not cache empty, out-of-range, or branded outage responses", async () => {
    let renders = 0;
    const empty = () =>
      new Response("<p>Archive is empty</p>", {
        status: 200,
        headers: { "cache-control": "public, max-age=300", "x-two-past-cacheable": "false" },
      });
    const outage = () =>
      new Response("<h1>We will be right back</h1>", {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      });

    for (const resolve of [empty, outage]) {
      await dispatchPastArchiveRequest(
        request(),
        env,
        async () => {
          renders++;
          return resolve();
        },
        allow,
        1000,
      );
      await dispatchPastArchiveRequest(
        request(),
        env,
        async () => {
          renders++;
          return resolve();
        },
        allow,
        2000,
      );
    }

    expect(renders).toBe(4);
  });

  it("normalizes page query values before sharing their response", async () => {
    let renders = 0;
    const resolve = async () => {
      renders++;
      return cachedResponse();
    };

    await dispatchPastArchiveRequest(
      request("https://example.test/events/past?page=01"),
      env,
      resolve,
      allow,
      1000,
    );
    await dispatchPastArchiveRequest(
      request("https://example.test/events/past?page=1"),
      env,
      resolve,
      allow,
      2000,
    );

    expect(renders).toBe(1);
  });
});
