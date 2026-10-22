// Test Author owned: build on these fail-first tests without editing them.
// Fixtures only: the real app has no configured DB, even with a signed session.
// Catches the bare-text no-DB branch, lost negotiation/cache/correlation, and
// accidental session/HTTP work while constructing the recovery response.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminDb from "../src/admin/db";
import type { Env } from "../src/env";
import { databaseUnavailable } from "../src/errors";
import { registerCalendarRoutes } from "../src/events/routes-calendar";
import { FALLBACK_INVITE } from "../src/invite";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, MEMBER } from "./helpers/member-data";

const ORIGIN = "https://outage.example.test";
const INVITE = "https://discord.gg/fixture-invite";
const REQUEST_ID = "0123456789abcdef-LHR";
const ENV: Env = {
  APP_URL: ORIGIN,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: INVITE,
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};
const PATHS = ["/events", "/events/past"];
const ACCEPTS = [
  { accept: undefined, type: "text/html" },
  { accept: "*/*", type: "text/html" },
  { accept: "text/html", type: "text/html" },
  { accept: "application/json", type: "application/json" },
  { accept: "text/html;q=1, application/json;q=0.1", type: "text/html" },
  { accept: "text/html;q=0, application/json;q=0.9", type: "application/json" },
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("outage fixtures must remain offline");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MEMBER);
  const get = vi.spyOn(sessions, "get");
  const rotate = vi.spyOn(sessions, "rotate");
  const acquire = vi.spyOn(adminDb, "dbFor"); // Real null result; no connection configuration.
  return { cookie, get, rotate, acquire, bindings: { ...ENV, SESSION_STORE: sessions } };
}

function assertUnavailableHeaders(response: Response, type: string) {
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toContain(type);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(
    response.headers
      .get("vary")
      ?.toLowerCase()
      .split(/\s*,\s*/),
  ).toContain("accept");
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
}

function assertRecoveryDocument(html: string, invite = INVITE) {
  expect(html).toMatch(/<!doctype html>/i);
  expect(html).toContain("Together We Own");
  expect(html).toMatch(/<h1\b[^>]*>[^<]+<\/h1>/);
  expect(html).toContain('name="robots" content="noindex, nofollow"');
  expect(html).toMatch(
    new RegExp(
      `<a[^>]*href="${invite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-testid="error-invite"`,
    ),
  );
  expect(html).toMatch(/<a[^>]*href="\/"[^>]*data-testid="error-retry"/);
  expect(html).toContain(REQUEST_ID);
  expect(html).not.toMatch(/href="\/(?:auth\/discord|join\/discord)/);
  expect(html).not.toContain('data-island="events-calendar"');
  expect(html).not.toContain('data-island="past-events"');
}

// This expectation is literal, not computed by the response helper under test.
const JSON_BODY = {
  error: "db_unavailable",
  message: "The service is temporarily unavailable. Try again shortly.",
  request_id: REQUEST_ID,
};

describe.each(PATHS)("%s no-database document", (path) => {
  it.each(ACCEPTS)("negotiates $type with Accept $accept", async ({ accept, type }) => {
    const f = await fixture();
    const response = await app.request(
      path,
      {
        headers: { cookie: f.cookie, "cf-ray": REQUEST_ID, ...(accept ? { accept } : {}) },
      },
      f.bindings,
    );
    // Count effects before checking the intentionally RED representation.
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.rotate).not.toHaveBeenCalled();
    assertUnavailableHeaders(response, type);
    if (type === "application/json") expect(await response.json()).toEqual(JSON_BODY);
    else assertRecoveryDocument(await response.text());
  });

  it.each(["text/html", "application/json"])(
    "HEAD retains %s metadata without a body",
    async (accept) => {
      const f = await fixture();
      const response = await app.request(
        path,
        {
          method: "HEAD",
          headers: { accept, cookie: f.cookie, "cf-ray": REQUEST_ID },
        },
        f.bindings,
      );
      expect(f.acquire).toHaveBeenCalledTimes(1);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.rotate).not.toHaveBeenCalled();
      expect(await response.text()).toBe("");
      assertUnavailableHeaders(response, accept);
    },
  );

  it("uses the safe invite floor, not hostile configuration or query destinations", async () => {
    const f = await fixture();
    const response = await app.request(
      `${path}?q=PRIVATE_QUERY_MARKER&next=https://evil.example/steal`,
      {
        headers: { accept: "text/html", "cf-ray": REQUEST_ID },
      },
      { ...f.bindings, DISCORD_INVITE_URL: "https://evil.example/steal" },
    );
    const html = await response.text();
    assertRecoveryDocument(html, FALLBACK_INVITE);
    expect(html).not.toMatch(/PRIVATE_QUERY_MARKER|evil\.example/);
  });
});

