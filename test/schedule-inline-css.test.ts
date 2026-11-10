import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminDb from "../src/admin/db";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { __resetAnonEventCacheForTests, retireAnonEventCaches } from "../src/events/anon-cache";
import { EVENTS_INLINE_CSS_MARKER, markEventsInlineCssResponse } from "../src/events/inline-css";
import * as models from "../src/events/page-models.server";
import { registerCalendarRoutes } from "../src/events/routes-calendar";
import * as shared from "../src/events/routes-shared";
import { EventsSearchTooLongPage } from "../src/events/pages";
import {
  isContentLeafPath,
  isInlineCriticalCssPath,
  leafInlineStyleCsp,
  securityHeadersFor,
} from "../src/headers";
import { dispatchEventsRequest } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  LEAF_CRITICAL_CSS,
  LEAF_CRITICAL_CSS_SHA256,
  SCHEDULE_CRITICAL_CSS,
  SCHEDULE_CRITICAL_CSS_SHA256,
} from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import * as journey from "../src/return-journey";
import { dispatchHookRequest } from "../src/route-ownership";

const env = {
  APP_URL: "https://example.test",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "fixture-session-secret-longer-than-32-bytes",
} as Env;
const db = {} as Db;
const exactBlocks = `<style>${LEAF_CRITICAL_CSS}</style><style>${SCHEDULE_CRITICAL_CSS}</style>`;
const hash = (css: string) => createHash("sha256").update(css, "utf8").digest("base64");
const cspFor = (classified = false, path = "/events", method = "GET") =>
  new Map(securityHeadersFor({ path, method }, undefined, { inlineScheduleCss: classified })).get(
    "Content-Security-Policy",
  )!;
const baseModel = (): models.CalendarPageModel => ({
  state: { view: "list", month: "2026-10", q: "", game: "", past: false, page: 1 },
  upcoming: [],
  past: [],
  zone: "UTC",
  totalPages: 1,
  emptyState: "never",
  discordFailed: false,
  games: [],
  gameFilter: null,
});
let router: Hono<{ Bindings: Env }>;
let session: Session | null;
let failAfterRender: boolean;

beforeEach(() => {
  session = null;
  failAfterRender = false;
  __resetAnonEventCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("schedule tests must remain offline");
    }),
  );
  vi.spyOn(adminDb, "dbFor").mockResolvedValue(db);
  vi.spyOn(shared, "publicReadGuard").mockResolvedValue(null);
  vi.spyOn(models, "loadCalendarPageModel").mockResolvedValue(baseModel());
  vi.spyOn(journey, "readJoinResult").mockResolvedValue(null);
  vi.spyOn(journey, "takeJoinResult").mockResolvedValue(null);
  router = new Hono<{ Bindings: Env }>();
  router.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", cspFor(false, c.req.path, c.req.method));
    leafInlineStyleCsp(c);
  });
  router.use("*", async (_c, next) => {
    await next();
    if (failAfterRender) throw new Error("failed after an eligible render");
  });
  router.onError((_err, c) => c.html("<h1>Unavailable</h1>", 503));
  registerCalendarRoutes(
    router,
    async () => session,
    async () => session,
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAnonEventCacheForTests();
});

function request(path = "/events", init: RequestInit = {}) {
  return router.request(`${env.APP_URL}${path}`, init, env);
}
function assertPolicy(response: Response, classified: boolean) {
  expect(response.headers.get("Content-Security-Policy")).toBe(cspFor(classified));
  expect(response.headers.has(EVENTS_INLINE_CSS_MARKER)).toBe(false);
}
async function kitResponse() {
  const rendered = await renderEventsHtml(
    { queryTooLong: true, appUrl: env.APP_URL },
    { "x-two-events-too-long": "true" },
  );
  return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
}
async function decorate(response: Response, path = "/events", method = "GET", headers = {}) {
  const req = new Request(`${env.APP_URL}${path}`, { method, headers });
  return dispatchHookRequest(
    { request: req, url: new URL(req.url), route: { id: path } },
    {
      appUrl: env.APP_URL,
      manifest: [{ method: "GET", path, enabled: true, reads: "public" }],
      honoFetch: async () => {
        throw new Error("unexpected Hono fallback");
      },
      resolve: async () => response,
    },
  );
}

