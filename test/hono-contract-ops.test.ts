// In-process Hono characterization, not built-Worker or renderer parity evidence.
// Existing family suites own GET content/readiness and GET validator semantics;
// this suite adds HEAD dispatch and the missing method/path boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { getPublicEvent, listFeed, type PublicEvent } from "../src/events/reads";
import { WEB_MIGRATIONS } from "../src/up";
import { healthSql } from "./helpers/up";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
  listFeed: vi.fn(),
}));

const ORIGIN = "https://ops.example.test";
const KEY = "01J0000000000000000000ABCD";
const REQUEST_ID = "0123456789abcdef-LHR";
const MARKDOWN = "text/markdown; charset=utf-8";
const HTML = "text/html; charset=UTF-8";
const STATIC_CACHE = "public, max-age=3600";
const EVENT: PublicEvent = {
  id: 7,
  icsSequence: 1n,
  syncRevision: 1,
  syncedRevision: 0,
  eventKey: KEY,
  title: "Synthetic board game night",
  description: "Bring a board.",
  game: "Chess",
  startsAt: new Date("2099-01-10T20:00:00Z"),
  endsAt: new Date("2099-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "The lobby",
  capacity: 10,
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
  createdAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2099-01-01T00:00:00Z"),
  goingCount: 3,
  goingOccupancy: 3,
};

// Same fail-local DB boundary as the machine-doc revalidation suite. Only the
// mocked public event reads may use it; there is no connection string or client.
const offlineDb = new Proxy(
  {},
  {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("Unexpected database access in ops fixture");
    },
  },
);
const env: Env = {
  APP_URL: ORIGIN,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "123",
  DISCORD_INVITE_URL: "https://discord.gg/test-invite",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const eventEnv = { ...env, ADMIN_DB: offlineDb } as unknown as Env;
const request = (path: string, method = "GET", bindings = env, headers: HeadersInit = {}) =>
  app.request(
    path,
    {
      method,
      headers: {
        origin: ORIGIN,
        "cf-ray": REQUEST_ID,
        ...Object.fromEntries(new Headers(headers)),
      },
    },
    bindings,
  );
const headersOf = (response: Response) => Object.fromEntries(response.headers);

beforeEach(() => {
  vi.mocked(listFeed)
    .mockReset()
    .mockResolvedValue([{ ...EVENT }]);
  vi.mocked(getPublicEvent)
    .mockReset()
    .mockResolvedValue({ ...EVENT });
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network access in ops fixture");
  });
});
afterEach(() => vi.unstubAllGlobals());

const documents = [
  { path: "/version", mime: "application/json", cache: "no-store" },
  { path: "/robots.txt", mime: "text/plain; charset=UTF-8", cache: STATIC_CACHE },
  { path: "/sitemap_index.xml", mime: "application/xml; charset=UTF-8", cache: STATIC_CACHE },
  { path: "/.well-known/security.txt", mime: "text/plain; charset=utf-8", cache: STATIC_CACHE },
  ...["about", "faq", "rules", "privacy"].map((page) => ({
    path: `/${page}`,
    mime: HTML,
    cache: STATIC_CACHE,
  })),
  ...["llms.txt", "about.md", "faq.md", "rules.md", "privacy.md", "join.md"].map((file) => ({
    path: `/${file}`,
    mime: MARKDOWN,
    cache: STATIC_CACHE,
  })),
  { path: "/events.md", mime: MARKDOWN, cache: "public, max-age=300" },
  { path: `/e/${KEY}.md`, mime: MARKDOWN, cache: "public, max-age=300" },
];
const bindingsFor = (path: string) =>
  path === "/events.md" || path.startsWith("/e/") ? eventEnv : env;
const leaves = [
  ...documents.map(({ path }) => path),
  "/up",
  "/discord",
  "/login",
  "/community",
  "/auth/discord/redirect",
];

async function expectBranded404(response: Response, method: string) {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe(HTML);
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("allow")).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await response.text();
  if (method === "HEAD") expect(body).toBe("");
  else {
    expect(body).toContain("We cannot find that page");
    expect(body).toContain("Together We Own");
  }
}

