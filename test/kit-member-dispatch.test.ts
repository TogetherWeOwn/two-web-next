import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";
import {
  decideRoute,
  dispatchHookRequest,
  type HookDispatchDeps,
  type HookEventLike,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  type OwnedRoute,
  ROUTE_MANIFEST,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const VIEWER = "100000000000000101";
const SUBJECT = "100000000000000102";
const REFUSAL = "Member data is temporarily unavailable.";
const MEMBER_READS = { resource: "profile", action: "view" as const, route: "profile" };
const MEMBER_MANIFEST: OwnedRoute[] = [
  { method: "GET", path: "/members/:id", enabled: true, reads: MEMBER_READS },
];
const PUBLIC_MANIFEST: OwnedRoute[] = [
  { method: "GET", path: "/events/past", enabled: true, reads: "public" },
];

afterEach(() => vi.restoreAllMocks());

const readOwners = <T>(owners: string[], value: T) =>
  keyedMemberRead(async () => {
    memberQueryPermit();
    declareMemberResult(owners);
    return value;
  });

const eventFor = (path: string, method = "GET"): HookEventLike => {
  const request = new Request(new URL(path, APP_URL).href, {
    method,
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: "/members/[id]" } };
};

const authenticated = (userId: string): KitLocals => ({
  status: "authenticated",
  session: { userId, username: "Rick", avatar: null, member: true, moderator: false },
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
});

const guest = (): KitLocals => ({
  status: "guest",
  session: null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
});

const recording = () => {
  const entries: AccessEntry[] = [];
  const sink = vi.fn(async (entry: AccessEntry) => {
    entries.push(entry);
    return true;
  });
  return { entries, sink };
};

const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: vi.fn(async () => new Response("kit")),
  manifest: MEMBER_MANIFEST,
  sessionFor: vi.fn(async () => authenticated(VIEWER)),
  accessSink: async () => null,
  ...overrides,
});

const expectSanitizedRefusal = async (res: Response) => {
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  const body = await res.text();
  expect(body).toBe(REFUSAL);
  expect(body).not.toContain(SUBJECT);
  expect(body).not.toContain(VIEWER);
};

describe("dispatchHookRequest member reads (Kit branch)", () => {
  it("releases a buffered member page and audits the authenticated viewer", async () => {
    const { entries, sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      resolve: vi.fn(async () => {
        const html = await readOwners([SUBJECT], "<h1>profile</h1>");
        return new Response(html, {
          headers: { "content-type": "text/html", "cache-control": "public, max-age=300" },
        });
      }),
    });
    const res = await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>profile</h1>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(entries).toEqual([
      {
        viewerDiscordId: VIEWER,
        viewerUserId: VIEWER,
        resource: "profile",
        action: "view",
        route: "profile",
        subjectUserIds: [SUBJECT],
      },
    ]);
  });

  it("an anonymous viewer is refused with a sanitized Kit-marked 503", async () => {
    const { sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      sessionFor: vi.fn(async () => guest()),
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>x</p>"))),
    });
    await expectSanitizedRefusal(await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps));
    expect(sink).not.toHaveBeenCalled();
  });

  it("a failed session bridge leaves the viewer unknown and refuses member contents", async () => {
    const { sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      sessionFor: vi.fn(async () => {
        throw new Error("store unreachable");
      }),
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>x</p>"))),
    });
    await expectSanitizedRefusal(await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps));
    expect(sink).not.toHaveBeenCalled();
  });

  it("a member route with no access sink fails closed", async () => {
    const deps = depsFor({
      accessSink: undefined,
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>x</p>"))),
    });
    await expectSanitizedRefusal(await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps));
  });

  it("an enabled route that declares no read class fails closed", async () => {
    const { sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      manifest: [{ method: "GET", path: "/members/:id", enabled: true }],
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>x</p>"))),
    });
    await expectSanitizedRefusal(await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps));
    expect(sink).not.toHaveBeenCalled();
  });

  it("a HEAD request is audited and answered without a body", async () => {
    const { entries, sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      resolve: vi.fn(async () => {
        await readOwners([SUBJECT], "<p>x</p>");
        return new Response(null, { headers: { "content-type": "text/html" } });
      }),
    });
    const res = await dispatchHookRequest(eventFor(`/members/${SUBJECT}`, "HEAD"), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("a data request follows its page into the boundary and audits the JSON", async () => {
    const { entries, sink } = recording();
    const deps = depsFor({
      accessSink: async () => sink,
      resolve: vi.fn(async () => {
        const data = await readOwners([SUBJECT], { id: SUBJECT });
        return new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      }),
    });
    const res = await dispatchHookRequest(
      eventFor(`/members/${SUBJECT}/__data.json?x-sveltekit-invalidated=011`),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SUBJECT });
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("a refused request leaves no state for the next sequential request", async () => {
    const { entries, sink } = recording();
    const refused = depsFor({
      accessSink: async () => sink,
      sessionFor: vi.fn(async () => guest()),
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>x</p>"))),
    });
    await expectSanitizedRefusal(
      await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), refused),
    );
    const clean = depsFor({
      accessSink: async () => sink,
      resolve: vi.fn(async () => new Response(await readOwners([SUBJECT], "<p>clean</p>"))),
    });
    const res = await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), clean);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>clean</p>");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("a public Kit route passes its response through untouched, with no audit", async () => {
    const { sink } = recording();
    const streamed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      }),
    );
    const deps = depsFor({
      manifest: PUBLIC_MANIFEST,
      accessSink: async () => sink,
      resolve: vi.fn(async () => streamed),
    });
    const res = await dispatchHookRequest(eventFor("/events/past"), deps);
    expect(res).toBe(streamed);
    expect(sink).not.toHaveBeenCalled();
    expect(await res.text()).toBe("streamed");
  });
});

