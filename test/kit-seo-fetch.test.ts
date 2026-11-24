import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import type { Db } from "../src/db/index";
import { checkJoinThrottle } from "../src/join/service";
import { fetchKitSeo } from "../src/kit-seo-fetch";
import { KIT_SEO_ROUTES } from "../src/kit-seo-routes";
import {
  dispatchHookRequest,
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

beforeEach(() => {
  vi.mocked(checkJoinThrottle).mockReset().mockResolvedValue({ limited: false });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function compare(
  path: string,
  env: typeof baseEnv & { ADMIN_DB?: Db },
  options: {
    init?: RequestInit;
    fallback?: boolean;
    flag?: string;
    dataRoute?: string;
  } = {},
) {
  const { init, fallback = false, flag = "true", dataRoute } = options;
  const url = new URL(path, env.APP_URL);
  const headers = new Headers(init?.headers);
  headers.set("cf-ray", REQUEST_ID);
  headers.set("cf-connecting-ip", IP);
  headers.set("if-none-match", "*");
  headers.set("if-modified-since", "Fri, 01 Jan 2100 00:00:00 GMT");
  headers.set("user-agent", "SyntheticCrawler/1.0");
  headers.set("x-forwarded-host", "forwarded.example.test");
  const request = new Request(url, { ...init, headers });
  const baseline = await fetchApp(new Request(request), env);
  const resolve = vi.fn<Parameters<typeof dispatchHookRequest>[1]["resolve"]>(async (event) => {
    const locals = event.locals as { requestId?: string };
    const candidate = await fetchKitSeo(event.request, env, locals.requestId);
    if (!candidate) throw new Error("The SEO adapter declined an admitted route");
    return candidate;
  });
  const honoFetch = vi.fn((req: Request) => fetchApp(req, env));
  const sessionFor = vi.fn().mockRejectedValue(new Error("SEO dispatch read a session"));
  // The resolve callback stands in for the mounted endpoints.
  const response = await dispatchHookRequest(
    { request, url, route: { id: dataRoute ?? url.pathname }, isDataRequest: !!dataRoute },
    {
      appUrl: env.APP_URL,
      honoFetch,
      resolve,
      sessionFor,
      apiFamilies: [{ flag, routes: KIT_SEO_ROUTES }],
    },
  );
  expect(resolve).toHaveBeenCalledTimes(fallback ? 0 : 1);
  expect(honoFetch).toHaveBeenCalledTimes(fallback ? 1 : 0);
  expect(sessionFor).not.toHaveBeenCalled();
  expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(fallback ? null : KIT_RENDERER_VALUE);
  expect(response.status).toBe(baseline.status);
  const actualHeaders = new Headers(response.headers);
  actualHeaders.delete(KIT_RENDERER_HEADER);
  expect([...actualHeaders]).toEqual([...baseline.headers]);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes).toEqual(Buffer.from(await baseline.arrayBuffer()));
  return { response, body: bytes.toString("utf8") };
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
    const acquire = vi.fn<() => Db | undefined>();
    const env = {
      ...baseEnv,
      APP_URL,
      get ADMIN_DB() {
        return acquire();
      },
    };
    const get = await compare(ROBOTS, env);
    expect(get.body).toBe(`User-agent: *\nDisallow:\nSitemap: ${new URL(SITEMAP, APP_URL).href}\n`);
    const head = await compare(ROBOTS, env, { init: { method: "HEAD" } });
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
  const get = await compare(`${SITEMAP}?crawler=1`, env);
  const head = await compare(SITEMAP, env, { init: { method: "HEAD" } });
  expect(head.body).toBe("");
  for (const { response } of [get, head])
    expectPublicResponse(response, "application/xml; charset=UTF-8");
  expect(get.body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  expect(get.body).toContain(`<lastmod>${updated}</lastmod>`);
  const locations = [...get.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  const staticPaths = ["/", "/join", "/events", "/about", "/faq", "/rules", "/privacy"];
  const boundedPaths = Array.from({ length: 997 }, (_, index) => `/e/bounded-${index}`);
  expect(locations).toEqual(
    [...staticPaths, "/e/public&amp;key", ...boundedPaths].map((path) => `${env.APP_URL}${path}`),
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
  const acquire = vi.fn<() => Db | undefined>();
  const env = {
    ...baseEnv,
    get ADMIN_DB() {
      return acquire();
    },
  };
  for (const method of ["GET", "HEAD"]) {
    const { response, body } = await compare(SITEMAP, env, {
      init: { method, headers: { accept: "application/json" } },
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
    for (const flag of ["false", "TRUE"]) {
      const { response } = await compare(path, baseEnv, { flag, fallback: true });
      expect(response.status).toBe(200);
    }
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
      dataRoute: path.endsWith("__data.json") ? ROBOTS : undefined,
      fallback: true,
    });
    expect(result.response.status, path).toBe(status);
  }
  const refusals: RequestInit[] = [
    { headers: { host: "foreign.example.test" } },
    { method: "POST", headers: { origin: baseEnv.APP_URL } },
  ];
  for (const init of refusals) {
    const { response } = await compare(ROBOTS, baseEnv, { init, fallback: true });
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

it("labels detached alerts with the registered route and safe request reference", async () => {
  __resetAlertRateLimitForTests();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const request = new Request(new URL(`${SITEMAP}?private=synthetic`, baseEnv.APP_URL));
    const response = await fetchKitSeo(
      request,
      {
        ...baseEnv,
        get E2E_PUBLIC_READ_BUDGET(): string {
          throw new Error("synthetic driver detail");
        },
      },
      REQUEST_ID,
    );
    expect(response?.status).toBe(500);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = String(errorLog.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "error.alert",
      fingerprint: `Error@${SITEMAP}`,
      route: SITEMAP,
      request_id: REQUEST_ID,
    });
    expect(line).not.toContain("synthetic");
  } finally {
    errorLog.mockRestore();
    __resetAlertRateLimitForTests();
  }
});
