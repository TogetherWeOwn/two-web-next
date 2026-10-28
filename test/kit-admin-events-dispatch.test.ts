// Kit admin events-list dispatch: GET /admin/events through
// dispatchHookRequest with the shipped events-list declaration proves the new
// manifest entry routes (Kit when enabled, Hono while disabled) and the
// privileged boundary releases exactly what it should — moderator HTML with
// private/no-store and zero audit rows for the subject-free events reads.
//
// The manifest override mirrors the shipped /admin/events entry with
// enabled:true: the shipped entry stays Hono-owned until the enablement
// review, and the first test derives the override from it so the pins track
// the real declaration instead of a copy.
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import { memberQueryPermit, nonSensitiveRead } from "../src/member-reads";
import {
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  type HookDispatchDeps,
  type HookEventLike,
  type OwnedRoute,
} from "../src/route-ownership";

const APP_URL = "https://next.example.test";
const MOD_ID = "100000000000000111";

afterEach(() => vi.restoreAllMocks());

/** The override tracks the shipped declaration; only enablement differs. */
function eventsManifest(): OwnedRoute[] {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin/events");
  if (!shipped) throw new Error("shipped GET /admin/events manifest entry missing");
  expect(shipped.enabled).toBe(false);
  expect(shipped.reads).toEqual({
    resource: "events",
    action: "list",
    route: "admin.events.index",
  });
  return [{ ...shipped, enabled: true }];
}

const localsFor = (status: KitLocals["status"], userId?: string): KitLocals => ({
  status,
  session:
    status === "authenticated"
      ? {
          userId: userId!,
          username: "mod",
          avatar: null,
          member: true,
          moderator: userId === MOD_ID,
        }
      : null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
  restoredWrite: null,
});

const eventFor = (): HookEventLike => {
  const request = new Request(`${APP_URL}/admin/events?page=2`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: "/admin/events" } };
};

/** What SvelteKit's resolve() returns: the bounded subject-free list reads. */
const eventsResolve = () => async () => {
  await nonSensitiveRead("events", async () => {
    memberQueryPermit();
    return [];
  });
  await nonSensitiveRead("going-counts", async () => {
    memberQueryPermit();
    return [];
  });
  return new Response('<main id="main"><table data-testid="events-table"></table></main>', {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
};

const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: eventsResolve(),
  manifest: eventsManifest(),
  sessionFor: vi.fn(async () => localsFor("authenticated", MOD_ID)),
  accessSink: async () => null,
  ...overrides,
});

describe("Kit admin events-list dispatch: privileged boundary releases and routing", () => {
  it("moderator events list releases with private/no-store and the Kit marker", async () => {
    const entries: AccessEntry[] = [];
    const sink = vi.fn(async (entry: AccessEntry) => {
      entries.push(entry);
      return true;
    });
    const res = await dispatchHookRequest(eventFor(), depsFor({ accessSink: async () => sink }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toContain('data-testid="events-table"');
    // Subject-free events list: classified reads, zero audit rows.
    expect(entries).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("the shipped disabled entry stays Hono-served with no Kit marker", async () => {
    const honoFetch = vi.fn(async () => new Response("hono"));
    const resolve = vi.fn(async () => new Response("kit"));
    const res = await dispatchHookRequest(eventFor(), {
      ...depsFor(),
      manifest: ROUTE_MANIFEST,
      honoFetch,
      resolve,
    });
    expect(honoFetch).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(await res.text()).toBe("hono");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("event writes stay Hono-owned when the matching Kit GET routes are enabled", async () => {
    const enabledEventsManifest = ROUTE_MANIFEST.map((entry) =>
      entry.method === "GET" && entry.path.startsWith("/admin/events")
        ? { ...entry, enabled: true }
        : entry,
    );
    for (const path of ["/admin/events", "/admin/events/new", "/admin/events/:key"]) {
      expect(enabledEventsManifest).toContainEqual(
        expect.objectContaining({ method: "GET", path, enabled: true }),
      );
    }
    const routes = [
      { path: "/admin/events", routeId: "/admin/events" },
      { path: "/admin/events/new", routeId: "/admin/events/new" },
      { path: "/admin/events/EVT1", routeId: "/admin/events/[key]" },
      { path: "/admin/events/EVT1/publish", routeId: "/[...path]" },
      { path: "/admin/events/EVT1/cancel", routeId: "/[...path]" },
      { path: "/admin/events/EVT1/rsvp-pause", routeId: "/[...path]" },
      { path: "/admin/events/EVT1/rsvp-reopen", routeId: "/[...path]" },
    ];

    for (const { path, routeId } of routes) {
      const request = new Request(`${APP_URL}${path}`, {
        method: "POST",
        headers: { host: "next.example.test" },
      });
      const honoFetch = vi.fn(async () => new Response("hono"));
      const resolve = vi.fn(async () => new Response("kit"));
      const res = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: routeId } },
        depsFor({ manifest: enabledEventsManifest, honoFetch, resolve }),
      );
      expect(honoFetch).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      expect(await res.text()).toBe("hono");
      expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    }
  });
});