describe("fixed upcoming L then S representation", () => {
  it("matches raw buffers and changes only the four stylesheet elements", () => {
    const source = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url));
    const l = Buffer.concat([
      source("styles.css"),
      Buffer.from("\n"),
      source("theme-tokens.css"),
      Buffer.from("\n"),
      source("theme.css"),
    ]);
    expect(Buffer.from(LEAF_CRITICAL_CSS).equals(l)).toBe(true);
    expect(Buffer.from(SCHEDULE_CRITICAL_CSS).equals(source("schedule-theme.css"))).toBe(true);
    expect(LEAF_CRITICAL_CSS_SHA256).toBe(hash(LEAF_CRITICAL_CSS));
    expect(SCHEDULE_CRITICAL_CSS_SHA256).toBe(hash(SCHEDULE_CRITICAL_CSS));
    const externalRaw = Layout({
      title: "Fixture",
      theme: "schedule",
      children: "unchanged",
    })!.toString();
    const inlineRaw = Layout({
      title: "Fixture",
      theme: "schedule",
      inlineScheduleCss: true,
      children: "unchanged",
    })!.toString();
    if (typeof externalRaw !== "string" || typeof inlineRaw !== "string") {
      throw new Error("Layout render must be synchronous for exact byte comparison");
    }
    const external = externalRaw;
    const inline = inlineRaw;
    const links = ["styles", "theme-tokens", "theme", "schedule-theme"]
      .map((name) => `<link rel="stylesheet" href="/${name}.css"/>`)
      .join("");
    expect(external).toContain(links);
    expect(inline).toBe(external.replace(links, exactBlocks));
    expect(inline.indexOf("/fonts/display-latin-700.woff2")).toBeLessThan(
      inline.indexOf(exactBlocks),
    );
    expect(inline).not.toContain('rel="stylesheet"');
    expect(Buffer.byteLength(inline) - Buffer.byteLength(external)).toBe(25000);
    expect(isContentLeafPath("/events")).toBe(false);
    expect(isInlineCriticalCssPath("/events")).toBe(false);
  });

  it("keeps the shared too-long screen external by default and always for archive", () => {
    for (const props of [{}, { archive: true }, { archive: true, inlineScheduleCss: true }]) {
      const body = EventsSearchTooLongPage({ appUrl: env.APP_URL, ...props })!.toString();
      expect(body).not.toContain("<style>");
      expect(body).toContain('href="/schedule-theme.css"');
    }
  });

  it.each([
    "/events",
    "/events?view=calendar",
    "/events?q=chess&game=Chess",
    "/events?past=1&page=2",
    `/events?q=${"q".repeat(300)}`,
  ])("emits exact styles and matching policy on %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(path.includes(`q=${"q".repeat(300)}`) ? 422 : 200);
    expect(await response.text()).toContain(exactBlocks);
    assertPolicy(response, true);
  });

  it.each(["never", "gap", null] as const)("retains styles for empty state %s", async (state) => {
    vi.mocked(models.loadCalendarPageModel).mockResolvedValue({
      ...baseModel(),
      emptyState: state,
    });
    const response = await request();
    expect(await response.text()).toContain(exactBlocks);
    assertPolicy(response, true);
  });

  it("retains the partial Discord-read failure document", async () => {
    vi.mocked(models.loadCalendarPageModel).mockResolvedValue({
      ...baseModel(),
      discordFailed: true,
    });
    const response = await request();
    expect(await response.text()).toContain(exactBlocks);
    assertPolicy(response, true);
  });

  it("retains classification on anonymous hits and HEAD, then retires the entry", async () => {
    const first = await request();
    const body = await first.text();
    assertPolicy(first, true);
    const hit = await request();
    expect(await hit.text()).toBe(body);
    assertPolicy(hit, true);
    expect(models.loadCalendarPageModel).toHaveBeenCalledOnce();
    retireAnonEventCaches();
    assertPolicy(await request(), true);
    expect(models.loadCalendarPageModel).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const head = await request("/events", { method: "HEAD" });
      assertPolicy(head, true);
      expect(await head.text()).toBe("");
    }
  });

  it.each([false, true])(
    "keeps signed-in member=%s private and out of the shared cache",
    async (member) => {
      await request();
      session = { username: "Fixture viewer", member, moderator: false } as Session;
      for (let i = 0; i < 2; i++) {
        const response = await request("/events", { headers: { cookie: "session=fixture" } });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        assertPolicy(response, true);
      }
      expect(models.loadCalendarPageModel).toHaveBeenCalledTimes(3);
    },
  );

  it("does not cache the one-shot flash or consume it on an island swap", async () => {
    vi.mocked(journey.readJoinResult).mockResolvedValue("added");
    vi.mocked(journey.takeJoinResult).mockResolvedValueOnce("added");
    const flashed = await request();
    expect(flashed.headers.get("cache-control")).toBe("private, no-store");
    expect(await flashed.text()).toContain('data-testid="join-result"');
    assertPolicy(flashed, true);
    vi.mocked(journey.takeJoinResult).mockClear();
    const fragment = await request("/events", { headers: { "x-two-island": "events-calendar" } });
    expect(await fragment.text()).toContain(exactBlocks);
    assertPolicy(fragment, true);
    expect(journey.takeJoinResult).not.toHaveBeenCalled();
    expect(models.loadCalendarPageModel).toHaveBeenCalledTimes(2);
  });

  it("does not grant hashes to a database error despite forged request hints", async () => {
    vi.mocked(adminDb.dbFor).mockResolvedValue(null);
    const response = await request("/events?inlineScheduleCss=true", {
      headers: { [EVENTS_INLINE_CSS_MARKER]: "true", "x-two-island": "events-calendar" },
    });
    expect(response.status).toBe(503);
    assertPolicy(response, false);
  });

  it("keeps an archive too-long response on its external stylesheets", async () => {
    const response = await request(`/events/past?q=${"q".repeat(300)}`);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('href="/schedule-theme.css"');
    expect(response.headers.get("content-security-policy")).toBe(cspFor(false));
  });

  it("clears the policy when an eligible handler renders and then fails", async () => {
    failAfterRender = true;
    const response = await request();
    expect(response.status).toBe(503);
    assertPolicy(response, false);
    expect(await response.text()).not.toContain(exactBlocks);
  });
});

