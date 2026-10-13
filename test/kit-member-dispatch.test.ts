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

describe("decideRoute", () => {
  it("returns the enabled entry, and HEAD follows the GET declaration", () => {
    const head = new Request(new URL("/members/1", APP_URL), { method: "HEAD" });
    expect(decideRoute(head, MEMBER_MANIFEST)?.reads).toEqual(MEMBER_READS);
  });

  it("POST to a member path is not a member read route", () => {
    const post = new Request(new URL("/members/1", APP_URL), { method: "POST" });
    expect(decideRoute(post, MEMBER_MANIFEST)).toBeUndefined();
  });

  it("the shipped manifest assigns the public archive to Kit and disabling it rolls back to Hono", () => {
    const get = new Request(new URL("/events/past", APP_URL));
    expect(ROUTE_MANIFEST).toEqual([
      { method: "GET", path: "/events/past", enabled: true, reads: "public" },
      { method: "GET", path: "/privacy", enabled: false, reads: "public" },
    ]);
    const archive = ROUTE_MANIFEST.find((entry) => entry.path === "/events/past");
    expect(decideRoute(get, ROUTE_MANIFEST)).toBe(archive);
    expect(decideRoute(get, [{ ...archive!, enabled: false }])).toBeUndefined();
  });
});
