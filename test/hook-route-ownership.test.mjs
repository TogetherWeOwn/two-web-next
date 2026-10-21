import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The hook wiring test targets the framework-free dispatch core in
// src/route-ownership.ts, not web/src/hooks.server.ts: the root Vitest suite
// cannot transform that file (web/tsconfig.json extends the
// SvelteKit-generated $app/tsconfig, so the vite:oxc transform fails under
// coverage). dispatchHookRequest imports the trust check and the owner
// decision itself; web/src/hooks.server.ts passes only env, honoFetch,
// resolve and the archive binding (plus no owner logic), so these cases pin
// the shipped ordering plus
// the production Kit decoration exactly, and the wiring case pins that the
// hook carries no swappable owner seam.
vi.mock("cloudflare:workers", () => ({
  env: { APP_URL: "https://example.com", FEATURED_IMAGE_HOSTS: "" },
  waitUntil: vi.fn(),
}));

import {
  HONO_FALLBACK_ROUTE_ID,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  dispatchHookRequest,
} from "../src/route-ownership";

const APP_URL = "https://example.com";
// Explicit Kit-owned view of the archive page for tests: the shipped manifest
// now assigns it to Kit, but these cases pass an override so they pin the
// dispatch behavior without depending on the shipped default. Production
// wiring never passes a manifest and always uses the shipped default.
const KIT_MANIFEST = [{ method: "GET", path: "/events/past", enabled: true, reads: "public" }];

function eventFor(appUrl, path, host) {
  const request = new Request(new URL(path, appUrl).href, {
    headers: { host },
  });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
}

function trustedEvent(path, host = "example.com") {
  return eventFor(APP_URL, path, host);
}

function deps(overrides = {}) {
  return {
    appUrl: APP_URL,
    featuredImageHosts: "",
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    ...overrides,
  };
}

