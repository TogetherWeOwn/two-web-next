// Kit admin event-edit dispatch: GET /admin/events/:key through
// dispatchHookRequest with the shipped edit-form declaration proves the new
// manifest entry routes (Kit when enabled, Hono while disabled) and the
// privileged boundary releases exactly what it should — moderator HTML with
// private/no-store and the audited roster subjects — and refuses the rest
// (audit failure, missing sink) with the sanitized 503 that names no member.
//
// The manifest override mirrors the shipped /admin/events/:key entry with
// enabled:true: the shipped entry stays Hono-owned until the enablement
// review, and the first test derives the override from it so the pins track
// the real declaration instead of a copy.
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitLocals } from "../src/kit-session";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";
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
const SUBJECT = "100000000000000333";
const REFUSAL = "Member data is temporarily unavailable.";
const ROSTER_HTML =
  '<main id="main"><form action="/admin/events/EVT1"></form><section data-testid="rsvp-roster"><table data-testid="roster-table"><tbody><tr><td>mod</td><td>going</td></tr></tbody></table></section></main>';

afterEach(() => vi.restoreAllMocks());

/** The override tracks the shipped declaration; only enablement differs. */
function editManifest(): OwnedRoute[] {
  const shipped = ROUTE_MANIFEST.find((e) => e.method === "GET" && e.path === "/admin/events/:key");
  if (!shipped) throw new Error("shipped GET /admin/events/:key manifest entry missing");
  expect(shipped.enabled).toBe(false);
  expect(shipped.reads).toEqual({
    resource: "events",
    action: "view",
    route: "admin.events.edit",
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

const eventFor = (path = "/admin/events/EVT1"): HookEventLike => {
  const request = new Request(`${APP_URL}${path}`, {
    method: "GET",
    headers: { host: "next.example.test" },
  });
  return { request, url: new URL(request.url), route: { id: "/admin/events/[key]" } };
};

/** What SvelteKit's resolve() returns: the edit form with its roster section. */
const editResolve = () => async () => {
  // The shared listRoster keyed read: the retrieved roster members are the
  // access-log subjects, like the Hono handler's keyed read.
  await keyedMemberRead(async () => {
    memberQueryPermit();
    declareMemberResult([SUBJECT]);
    return "roster";
  });
  return new Response(ROSTER_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
};

const depsFor = (overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps => ({
  appUrl: APP_URL,
  featuredImageHosts: "",
  honoFetch: vi.fn(async () => new Response("hono")),
  resolve: editResolve(),
  manifest: editManifest(),
  sessionFor: vi.fn(async () => localsFor("authenticated", MOD_ID)),
  accessSink: async () => null,
  ...overrides,
});

describe("Kit admin event-edit dispatch: privileged boundary releases and routing", () => {
  it("moderator edit form releases with private/no-store, the Kit marker and the audited roster subjects", async () => {
    const entries: AccessEntry[] = [];
    const sink = vi.fn(async (entry: AccessEntry) => {
      entries.push(entry);
      return true;
    });
    const res = await dispatchHookRequest(eventFor(), depsFor({ accessSink: async () => sink }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    const body = await res.text();
    expect(body).toContain('action="/admin/events/EVT1"');
    expect(body).toContain('data-testid="rsvp-roster"');
    // The roster read names its members: exactly one audit row carries them.
    expect(sink).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subjectUserIds).toEqual([SUBJECT]);
    expect(entries[0]?.route).toBe("admin.events.edit");
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

  it("the edit update and every transition POST keep one Hono authority", async () => {
    for (const path of [
      "/admin/events/EVT1",
      "/admin/events/EVT1/publish",
      "/admin/events/EVT1/cancel",
      "/admin/events/EVT1/rsvp-pause",
      "/admin/events/EVT1/rsvp-reopen",
    ]) {
      const request = new Request(`${APP_URL}${path}`, {
        method: "POST",
        headers: { host: "next.example.test" },
      });
      const res = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: "/admin/events/[key]" } },
        depsFor(),
      );
      expect(await res.text()).toBe("hono");
      expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    }
  });

  it("GET /admin/events/:key/edit legacy alias stays Hono-owned and drops no marker", async () => {
    const request = new Request(`${APP_URL}/admin/events/EVT1/edit`, {
      method: "GET",
      headers: { host: "next.example.test" },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/admin/events/[key]" } },
      depsFor(),
    );
    expect(await res.text()).toBe("hono");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("the legacy /admin/events/create bookmark stays Hono-owned once :key is enabled", async () => {
    const shippedCreate = ROUTE_MANIFEST.find(
      (e) => e.method === "GET" && e.path === "/admin/events/create",
    );
    if (!shippedCreate) throw new Error("shipped GET /admin/events/create manifest entry missing");
    expect(shippedCreate.enabled).toBe(false);
    const manifest = ROUTE_MANIFEST.map((e) =>
      e.method === "GET" && e.path === "/admin/events/:key" ? { ...e, enabled: true } : e,
    );
    const honoFetch = vi.fn(async () => new Response("hono"));
    const resolve = vi.fn(async () => new Response("kit"));
    const request = new Request(`${APP_URL}/admin/events/create`, {
      method: "GET",
      headers: { host: "next.example.test" },
    });
    const res = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/admin/events/[key]" } },
      { ...depsFor(), manifest, honoFetch, resolve },
    );
    expect(honoFetch).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(await res.text()).toBe("hono");
    expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("no event delete exists: mutating deletes stay Hono-owned like every other method", async () => {
    for (const method of ["DELETE", "POST"]) {
      const request = new Request(`${APP_URL}/admin/events/EVT1/delete`, {
        method,
        headers: { host: "next.example.test" },
      });
      const res = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: "/admin/events/[key]" } },
        depsFor(),
      );
      expect(await res.text()).toBe("hono");
      expect(res.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    }
  });

  it("failed audit write refuses with the sanitized 503 and no roster bytes", async () => {
    const res = await dispatchHookRequest(
      eventFor(),
      depsFor({
        accessSink: async () => async () => {
          throw new Error("audit store down");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain(SUBJECT);
    expect(body).not.toContain("rsvp-roster");
    expect(body).not.toContain("mod");
  });

  it("missing access sink refuses a roster-bearing read, never renders it", async () => {
    const res = await dispatchHookRequest(eventFor(), depsFor({ accessSink: async () => null }));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe(REFUSAL);
    expect(body).not.toContain("rsvp-roster");
  });
});