describe("dispatchHookRequest event detail throttle (Kit branch)", () => {
  const DETAIL_MANIFEST: OwnedRoute[] = [
    {
      method: "GET",
      path: "/e/:key",
      enabled: true,
      reads: { resource: "member", action: "list", route: "events.page" },
    },
  ];
  const detailEventFor = (path: string): HookEventLike => ({
    ...eventFor(path),
    route: { id: "/e/[key]" },
  });

  it("wraps the member-read render with the detail throttle and still audits", async () => {
    const { entries, sink } = recording();
    const resolve = vi.fn(async () => {
      const html = await readOwners([SUBJECT], "<h1>event</h1>");
      return new Response(html, { headers: { "content-type": "text/html" } });
    });
    const eventDetail = vi.fn(async (_req: Request, render: () => Promise<Response>) => render());
    const deps = depsFor({
      manifest: DETAIL_MANIFEST,
      accessSink: async () => sink,
      resolve,
      eventDetail,
    });
    const event = detailEventFor("/e/abc123");
    const res = await dispatchHookRequest(event, deps);
    expect(eventDetail).toHaveBeenCalledTimes(1);
    // Clients the budget allows through still get the bridged session before
    // the member-read render.
    expect(deps.sessionFor).toHaveBeenCalledTimes(1);
    expect(eventDetail.mock.calls[0]![0]).toBe(event.request);
    expect(typeof eventDetail.mock.calls[0]![1]).toBe("function");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>event</h1>");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(entries).toEqual([
      {
        viewerDiscordId: VIEWER,
        viewerUserId: VIEWER,
        resource: "member",
        action: "list",
        route: "events.page",
        subjectUserIds: [SUBJECT],
      },
    ]);
  });

  it("a limited throttle answers 429 without resolving or auditing", async () => {
    const { sink } = recording();
    const resolve = vi.fn(async () => new Response("kit"));
    const sessionFor = vi.fn(async () => authenticated(VIEWER));
    const eventDetail = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "cache-control": "no-store, private" },
        }),
    );
    const deps = depsFor({
      manifest: DETAIL_MANIFEST,
      accessSink: async () => sink,
      resolve,
      sessionFor,
      eventDetail,
    });
    const res = await dispatchHookRequest(detailEventFor("/e/abc123"), deps);
    expect(eventDetail).toHaveBeenCalledTimes(1);
    // Throttle-first: the budget runs before the session bridge, so a
    // limited client costs no Postgres session read.
    expect(sessionFor).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toBe("slow down");
  });

  it("other member routes skip the detail wrapper", async () => {
    const { entries, sink } = recording();
    const eventDetail = vi.fn(async (_req: Request, render: () => Promise<Response>) => render());
    const deps = depsFor({
      accessSink: async () => sink,
      eventDetail,
      resolve: vi.fn(async () => {
        const html = await readOwners([SUBJECT], "<h1>profile</h1>");
        return new Response(html, { headers: { "content-type": "text/html" } });
      }),
    });
    const res = await dispatchHookRequest(eventFor(`/members/${SUBJECT}`), deps);
    expect(eventDetail).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>profile</h1>");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("renders directly in the boundary when the wrapper is absent", async () => {
    const { entries, sink } = recording();
    const deps = depsFor({
      manifest: DETAIL_MANIFEST,
      accessSink: async () => sink,
      resolve: vi.fn(async () => {
        const html = await readOwners([SUBJECT], "<h1>event</h1>");
        return new Response(html, { headers: { "content-type": "text/html" } });
      }),
    });
    const res = await dispatchHookRequest(detailEventFor("/e/abc123"), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>event</h1>");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });
});

describe("decideRoute", () => {
  it("returns the enabled entry, and HEAD follows the GET declaration", () => {
    const head = new Request(new URL("/members/1", APP_URL), { method: "HEAD" });
    expect(decideRoute(head, MEMBER_MANIFEST)?.reads).toEqual(MEMBER_READS);
  });

  it("POST to a member path is not a member read route", () => {
    const post = new Request(new URL("/members/1", APP_URL), { method: "POST" });
    expect(decideRoute(post, MEMBER_MANIFEST)).toBeUndefined();
  });

  it("the shipped manifest keeps the homepage, about, privacy, rules, faq, join and recover on Hono, assigns the public archive, events list, hot-zones and member board to Kit, and holds the admin dashboard, featured list, create and edit forms, activity log, events list, event-create and event-edit forms, join-attempts list and detail and profile reads on Hono", () => {
    const get = new Request(new URL("/events/past", APP_URL));
    expect(ROUTE_MANIFEST).toEqual([
      { method: "GET", path: "/", enabled: false, reads: "public" },
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "GET", path: "/events", enabled: true, reads: "public" },
      { method: "GET", path: "/about", enabled: false, reads: "public" },
      { method: "GET", path: "/privacy", enabled: false, reads: "public" },
      { method: "GET", path: "/rules", enabled: false, reads: "public" },
      { method: "GET", path: "/faq", enabled: false, reads: "public" },
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
        enabled: false,
        reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
      },
      {
        method: "GET",
        path: "/admin/join-attempts/:id",
        enabled: false,
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
    const archive = ROUTE_MANIFEST.find((entry) => entry.path === "/events/past");
    expect(decideRoute(get, ROUTE_MANIFEST)).toBe(archive);
    expect(decideRoute(get, [{ ...archive!, enabled: false }])).toBeUndefined();
    expect(decideRoute(new Request(new URL("/join", APP_URL)), ROUTE_MANIFEST)).toBeUndefined();
    // The moderator dashboard, featured list, create and edit forms,
    // activity log, events list, join-attempts list and detail, and recovery page stay
    // Hono-served until their enablement reviews.
    expect(decideRoute(new Request(new URL("/admin", APP_URL)), ROUTE_MANIFEST)).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/featured", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/featured/new", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/featured/7", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/activity-log", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/join-attempts", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/admin/join-attempts/7", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
    expect(decideRoute(new Request(new URL("/profile", APP_URL)), ROUTE_MANIFEST)).toBeUndefined();
    // Live event detail stays Hono-served until the RSVP companion passes.
    expect(decideRoute(new Request(new URL("/e/abc123", APP_URL)), ROUTE_MANIFEST)).toBeUndefined();
    expect(
      decideRoute(new Request(new URL("/auth/recover", APP_URL)), ROUTE_MANIFEST),
    ).toBeUndefined();
  });
});