function kitHtmlResponse() {
  return new Response("<html>kit page</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("hooks.server route ownership wiring", () => {
  it("ships the native archive, events list, about/faq leaves and join-attempts pair enabled with the homepage, privacy, rules, join, recover, remaining admin and profile reads still on Hono", () => {
    expect(ROUTE_MANIFEST).toEqual([
      { method: "GET", path: "/", enabled: false, reads: "public" },
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "GET", path: "/events", enabled: true, reads: "public" },
      { method: "GET", path: "/about", enabled: true, reads: "public" },
      { method: "GET", path: "/privacy", enabled: false, reads: "public" },
      { method: "GET", path: "/rules", enabled: false, reads: "public" },
      { method: "GET", path: "/faq", enabled: true, reads: "public" },
      { method: "GET", path: "/join", enabled: false, reads: "public" },
      {
        method: "GET",
        path: "/admin",
        enabled: false,
        reads: { resource: "dashboard", action: "view", route: "admin.dashboard" },
      },
      {
        method: "GET",
        path: "/admin/featured",
        enabled: false,
        reads: { resource: "featured_contents", action: "list", route: "admin.featured.index" },
      },
      {
        method: "GET",
        path: "/admin/featured/new",
        enabled: false,
        reads: { resource: "featured_contents", action: "view", route: "admin.featured.create" },
      },
      {
        method: "GET",
        path: "/admin/featured/:id",
        enabled: false,
        reads: { resource: "featured_contents", action: "view", route: "admin.featured.edit" },
      },
      {
        method: "GET",
        path: "/admin/activity-log",
        enabled: false,
        reads: { resource: "activity_log", action: "list", route: "admin.activity-log.index" },
      },
      {
        method: "GET",
        path: "/admin/events",
        enabled: false,
        reads: { resource: "events", action: "list", route: "admin.events.index" },
      },
      {
        method: "GET",
        path: "/admin/events/new",
        enabled: false,
        reads: { resource: "events", action: "view", route: "admin.events.create" },
      },
      { method: "GET", path: "/admin/events/create", enabled: false },
      {
        method: "GET",
        path: "/admin/events/:key",
        enabled: false,
        reads: { resource: "events", action: "view", route: "admin.events.edit" },
      },
      {
        method: "GET",
        path: "/admin/join-attempts",
        enabled: true,
        reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
      },
      {
        method: "GET",
        path: "/admin/join-attempts/:id",
        enabled: true,
        reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" },
      },
      { method: "GET", path: "/auth/recover", enabled: false, reads: "public" },
      {
        method: "GET",
        path: "/profile",
        enabled: false,
        reads: { resource: "profile", action: "view", route: "profile" },
      },
      {
        method: "GET",
        path: "/members/:user",
        enabled: false,
        reads: { resource: "profile", action: "view", route: "profiles.show" },
      },
      { method: "GET", path: "/hotzones", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/joins", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/voice", enabled: true, reads: "public" },
      { method: "GET", path: "/hotzones/games", enabled: true, reads: "public" },
      {
        method: "GET",
        path: "/leaderboards/members",
        enabled: true,
        reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" },
      },
      {
        method: "GET",
        path: "/e/:key",
        enabled: false,
        reads: { resource: "member", action: "list", route: "events.page" },
      },
    ]);
  });

  it("pins HONO_FALLBACK_ROUTE_ID to the real catch-all route directory", () => {
    expect(HONO_FALLBACK_ROUTE_ID).toBe("/[...path]");
    const serverUrl = new URL("../web/src/routes/[...path]/+server.ts", import.meta.url);
    expect(existsSync(serverUrl)).toBe(true);
  });

  it("returns honoFetch before resolve for a Hono-owned path, undecorated", async () => {
    // The archive is Kit-owned now, so the Hono-owned half of this pin uses
    // the still-disabled privacy route.
    const request = new Request(new URL("/privacy", APP_URL).href, {
      headers: { host: "example.com" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/privacy" } };
    const d = deps();

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("forwards the original POST Request untouched with body unread at hand-off", async () => {
    const body = JSON.stringify({ title: "Seed swap" });
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: {
        host: "example.com",
        cookie: "session=abc",
        "content-type": "application/json",
      },
      body,
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    let usedAtHandoff = null;
    const d = deps({
      honoFetch: vi.fn(async (req) => {
        usedAtHandoff = req.bodyUsed;
        expect(req.method).toBe("POST");
        expect(req.headers.get("cookie")).toBe("session=abc");
        expect(await req.json()).toMatchObject({ title: "Seed swap" });
        return new Response("hono-post", { status: 200 });
      }),
    });
    expect(request.bodyUsed).toBe(false);

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    // Awaiting text()/json() before forwarding would mark the body used here.
    expect(usedAtHandoff).toBe(false);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono-post");
  });

  it("routes a POST on a Kit-enabled GET path to Hono, body unread", async () => {
    // Kills the hard-coded-GET mutant: the method must come from the Request.
    const body = JSON.stringify({ title: "Seed swap" });
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "POST",
      headers: { host: "example.com", "content-type": "application/json" },
      body,
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    let usedAtHandoff = null;
    const d = deps({
      manifest: KIT_MANIFEST,
      honoFetch: vi.fn(async (req) => {
        usedAtHandoff = req.bodyUsed;
        return new Response("hono-post", { status: 200 });
      }),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(usedAtHandoff).toBe(false);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono-post");
  });

  it("routes a path outside the manifest to Hono even when another path is Kit-enabled", async () => {
    // Kills the hard-coded-path mutant: /nope must not follow /events/past.
    const event = trustedEvent("/nope");
    const d = deps({ manifest: KIT_MANIFEST });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });

  it("routes HEAD on a Kit-enabled GET path to Kit", async () => {
    const request = new Request(new URL("/events/past", APP_URL).href, {
      method: "HEAD",
      headers: { host: "example.com" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response(null, { status: 200 })),
    });

    await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
  });

  it("decodes an encoded path before the dispatch decision", async () => {
    // %70 is "p": /%70rivacy decodes to /privacy, which the shipped manifest
    // keeps on Hono; /events/%70ast decodes to the Kit-owned archive, which
    // KIT_MANIFEST also moves to Kit.
    const shipped = trustedEvent("/%70rivacy");
    shipped.route = { id: "/privacy" };
    const dShipped = deps();
    const shippedResponse = await dispatchHookRequest(shipped, dShipped);
    expect(dShipped.honoFetch).toHaveBeenCalledOnce();
    expect(dShipped.resolve).not.toHaveBeenCalled();
    expect(await shippedResponse.text()).toBe("hono");

    const kit = trustedEvent("/events/%70ast");
    const dKit = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    });
    const kitResponse = await dispatchHookRequest(kit, dKit);
    expect(dKit.resolve).toHaveBeenCalledOnce();
    expect(dKit.honoFetch).not.toHaveBeenCalled();
    expect(await kitResponse.text()).toBe("kit");
  });

  it("keeps the query string on a Kit-owned dispatch without changing the owner", async () => {
    // Kills the path+search mutant: the query must not enter the decision.
    const event = trustedEvent("/events/past?page=2");
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(event.request.url).toContain("?page=2");
    expect(await response.text()).toBe("kit");
  });

  it("passes the zero-stylesheet transform on Kit-owned content leaves only", async () => {
    // Kills two mutants: dropping the transform (or gating it on the URL
    // instead of the manifest path) serves the layout stylesheet on /about
    // while every unit pin stays green; passing it for every route reshapes
    // non-content pages the leaf contract does not own.
    const manifest = [
      { method: "GET", path: "/about", enabled: true, reads: "public" },
      { method: "GET", path: "/", enabled: true, reads: "public" },
    ];
    const layoutHtml =
      '<html><head><link href="/_app/immutable/assets/0.x.css" rel="stylesheet">' +
      "<style>a{}</style></head><body><p>hi</p></body></html>";
    const leafEvent = (path) => {
      const request = new Request(new URL(path, APP_URL).href, {
        headers: { host: "example.com" },
      });
      return { request, url: new URL(request.url), route: { id: path } };
    };
    const d = deps({
      manifest,
      resolve: vi.fn(
        async () =>
          new Response(layoutHtml, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    });

    const leafResponse = await dispatchHookRequest(leafEvent("/about"), d);
    expect(d.resolve).toHaveBeenCalledOnce();
    const leafOpts = d.resolve.mock.calls[0][1];
    expect(typeof leafOpts?.transformPageChunk).toBe("function");
    // The forwarded transform is the production strip, proved on the
    // fixture: stylesheet gone, Hono body class on, leaf style intact.
    const shaped = leafOpts.transformPageChunk({ html: layoutHtml });
    expect(shaped).not.toContain('rel="stylesheet"');
    expect(shaped).toContain('<body class="base-theme content-theme">');
    expect(shaped).toContain("<style>a{}</style>");
    expect(leafResponse.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);

    d.resolve.mockClear();
    await dispatchHookRequest(leafEvent("/"), d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.resolve.mock.calls[0][1]).toBeUndefined();
  });

  it("answers an untrusted URL host via Hono with the body unread, even with a trusted Host header", async () => {
    // Pins the event.url.host half of the trust guard: the manifest below
    // makes POST Kit-owned, so dropping event.url.host from the check would
    // send this request to resolve instead of Hono.
    const KIT_POST_MANIFEST = [
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "POST", path: "/events/past", enabled: true, reads: "public" },
    ];
    const body = JSON.stringify({ title: "Seed swap" });
    const request = new Request("https://evil.example/events/past", {
      method: "POST",
      headers: {
        host: "example.com",
        cookie: "session=abc",
        "content-type": "application/json",
      },
      body,
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    let usedAtHandoff = null;
    const d = deps({
      manifest: KIT_POST_MANIFEST,
      honoFetch: vi.fn(async (req) => {
        usedAtHandoff = req.bodyUsed;
        expect(req.method).toBe("POST");
        expect(req.headers.get("cookie")).toBe("session=abc");
        expect(await req.json()).toMatchObject({ title: "Seed swap" });
        return new Response("hono-untrusted", { status: 200 });
      }),
    });
    expect(request.bodyUsed).toBe(false);

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(usedAtHandoff).toBe(false);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono-untrusted");
  });

  it("answers an untrusted URL host via Hono even for a Kit-owned GET", async () => {
    // GET variant of the URL-host pin: no body involved, purely the trust
    // guard. Header-only checking would resolve this in Kit.
    const request = new Request("https://evil.example/events/past", {
      headers: { host: "example.com" },
    });
    const event = { request, url: new URL(request.url), route: { id: "/events/past" } };
    const d = deps({ manifest: KIT_MANIFEST });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });

  it("decorates a Kit-owned HTML page: marker, security headers, charset, robots tag", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    // Kit sends a bare text/html; the core names the charset like Hono.
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    // example.com is not the production apex, so staging noindex applies.
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("flows featured image hosts into the Kit CSP", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      manifest: KIT_MANIFEST,
      featuredImageHosts: "images.example.com",
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("Content-Security-Policy")).toContain("https://images.example.com");
  });

  it("marks a Kit-owned non-HTML response without charset or robots fixes", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("omits the robots tag for the production apex serving itself", async () => {
    const apex = "https://togetherweown.com";
    const event = eventFor(apex, "/events/past", "togetherweown.com");
    const d = deps({
      appUrl: apex,
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("propagates a resolve failure without replaying through Hono", async () => {
    const event = trustedEvent("/events/past");
    const failure = new Error("kit resolve blew up");
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(dispatchHookRequest(event, d)).rejects.toThrow(failure);
    expect(d.honoFetch).not.toHaveBeenCalled();
  });

  it("answers untrusted hosts via Hono before the ownership decision", async () => {
    // Even a Kit-enabled manifest must not matter: the trust guard runs first.
    const event = trustedEvent("/events/past", "evil.example");
    const d = deps({ manifest: KIT_MANIFEST });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch.mock.calls[0][0]).toBe(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });

  it("returns the catch-all fallback without marker, headers, or charset fix", async () => {
    const event = trustedEvent("/events/past");
    event.route = { id: HONO_FALLBACK_ROUTE_ID };
    const d = deps({
      manifest: KIT_MANIFEST,
      resolve: vi.fn(async () => kitHtmlResponse()),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("X-Content-Type-Options")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(await response.text()).toBe("<html>kit page</html>");
  });

  it("wires hooks.server.ts as a pure env binding with no owner seam", async () => {
    const source = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
    // Delegates to the core with env, fetch, resolve and the archive binding.
    expect(source).toContain("dispatchHookRequest");
    expect(source).toContain("dispatchPastArchiveRequest");
    // Whole binding: deleting the pastArchive line must fail. The looser
    // pins above stay green without it (the import carries
    // dispatchPastArchiveRequest and the comment carries pastArchive).
    expect(source).toContain(
      "pastArchive: (request, render, requestId) =>\n      dispatchPastArchiveRequest(request, env, render, undefined, undefined, requestId)",
    );
    // Whole binding: deleting the eventDetail line silently drops the detail
    // read throttle (the dispatch treats it as optional), so the exact line
    // must fail. The import and comments alone carry the name.
    expect(source).toContain(
      "eventDetail: (request, render, requestId) =>\n      dispatchEventDetailRequest(request, env, render, undefined, requestId)",
    );
    // Whole binding: deleting the hotzones line silently drops the hot-zone
    // read throttle (the dispatch treats it as optional), so the exact line
    // must fail. The import and comments alone carry the name.
    expect(source).toContain(
      "hotzones: (request, render, requestId) =>\n      dispatchHotzonesRequest(request, env, render, undefined, requestId)",
    );
    // Whole binding: the member board's post-release view log lives on this
    // closure. Making it a no-op or passing a fixed status instead of
    // response.status silently drops every Kit board view, so the exact call
    // must fail (mirrors the pastArchive/eventDetail pins above).
    expect(source).toContain(
      "recordQueuedBoardView(event.locals, response.status, recordBoardView)",
    );
    expect(source).toContain('fixtureMemberBoard: env.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true"');
    expect(source).toContain('fixtureEventDetail: env.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true"');
    // Same pin on the other half of the wiring: the members load binding
    // hands the queue to locals. Deleting that line queues nothing, so the
    // hook above records nothing and every Kit board view is dropped.
    const membersLoad = readFileSync(
      new URL("../web/src/routes/leaderboards/members/+page.server.ts", import.meta.url),
      "utf8",
    );
    expect(membersLoad).toContain(
      "queueBoardViewFn: (db, entry) => queueMembersBoardView(locals, db, entry)",
    );
    // The list binding carries the same shape plus its read-only session and
    // flash peeks: deleting any of these lines must fail, and the hook still
    // carries no session logic of its own (readers live in kit-session.ts).
    expect(source).toContain("dispatchEventsRequest");
    expect(source).toContain("eventsPage: (request, render, requestId) =>");
    expect(source).toContain("kitEventsSessionFor(env)");
    expect(source).toContain("kitEventsJourneyFor(env)");
    expect(source).toContain("journeyFor: kitEventsJourneyFor(env),\n        requestId,");
    expect(source).toContain("honoFetch,");
    // The content-leaf zero-stylesheet strip travels as a resolve option:
    // the hook must forward it untouched. Dropping the second argument
    // serves the layout stylesheet on /about and /faq while every dispatch
    // pin stays green (the core passes the option; only the hook can lose
    // it on the way to Kit's resolve).
    expect(source).toContain("opts as Parameters<typeof resolve>[1]");
    expect(source).toContain("featuredImageHosts: env.FEATURED_IMAGE_HOSTS");
    expect(source).toContain("appUrl: env.APP_URL");
    // Whole binding: swapping these two staging rollout lines (or deleting
    // either) keeps every dispatch pin green — the rollout tests construct
    // HookDispatchDeps directly — while silently disabling the archive stage
    // on staging (static requires archive). The exact lines must fail.
    expect(source).toContain("kitRouteArchive: env.KIT_ROUTE_ARCHIVE");
    expect(source).toContain("kitRouteStatic: env.KIT_ROUTE_STATIC");
    expect(source).toContain("sessionFor: kitSessionBridge(env)");
    expect(source).toContain("authStatusCookieFor: kitAuthStatusCookieFor(env)");
    expect(source.match(/dispatchHookRequest\(event,/g)?.length).toBe(1);
    // Production session composition lives in kitSessionBridge
    // (src/kit-session.ts), pinned by test/kit-session.test.ts: the hook must
    // not carry any session logic to mutate. Each of these mutants stays green
    // without this pin (an empty journey secret, unknown remapped to guest, a
    // forced memory store).
    expect(source).not.toContain("resolveRequestSession");
    expect(source).not.toContain("readReturnJourney");
    expect(source).not.toContain("storeForEnv");
    expect(source).not.toContain("SESSION_SECRET");
    expect(source).not.toContain("Promise.all");
    // Production trust and ownership live in the core (imported, not
    // injected): the hook must not carry any owner logic to mutate. Each of
    // these mutants stays green without this pin (force kit via an injected
    // owner, a manifest override, or a hard-coded string). The archive
    // guard/cache branch lives in dispatchHookRequest too: changing the
    // route id so the archive is never wrapped stays green without these
    // pins (no throttle, no cache).
    expect(source).not.toContain("/events/past");
    expect(source).not.toContain("route?.id");
    expect(source).not.toContain("route.id");
    expect(source).not.toContain("decideOwner");
    expect(source).not.toContain("isTrustedHost");
    expect(source).not.toContain("resolveRouteOwner");
    expect(source).not.toContain("ROUTE_MANIFEST");
    expect(source).not.toContain("manifest");
    expect(source).not.toContain("enabled");
    expect(source).not.toContain("decorateKitResponse");
    expect(source).not.toContain("KIT_RENDERER");
    expect(source).not.toContain("securityHeadersFor");
    expect(source).not.toContain("robotsTagFor");
    expect(source).not.toContain('"kit"');
    expect(source).not.toContain("'kit'");
    expect(source).not.toContain("as const");
  });
});