describe("Kit tuple and response decoration", () => {
  it("matches Hono for the actual too-long render and a bodyless HEAD", async () => {
    const req = new Request(`${env.APP_URL}/events?q=${"q".repeat(300)}`);
    const response = await dispatchEventsRequest(req, env, () => kitResponse());
    expect(response.status).toBe(422);
    expect(await response.clone().text()).toContain(exactBlocks);
    assertPolicy(await decorate(response), true);
    const headSource = await kitResponse();
    const head = await decorate(
      new Response(null, { headers: headSource.headers }),
      "/events",
      "HEAD",
    );
    assertPolicy(head, true);
    expect(await head.text()).toBe("");
  });

  it("retains server-owned classification across the actual Kit cache wrapper", async () => {
    const model = {
      ...baseModel(),
      now: new Date("2026-10-13T12:00:00Z"),
      member: false,
      moderator: false,
      session: null,
      inviteUrl: env.DISCORD_INVITE_URL,
      appUrl: env.APP_URL,
      canonical: `${env.APP_URL}/events`,
      loginReturnTo: "/events",
      joinResult: null,
      queryTooLong: false as const,
    };
    const resolve = vi.fn(async () => {
      const rendered = await renderEventsHtml(model, {
        "x-two-events-cacheable": "true",
        "cache-control": "public, max-age=60",
      });
      return new Response(rendered.body, { headers: rendered.headers });
    });
    for (const now of [1000, 2000]) {
      const response = await dispatchEventsRequest(
        new Request(`${env.APP_URL}/events`),
        env,
        resolve,
        { guard: async () => null, now },
      );
      const decorated = await decorate(response);
      expect(await decorated.text()).toContain(exactBlocks);
      assertPolicy(decorated, true);
    }
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each([
    "/events/past",
    "/eventsx",
    "/events/anything",
    "/events/",
    "/e/fixture",
    "/unavailable",
  ])("does not widen %s even with a classified response", async (path) => {
    const response = await decorate(await kitResponse(), path);
    expect(response.headers.get("content-security-policy")).toBe(cspFor(false, path));
    expect(response.headers.has(EVENTS_INLINE_CSS_MARKER)).toBe(false);
  });

  it.each([
    { status: 503, type: "text/html" },
    { status: 302, type: "text/html" },
    { status: 200, type: "application/json" },
    { status: 200, type: "text/plain" },
  ])("refuses classification for $status $type", async ({ status, type }) => {
    const replacement = new Response("replacement", {
      status,
      headers: { "content-type": type },
    });
    assertPolicy(await decorate(markEventsInlineCssResponse(replacement)), false);
  });

  it("does not classify an HTML error from request-shaped marker or island headers", async () => {
    const response = await decorate(
      new Response("<h1>error</h1>", { headers: { "content-type": "text/html" } }),
      "/events",
      "GET",
      { [EVENTS_INLINE_CSS_MARKER]: "true", "x-two-island": "events-calendar" },
    );
    assertPolicy(response, false);
    expect(cspFor(true, "/events", "POST")).toBe(cspFor(false));
  });
});
