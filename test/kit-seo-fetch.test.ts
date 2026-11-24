import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { checkJoinThrottle } from "../src/join/service";
import { fetchKitSeo } from "../src/kit-seo-fetch";
import {
  dispatchHookRequest,
  type HookEventLike,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  resolveRouteOwner,
} from "../src/route-ownership";
import { fetchApp } from "./helpers/fetch-app";
import { env as baseEnv } from "./helpers/member-data";
import { projectEventRow } from "./helpers/pg-proxy-event-projection";

vi.mock("../src/join/service", async (original) => ({
  ...(await original<typeof import("../src/join/service")>()),
  checkJoinThrottle: vi.fn(),
}));

const ROBOTS = "/robots.txt";
const SITEMAP = "/sitemap_index.xml";
const REQUEST_ID = "0123456789abcdef-IAD";
const IP = "192.0.2.44";
const CONTEXT = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.mocked(checkJoinThrottle).mockReset().mockResolvedValue({ limited: false });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// Hosted Vitest exercises the serving dispatcher's exact-family admission
// with a fixture catalog and a resolve callback standing in for the mount.
function dispatch(
  request: Request,
  env: EnvWithAdminDb,
  { flag = "true", routeId = new URL(request.url).pathname, isDataRequest = false } = {},
) {
  const resolve = vi.fn(async (event: HookEventLike) => {
    const locals = event.locals as { requestId?: string };
    const response = await fetchKitSeo(event.request, env, locals.requestId);
    if (!response) throw new Error("The SEO adapter declined an admitted route");
    return response;
  });
  const honoFetch = vi.fn((req: Request) => fetchApp(req, env, CONTEXT));
  const sessionFor = vi.fn(() => {
    throw new Error("SEO dispatch read a session");
  });
  const response = dispatchHookRequest(
    { request, url: new URL(request.url), route: { id: routeId }, isDataRequest },
    {
      appUrl: env.APP_URL,
      honoFetch,
      resolve,
      sessionFor,
      apiFamilies: [
        {
          flag,
          routes: [ROBOTS, SITEMAP].map((path) => ({
            method: "GET",
            path,
            enabled: true,
            reads: "public",
          })),
        },
      ],
    },
  );
  return { response, resolve, honoFetch, sessionFor };
}

async function compare(
  path: string,
  env: EnvWithAdminDb,
  {
    init,
    options,
    candidate = true,
  }: { init?: RequestInit; options?: Parameters<typeof dispatch>[2]; candidate?: boolean } = {},
) {
  const url = new URL(path, env.APP_URL);
  const headers = new Headers(init?.headers);
  headers.set("cf-ray", REQUEST_ID);
  headers.set("cf-connecting-ip", IP);
  const request = () => new Request(url, { ...init, headers });
  const baseline = await fetchApp(request(), env, CONTEXT);
  const run = dispatch(request(), env, options);
  const response = await run.response;
  expect(run.resolve).toHaveBeenCalledTimes(candidate ? 1 : 0);
  expect(run.honoFetch).toHaveBeenCalledTimes(candidate ? 0 : 1);
  expect(run.sessionFor).not.toHaveBeenCalled();
  expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(candidate ? KIT_RENDERER_VALUE : null);
  expect(response.status).toBe(baseline.status);
  for (const name of [
    "content-type",
    "cache-control",
    "location",
    "etag",
    "last-modified",
    "vary",
    "retry-after",
    "x-robots-tag",
    "x-content-type-options",
    "content-security-policy",
    "x-request-id",
  ]) {
    expect(response.headers.get(name), name).toBe(baseline.headers.get(name));
  }
  expect(response.headers.getSetCookie()).toEqual(baseline.headers.getSetCookie());
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes).toEqual(Buffer.from(await baseline.arrayBuffer()));
  return { response, body: bytes.toString("utf8") };
}

function requestInit(method: string, accept: string): RequestInit {
  return {
    method,
    headers: {
      accept,
      "if-none-match": "*",
      "if-modified-since": "Fri, 01 Jan 2100 00:00:00 GMT",
      "user-agent": "SyntheticCrawler/1.0",
      "x-forwarded-host": "forwarded.example.test",
    },
  };
}

