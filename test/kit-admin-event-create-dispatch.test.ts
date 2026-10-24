// Kit admin event-create dispatch: GET /admin/events/new through
// dispatchHookRequest with the shipped create-form declaration proves the new
// manifest entry routes (Kit when enabled, Hono while disabled) and the
// privileged boundary releases exactly what it should.
//
// The manifest override mirrors the shipped /admin/events/new entry with
// enabled:true: the shipped entry stays Hono-owned until the enablement
// review, and the first test derives the override from it so the pins track
// the real declaration instead of a copy.
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
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
function createManifest(): OwnedRoute[] {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin/events/new");
  if (!shipped) throw new Error("shipped GET /admin/events/new manifest entry missing");
  expect(shipped.enabled).toBe(false);
  expect(shipped.reads).toEqual({
    resource: "events",
    action: "view",
    route: "admin.events.create",
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
  const request = new Request(`${APP_URL}/admin/events/new`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: "/admin/events/new" } };
};

/** What SvelteKit's resolve() returns: the empty create-form view. */
const createResolve = () => async () =>
  new Response('<main id="main"><form action="/admin/events"></form></main>', {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: createResolve(),
  manifest: createManifest(),
  sessionFor: vi.fn(async () => localsFor("authenticated", MOD_ID)),
  accessSink: async () => null,
  ...overrides,
});

describe("Kit admin event-create dispatch: privileged boundary releases and routing", () => {
  it("moderator create form releases with private/no-store and the Kit marker", async () => {
    const entries: AccessEntry[] = [];
    const sink = vi.fn(async (entry: AccessEntry) => {
      entries.push(entry);
      return true;
    });
    const res = await dispatchHookRequest(eventFor(), depsFor({ accessSink: async () => sink }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(await res.text()).toContain('action="/admin/events"');
    // Fresh GET performs no store read: zero audit rows.
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

  it("POST /admin/events is not a Kit route, so creates keep one Hono authority", async () => {
    const request = new Request(`${APP_URL}/admin/events`, {
      method: "POST",
      headers: { host: "next.example.test" },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/admin/events/new" } },
      depsFor(),
    );
    expect(await res.text()).toBe("hono");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("GET /admin/events/create legacy alias stays Hono-owned", async () => {
    const request = new Request(`${APP_URL}/admin/events/create`, {
      method: "GET",
      headers: { host: "next.example.test" },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/admin/events/new" } },
      depsFor(),
    );
    expect(await res.text()).toBe("hono");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });
});