describe("Hono ops document HEAD dispatch", () => {
  it.each(documents)(
    "HEAD $path preserves GET status and all headers, without a body",
    async (doc) => {
      const get = await request(doc.path, "GET", bindingsFor(doc.path));
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe(doc.mime);
      expect(get.headers.get("cache-control")).toBe(doc.cache);
      expect(get.headers.getSetCookie()).toEqual([]);
      expect(await get.text()).not.toBe("");
      const head = await request(doc.path, "HEAD", bindingsFor(doc.path));
      expect(head.status).toBe(get.status);
      expect(headersOf(head)).toEqual(headersOf(get));
      expect(await head.text()).toBe("");
      if (doc.path === "/events.md") expect(listFeed).toHaveBeenCalledTimes(2);
      if (doc.path.startsWith("/e/")) {
        expect(getPublicEvent).toHaveBeenCalledTimes(2);
        expect(getPublicEvent).toHaveBeenLastCalledWith(expect.anything(), KEY);
      }
    },
  );

  it.each(documents.filter(({ mime }) => mime === MARKDOWN))(
    "conditional HEAD $path keeps the GET 304 validator and security headers",
    async ({ path }) => {
      const initial = await request(path, "GET", bindingsFor(path));
      const etag = initial.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{40}"$/);
      const headers = { "if-none-match": etag! };
      const get = await request(path, "GET", bindingsFor(path), headers);
      const head = await request(path, "HEAD", bindingsFor(path), headers);
      expect(get.status).toBe(304);
      expect(head.status).toBe(304);
      expect(headersOf(head)).toEqual(headersOf(get));
      expect(head.headers.get("etag")).toBe(etag);
      expect(head.headers.get("cache-control")).toBe(initial.headers.get("cache-control"));
      expect(head.headers.get("content-security-policy")).toBe(
        initial.headers.get("content-security-policy"),
      );
      expect(head.headers.get("x-request-id")).toBe(REQUEST_ID);
      expect(head.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await get.text()).toBe("");
      expect(await head.text()).toBe("");
    },
  );

  it.each([
    { name: "healthy", status: 200, options: {} },
    { name: "database down", status: 503, options: { ping: new Error("synthetic outage") } },
    { name: "pending migrations", status: 503, options: { migrations: [] } },
    { name: "queue unknown", status: 200, options: { queue: new Error("synthetic queue fault") } },
  ])("HEAD /up preserves $name GET readiness headers and status", async ({ status, options }) => {
    const bindings = { ...env, QUEUE_DEPTH_STORE: healthSql(options) };
    const get = await request("/up", "GET", bindings);
    expect(get.status).toBe(status);
    expect(get.headers.get("x-two-origin")).toBe("two-web-next");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.json()).toHaveProperty(
      "pending_migrations",
      options.ping ? null : options.migrations ? WEB_MIGRATIONS.length : 0,
    );
    const head = await request("/up", "HEAD", bindings);
    expect(head.status).toBe(status);
    expect(headersOf(head)).toEqual(headersOf(get));
    expect(await head.text()).toBe("");
  });

  it.each([
    { path: "/discord?next=%2Fevents", location: env.DISCORD_INVITE_URL },
    {
      path: "/auth/discord/redirect?next=%2Fevents&state=discard",
      location: "/auth/discord?next=%2Fevents",
    },
  ])("HEAD $path preserves the GET redirect without starting OAuth", async ({ path, location }) => {
    const get = await request(path);
    const head = await request(path, "HEAD");
    expect(get.status).toBe(302);
    expect(get.headers.get("location")).toBe(location);
    expect(get.headers.get("cache-control")).toBe("no-store, private");
    expect(get.headers.getSetCookie()).toEqual([]);
    expect(head.status).toBe(get.status);
    expect(headersOf(head)).toEqual(headersOf(get));
    expect(await head.text()).toBe("");
  });
});

describe("Hono ops method and path boundaries", () => {
  it.each(leaves)(
    "same-origin wrong methods on %s reach the branded 404, not 405",
    async (path) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        await expectBranded404(await request(path, method), method);
      }
      expect(getPublicEvent).not.toHaveBeenCalled();
      expect(listFeed).not.toHaveBeenCalled();
    },
  );

  it.each(leaves)("slash and __data.json variants of %s are not aliases", async (path) => {
    for (const variant of [`${path}/`, `${path}/__data.json`]) {
      for (const method of ["GET", "HEAD"]) {
        await expectBranded404(await request(variant, method), method);
      }
    }
    expect(getPublicEvent).not.toHaveBeenCalled();
    expect(listFeed).not.toHaveBeenCalled();
  });
});

describe("Hono event Markdown path matching", () => {
  it.each([`/e/%30${KEY.slice(1)}.md`, `/e/${KEY}%2Emd`])(
    "%s decodes into the registered Markdown route before the event lookup",
    async (path) => {
      const response = await request(path, "GET", eventEnv);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(MARKDOWN);
      expect(await response.text()).toContain(EVENT.title);
      expect(getPublicEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), KEY);
    },
  );

  it.each(["GET", "HEAD"])(
    "%s lowercase encoded key redirects canonically before reads",
    async (method) => {
      const lower = KEY.toLowerCase();
      const response = await request(`/e/%30${lower.slice(1)}.md?source=fixture&x=%2F`, method);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(`/e/${KEY}.md?source=fixture&x=%2F`);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.text()).toBe("");
      expect(getPublicEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["/e/a/b.md", "/e/a%2Fb.md", "/e/%2530bad.md"])(
    "%s reaches the regex route but rejects the decoded key before reads",
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(MARKDOWN);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(await response.text()).toBe("Not found");
      expect(getPublicEvent).not.toHaveBeenCalled();
    },
  );

  it("a multi-segment path without the Markdown suffix reaches the branded fallback instead", async () => {
    await expectBranded404(await request("/e/a/b"), "GET");
    expect(getPublicEvent).not.toHaveBeenCalled();
  });
});