function expectPublicResponse(response: Response, contentType: string) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(contentType);
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  for (const name of ["x-robots-tag", "etag", "last-modified"])
    expect(response.headers.get(name)).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
}

it.each(["https://togetherweown.com", "https://staging.example.test/"])(
  "advertises the configured sitemap to crawlers on %s without a DB or a validator",
  async (APP_URL) => {
    const acquire = vi.fn(() => {
      throw new Error("robots must not acquire the DB");
    });
    const env = {
      ...baseEnv,
      APP_URL,
      get ADMIN_DB() {
        return acquire();
      },
    };
    const get = await compare(ROBOTS, env, { init: requestInit("GET", "text/plain") });
    expect(get.body).toBe(`User-agent: *\nDisallow:\nSitemap: ${new URL(SITEMAP, APP_URL).href}\n`);
    const head = await compare(ROBOTS, env, { init: requestInit("HEAD", "text/plain") });
    expect(head.body).toBe("");
    for (const { response } of [get, head])
      expectPublicResponse(response, "text/plain; charset=UTF-8");
    expect(acquire).not.toHaveBeenCalled();
    expect(checkJoinThrottle).not.toHaveBeenCalled();
  },
);

it("serves only bounded published event URLs in the existing sitemap URL set", async () => {
  const start = "2020-01-01T12:00:00.000Z";
  const end = "2020-01-01T14:00:00.000Z";
  const updated = "2020-01-02T00:00:00.000Z";
  const row = (eventKey: string, status = "published", endsAt = end) => ({
    eventKey,
    status,
    startsAt: start,
    endsAt,
    updatedAt: updated,
    description: "synthetic-private-column",
  });
  const rows = [
    row("draft-key", "draft"),
    row("cancelled-key", "cancelled"),
    row("past-key", "past"),
    row("public&key"),
    row(`oversized-${"é".repeat(128)}`),
    row("invalid-window", "published", "infinity"),
    ...Array.from({ length: 998 }, (_, index) => row(`bounded-${index}`)),
  ];
  // pg-proxy supplies rows at the SQL boundary. Assert the projection, WHERE,
  // order and LIMIT independently of the XML so a static fallback cannot pass.
  const query = vi.fn(async (sql: string, params: unknown[]) => ({
    rows: rows
      .filter((event) => event.status === params[1])
      .slice(0, Number(params[2]))
      .map((event) => projectEventRow(sql, params, event, (value) => value)),
  }));
  const env = {
    ...baseEnv,
    APP_URL: "https://staging.example.test",
    ADMIN_DB: drizzle(query) as unknown as Db,
  };
  const get = await compare(`${SITEMAP}?crawler=1`, env, {
    init: requestInit("GET", "application/xml"),
  });
  const head = await compare(SITEMAP, env, { init: requestInit("HEAD", "application/xml") });
  expect(head.body).toBe("");
  for (const { response } of [get, head])
    expectPublicResponse(response, "application/xml; charset=UTF-8");
  expect(get.body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  expect(get.body).toContain(`<loc>${env.APP_URL}/e/public&amp;key</loc>`);
  expect(get.body).toContain(`<lastmod>${updated}</lastmod>`);
  const locations = [...get.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(locations).toEqual(
    [
      "/",
      "/join",
      "/events",
      "/about",
      "/faq",
      "/rules",
      "/privacy",
      "/e/public&amp;key",
      ...Array.from({ length: 997 }, (_, index) => `/e/bounded-${index}`),
    ].map((path) => `${env.APP_URL}${path}`),
  );
  expect(get.body).not.toContain("synthetic-private-column");
  expect(query).toHaveBeenCalledTimes(4);
  for (const [sql, params] of query.mock.calls) {
    expect(sql).toBe(
      'select case when octet_length("event_key") <= $1 then "event_key" end, "starts_at", "ends_at", "updated_at" from "events" where "events"."status" = $2 order by "events"."starts_at" asc, "events"."id" asc limit $3',
    );
    expect(params).toEqual([256, "published", 1000]);
  }
  expect(checkJoinThrottle).toHaveBeenCalledTimes(4);
  for (const call of vi.mocked(checkJoinThrottle).mock.calls)
    expect(call).toEqual([null, `events-read:${IP}`, 60]);
});

it("degrades to the static sitemap when the query fails", async () => {
  const query = vi.fn(async () => {
    throw new Error("synthetic driver detail");
  });
  const noBinding = await compare(SITEMAP, baseEnv);
  const failed = await compare(SITEMAP, { ...baseEnv, ADMIN_DB: drizzle(query) as unknown as Db });
  expect(query).toHaveBeenCalledTimes(2);
  expect(failed.response.status).toBe(200);
  expect(failed.body).toBe(noBinding.body);
  expect(failed.body).toContain(`<loc>${baseEnv.APP_URL}/</loc>`);
  expect(failed.body).not.toContain("/e/");
});

it("refuses a throttled sitemap before DB acquisition on GET and HEAD", async () => {
  vi.mocked(checkJoinThrottle).mockResolvedValue({ limited: true, retryAfter: 42 });
  const acquire = vi.fn(() => {
    throw new Error("throttled request must not acquire the DB");
  });
  const env = {
    ...baseEnv,
    get ADMIN_DB() {
      return acquire();
    },
  };
  for (const method of ["GET", "HEAD"]) {
    const { response, body } = await compare(SITEMAP, env, {
      init: requestInit(method, "application/json"),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("content-type")).toBe("application/json");
    if (method === "HEAD") expect(body).toBe("");
    else expect(JSON.parse(body)).toMatchObject({ code: "rate_limited", request_id: REQUEST_ID });
  }
  expect(checkJoinThrottle).toHaveBeenCalledTimes(4);
  expect(acquire).not.toHaveBeenCalled();
});

it("preserves Hono ownership with the flag off and for aliases, foreign hosts and other methods", async () => {
  for (const path of [ROBOTS, SITEMAP]) {
    expect(resolveRouteOwner({ method: "GET", path })).toBe("hono");
    const { response } = await compare(path, baseEnv, {
      options: { flag: "false" },
      candidate: false,
    });
    expect(response.status).toBe(200);
  }
  for (const [path, status] of [
    ["/%72obots.txt", 200],
    ["/sitemap%5Findex.xml", 200],
    ["/robots.txt/", 404],
    ["/sitemap_index.xml/", 404],
    ["/sitemap.xml", 404],
    ["/robots.txt/__data.json", 404],
    ["https://foreign.example.test/sitemap_index.xml", 404],
  ] as const) {
    const result = await compare(path, baseEnv, {
      options: path.endsWith("__data.json") ? { routeId: ROBOTS, isDataRequest: true } : undefined,
      candidate: false,
    });
    expect(result.response.status, path).toBe(status);
  }
  const refusals: RequestInit[] = [
    { headers: { host: "foreign.example.test" } },
    { method: "POST", headers: { origin: baseEnv.APP_URL } },
  ];
  for (const init of refusals) {
    const { response } = await compare(ROBOTS, baseEnv, { init, candidate: false });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  }
  await expect(
    fetchKitSeo(new Request(new URL(ROBOTS, baseEnv.APP_URL), { method: "POST" }), baseEnv),
  ).resolves.toBeNull();
  await expect(
    fetchKitSeo(new Request(new URL("/%72obots.txt", baseEnv.APP_URL)), baseEnv),
  ).resolves.toBeNull();
});

it("keeps the branded Hono failure and redacts unexpected error details", async () => {
  const env = {
    ...baseEnv,
    get E2E_PUBLIC_READ_BUDGET(): string {
      throw new Error("synthetic driver detail");
    },
  };
  const { response, body } = await compare(SITEMAP, env);
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(body).toContain(REQUEST_ID);
  expect(body).not.toContain("synthetic driver detail");
});