describe("preservation controls", () => {
  it.each([
    { path: "/events?view=calendar&month=2026-10", island: "events-calendar" },
    { path: "/events/past?page=2", island: "past-events" },
  ])(
    "$island no-DB fragment is still a failure, never an empty success",
    async ({ path, island }) => {
      const f = await fixture();
      const response = await app.request(
        path,
        {
          headers: { accept: "text/html", "x-two-island": island, "cf-ray": REQUEST_ID },
        },
        f.bindings,
      );
      expect(response.status).toBe(503);
      expect(response.ok).toBe(false);
      expect(response.headers.get("location")).toBeNull();
      expect(f.acquire).toHaveBeenCalledTimes(1);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.rotate).not.toHaveBeenCalled();
      // The shipped binders refuse !ok before reading or swapping any body.
      // Neighbor binder suites exercise last-good DOM/history preservation.
    },
  );

  it.each(["text/html", "application/json"])(
    "existing shared %s envelope merges Vary and stays correlated",
    async (accept) => {
      const control = new Hono<{ Bindings: Env }>();
      control.use("*", requestLog);
      control.use("*", async (c, next) => {
        c.header("vary", "Cookie, X-Two-Island");
        await next();
      });
      control.get("/control", (c) => databaseUnavailable(c));
      const response = await control.request(
        `${ORIGIN}/control`,
        {
          headers: { accept, "cf-ray": REQUEST_ID },
        },
        ENV,
      );
      assertUnavailableHeaders(response, accept);
      const vary = response.headers
        .get("vary")
        ?.toLowerCase()
        .split(/\s*,\s*/);
      expect(vary).toContain("cookie");
      expect(vary).toContain("x-two-island");
      if (accept === "application/json") expect(await response.json()).toEqual(JSON_BODY);
      else assertRecoveryDocument(await response.text());
    },
  );

  it("existing calendar session failure uses the shared envelope without a second read", async () => {
    vi.spyOn(adminDb, "dbFor").mockResolvedValue({} as never);
    const readSession = vi.fn(async () => {
      throw new Error("private fixture failure");
    });
    const readFragment = vi.fn(async () => null);
    const routes = new Hono<{ Bindings: Env }>();
    routes.use("*", requestLog);
    registerCalendarRoutes(routes, readSession, readFragment);
    const response = await routes.request(
      `${ORIGIN}/events`,
      {
        headers: { accept: "application/json", "cf-ray": REQUEST_ID },
      },
      ENV,
    );
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(readFragment).not.toHaveBeenCalled();
    assertUnavailableHeaders(response, "application/json");
    expect(await response.json()).toEqual(JSON_BODY);
  });
});

// An HTTP 503 may contain a full branded error document. Execute the shipped
// minified controllers and prove neither consumes that body nor commits it.
describe.each([
  { island: "events-calendar", path: "/events", next: "/events?view=calendar&month=2026-10" },
  { island: "past-events", path: "/events/past", next: "/events/past?page=2" },
])("$island shipped controller preservation", ({ island, path, next }) => {
  it("keeps last-good zones/history/metadata and exposes feedback on a branded HTTP 503", async () => {
    const control = new Hono<{ Bindings: Env }>();
    control.get("/503", (c) => databaseUnavailable(c));
    const response = await control.request(
      `${ORIGIN}/503`,
      { headers: { accept: "text/html" } },
      ENV,
    );
    expect(response.status).toBe(503);
    const body = vi.fn(() => response.text());
    const localFetch = vi.fn(async () => ({
      ok: response.ok,
      status: response.status,
      text: body,
    }));
    const parse = vi.fn(() => ({ querySelector: () => null }));
    const form = { addEventListener: vi.fn() };
    function node() {
      return {
        hidden: false,
        childNodes: ["last-good"],
        textContent: "",
        value: "",
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        replaceChildren: vi.fn(),
        addEventListener: vi.fn(),
        closest: () => form,
      };
    }
    const zones = [node(), node(), node(), node()];
    const feedback = node();
    const skeleton = { ...node(), hidden: true };
    const input = node();
    const live = node();
    const listeners = new Map<string, (event: unknown) => void>();
    const root = {
      dataset: { loadError: "Read failed; your last view is unchanged.", view: "list", page: "1" },
      contains: () => true,
      querySelectorAll: () => zones,
      querySelector: (selector: string) => {
        if (selector === "[data-cal-feedback]" || selector === "[data-archive-feedback]")
          return feedback;
        if (selector === '[data-testid="events-loading"]') return skeleton;
        if (selector === '[data-testid="events-search"]') return input;
        if (selector === '[data-cal-zone="content"]') return zones[3];
        if (selector === "[data-archive-state]") return zones[0];
        if (selector === "[data-archive-list]") return zones[1];
        if (selector === "[data-archive-pager]") return zones[2];
        return live;
      },
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        listeners.set(name, handler),
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const canonical = { href: ORIGIN + path };
    const og = { content: ORIGIN + path };
    const pushState = vi.fn();
    const assign = vi.fn();
    runInNewContext(readFileSync(`public/islands/${island}.js`, "utf8"), {
      URL,
      AbortController,
      document: {
        querySelector: (selector: string) =>
          selector.includes("data-island") ? root : selector.startsWith("link") ? canonical : og,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      window: {
        location: { href: ORIGIN + path, origin: ORIGIN, assign },
        history: { pushState },
        addEventListener: () => {},
      },
      fetch: localFetch,
      DOMParser: class {
        parseFromString = parse;
      },
    });
    const preventDefault = vi.fn();
    const link = { href: ORIGIN + next, target: "", hasAttribute: () => false };
    expect(listeners.has("click")).toBe(true);
    listeners.get("click")!({
      button: 0,
      detail: 1,
      target: { closest: () => link },
      preventDefault,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(localFetch.mock.calls[0]).toEqual([next, expect.objectContaining({ method: "GET" })]);
    expect(body).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    for (const zone of zones) {
      expect(zone.childNodes).toEqual(["last-good"]);
      expect(zone.replaceChildren).not.toHaveBeenCalled();
    }
    expect(zones[3]!.hidden).toBe(false);
    expect(skeleton.hidden).toBe(true);
    expect(feedback.textContent).toBe("Read failed; your last view is unchanged.");
    expect(root.removeAttribute).toHaveBeenCalledWith("aria-busy");
    expect(pushState).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(canonical.href).toBe(ORIGIN + path);
    expect(og.content).toBe(ORIGIN + path);
    expect(root.dataset).toEqual({
      loadError: "Read failed; your last view is unchanged.",
      view: "list",
      page: "1",
    });
  });
});
