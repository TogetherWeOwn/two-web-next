import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import { dispatchPastArchiveRequest, loadPastArchivePage } from "../src/kit-past-events";
import {
  HONO_FALLBACK_ROUTE_ID,
  dispatchHookRequest,
  type HookDispatchDeps,
} from "../src/route-ownership";

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

describe("past archive load helper", () => {
  const headersOf = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeaders: (next: Record<string, string>) => Object.assign(headers, next),
    };
  };
  const row = { id: 1 } as never;
  const fakeDb = {} as never;

  it("marks pages with rows cacheable with the public TTL", async () => {
    const { headers, setHeaders } = headersOf();
    const data = await loadPastArchivePage({
      env,
      pageParam: "2",
      setHeaders,
      dbForFn: async () => fakeDb,
      listPastFn: async () => ({ rows: [row], hasMore: true, totalPages: 3 }),
    });

    expect(data).toMatchObject({ page: 2, hasMore: true, totalPages: 3 });
    expect(data.rows).toEqual([row]);
    expect(headers["cache-control"]).toBe("public, max-age=300");
    expect(headers["x-two-past-cacheable"]).toBe("true");
  });

  it("uses the suggestions cutoff for unfiltered archive rows", async () => {
    const { setHeaders } = headersOf();
    let suggestionsNow: Date | undefined;
    let rowsNow: Date | undefined;

    await loadPastArchivePage({
      env,
      pageParam: "1",
      setHeaders,
      dbForFn: async () => fakeDb,
      listArchiveGamesFn: async (_db, now) => {
        suggestionsNow = now;
        return { games: [], omitted: false };
      },
      listPastFn: async (_db, _page, now) => {
        rowsNow = now;
        return { rows: [row], hasMore: false, totalPages: 1 };
      },
    });

    expect(suggestionsNow).toBeInstanceOf(Date);
    expect(rowsNow).toBe(suggestionsNow);
  });

  it("marks empty pages uncacheable so time-arriving events still render", async () => {
    const { headers, setHeaders } = headersOf();
    const data = await loadPastArchivePage({
      env,
      pageParam: "1",
      setHeaders,
      dbForFn: async () => fakeDb,
      listPastFn: async () => ({ rows: [], hasMore: false, totalPages: 0 }),
    });

    expect(data.rows).toEqual([]);
    expect(headers["cache-control"]).toBe("public, max-age=300");
    expect(headers["x-two-past-cacheable"]).toBe("false");
  });

  it("fails closed with private no-store when the database is missing", async () => {
    const { headers, setHeaders } = headersOf();
    await expect(
      loadPastArchivePage({
        env,
        pageParam: "1",
        setHeaders,
        dbForFn: async () => null,
        listPastFn: async () => ({ rows: [row], hasMore: false, totalPages: 1 }),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("fails closed with private no-store when the database throws", async () => {
    const { headers, setHeaders } = headersOf();
    await expect(
      loadPastArchivePage({
        env,
        pageParam: "1",
        setHeaders,
        dbForFn: async () => {
          throw new Error("db down");
        },
        listPastFn: async () => ({ rows: [row], hasMore: false, totalPages: 1 }),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("fails closed with private no-store when the read throws", async () => {
    const { headers, setHeaders } = headersOf();
    await expect(
      loadPastArchivePage({
        env,
        pageParam: "1",
        setHeaders,
        dbForFn: async () => fakeDb,
        listPastFn: async () => {
          throw new Error("read down");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects an oversized query before touching the database", async () => {
    const { headers, setHeaders } = headersOf();
    const setHeadersSpy = vi.fn(setHeaders);
    const dbForFn = vi.fn(async () => fakeDb);
    const listPastFn = vi.fn(async () => ({ rows: [row], hasMore: false, totalPages: 1 }));
    // Raw length governs admission: the blank variant normalizes to null yet
    // must still reject, so a later cleanup cannot drop the +page.server
    // pre-check trusting an unpinned helper.
    for (const queryParam of ["a".repeat(256), " ".repeat(256)]) {
      await expect(
        loadPastArchivePage({
          env,
          pageParam: "1",
          queryParam,
          setHeaders: setHeadersSpy,
          dbForFn,
          listPastFn,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-two-past-cacheable"]).toBeUndefined();
    expect(setHeadersSpy).toHaveBeenCalledTimes(2);
    expect(dbForFn).not.toHaveBeenCalled();
    expect(listPastFn).not.toHaveBeenCalled();
  });

  it("normalizes CR/CRLF queries to LF before the read so data-query and canonical agree", async () => {
    const { headers, setHeaders } = headersOf();
    const listPastFn = vi.fn(async () => ({ rows: [row], hasMore: false, totalPages: 1 }));
    const data = await loadPastArchivePage({
      env,
      pageParam: "1",
      queryParam: "alpha\r\nbeta",
      setHeaders,
      dbForFn: async () => fakeDb,
      listPastFn,
    });

    expect(data.q).toBe("alpha\nbeta");
    expect(listPastFn).toHaveBeenCalledWith(fakeDb, 1, expect.any(Date), "alpha\nbeta");
    expect(headers["cache-control"]).toBe("private, no-store");
  });
});

describe("hook archive dispatch", () => {
  const archiveManifest = [
    { method: "GET", path: "/events/past", enabled: true, reads: "public" },
  ] as HookDispatchDeps["manifest"];

  it("routes the archive through the guard and cache without rendering on refusal", async () => {
    const refusal = new Response("limited", { status: 429 });
    const resolve = vi.fn(async () => cachedResponse());
    const guard = vi.fn(async () => refusal);
    const deps: HookDispatchDeps = {
      appUrl: "https://example.test",
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      manifest: archiveManifest,
      pastArchive: (req, render) => dispatchPastArchiveRequest(req, env, render, guard, 1000),
    };
    const req = request();

    const response = await dispatchHookRequest(
      { request: req, url: new URL(req.url), route: { id: "/events/past" } },
      deps,
    );

    expect(response.status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledOnce();
  });

  it("does not wrap non-archive public routes", async () => {
    const pastArchive = vi.fn(async (_req: Request, render: () => Promise<Response>) => render());
    const resolve = vi.fn(async () => new Response("privacy"));
    const deps: HookDispatchDeps = {
      appUrl: "https://example.test",
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      manifest: [{ method: "GET", path: "/privacy", enabled: true, reads: "public" }],
      pastArchive,
    };
    const req = new Request("https://example.test/privacy");

    const response = await dispatchHookRequest(
      { request: req, url: new URL(req.url), route: { id: "/privacy" } },
      deps,
    );

    expect(await response.text()).toBe("privacy");
    expect(pastArchive).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not wrap the Hono fallback", async () => {
    const pastArchive = vi.fn(async (_req: Request, render: () => Promise<Response>) => render());
    const resolve = vi.fn(async () => new Response("hono-fallback"));
    const deps: HookDispatchDeps = {
      appUrl: "https://example.test",
      honoFetch: vi.fn(async () => new Response("hono")),
      resolve,
      manifest: archiveManifest,
      pastArchive,
    };
    const req = request();

    const response = await dispatchHookRequest(
      { request: req, url: new URL(req.url), route: { id: HONO_FALLBACK_ROUTE_ID } },
      deps,
    );

    expect(await response.text()).toBe("hono-fallback");
    expect(pastArchive).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe("archive load binding", () => {
  it("maps every helper throw to the branded 503 with the live page and DB args", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "web/src/routes/events/past/+page.server.ts"), "utf8");
    // Replacing the catch body with a rethrow stays green without these:
    // only error(503) proves what Kit sends, since SvelteKit's get_status
    // ignores the helper's status:503 Error property and renders a 500.
    expect(source).toContain('error(503, "Events temporarily unavailable")');
    expect(source).toMatch(/catch\s*\{[^}]*error\(503,\s*"Events temporarily unavailable"\)/s);
    // pageParam: null pins pagination to page 1 without this.
    expect(source).toContain('pageParam: url.searchParams.get("page")');
    expect(source).toContain("dbForFn: dbFor");
    expect(source).toContain("listPastFn: listPast");
  });
});
