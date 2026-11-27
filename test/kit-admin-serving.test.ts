import { drizzle } from "drizzle-orm/pg-proxy";
import { Context } from "hono";
import { expect, it, vi } from "vitest";
import { fetchKitAdminForm } from "../src/admin/kit-form-fetch";
import { fetchKitFeaturedLegacy } from "../src/admin/kit-featured-legacy-fetch";
import {
  adminFormPath,
  admitsKitAdmin,
  kitAdminAdmission,
  privateAdminResponse,
  usesKitDefaultAction,
} from "../src/admin/kit-serving";
import { STAGING_APP_URL } from "../src/qa";
import { type HookDispatchDeps, dispatchHookRequest, ROUTE_MANIFEST } from "../src/route-ownership";
import { createMemorySessionStore } from "../src/sessions";
import { MEMBER, MODERATOR, cookieFor, env as baseEnv } from "./helpers/member-data";

const loopback = "http://127.0.0.1:8787";
const operator = "/admin/ops-overrides";
const events = "/admin/events";
const env = { ...baseEnv, APP_URL: loopback };

it.each([
  [loopback, operator, "true", false, true],
  [STAGING_APP_URL, operator, "true", false, true],
  ["https://togetherweown.com", operator, "true", false, false],
  ["https://other.example", operator, "true", false, false],
  [loopback, operator, undefined, false, false],
  [loopback, operator, "True", false, false],
  [loopback, operator, "true", true, false],
  [loopback, operator + "/", "true", false, false],
  [loopback, "/admin/%6fps-overrides", "true", false, false],
] as const)(
  "checks literal admin admission for %s %s flag %s data %s",
  (app, path, flag, data, expected) => {
    const url = new URL(path, app);
    expect(admitsKitAdmin(new Request(url), url, data, app, flag)).toBe(expected);
  },
);

it("requires the original path, origin and mounted form ID", () => {
  const request = new Request(loopback + operator);
  expect(admitsKitAdmin(request, new URL(loopback + events), false, loopback, "true")).toBe(false);
  expect(
    admitsKitAdmin(request, new URL(STAGING_APP_URL + operator), false, loopback, "true"),
  ).toBe(false);
  expect(admitsKitAdmin(request, new URL(request.url), false, STAGING_APP_URL, "true")).toBe(false);
  expect(adminFormPath(events, "/admin/[...action]")).toBeUndefined();
  expect(adminFormPath(events, events)).toBe(events);
  expect(adminFormPath(events + "/seed-calendar-01/publish", "/admin/[...action]")).toBe(
    events + "/:key/publish",
  );
  expect(adminFormPath(events + "/%30/publish")).toBeUndefined();
});

const featuredBookmarks = "/admin/featured-contents";
const featuredEditRoute = `${featuredBookmarks}/[id]/edit`;

it.each([
  ["GET", featuredBookmarks, featuredBookmarks, "/admin/featured"],
  ["GET", `${featuredBookmarks}/create`, `${featuredBookmarks}/create`, "/admin/featured/new"],
  ["HEAD", `${featuredBookmarks}/91/edit`, featuredEditRoute, "/admin/featured/27"],
])("serves the guarded Kit bookmark %s %s", async (method, path, routeId, location) => {
  const store = createMemorySessionStore();
  const query = vi.fn(async (_statement: string, _params: unknown[]) => ({ rows: [[27]] }));
  const bindings = {
    ...env,
    KIT_ROUTE_ADMIN: "true",
    KIT_PARITY_FIXTURE_ADMIN_FEATURED_REDIRECTS: "true",
    SESSION_STORE: store,
    ADMIN_DB: drizzle(query),
  };
  const honoFetch = vi.fn(async () => new Response(null, { status: 404 }));
  for (const [cookie, status] of [
    [undefined, 302],
    [await cookieFor(store, MEMBER), 403],
    [await cookieFor(store, MODERATOR), 301],
  ] as const) {
    const request = new Request(`${loopback}${path}?next=%2Felsewhere`, {
      method,
      headers: cookie ? { cookie } : {},
    });
    const event = { request, url: new URL(request.url), route: { id: routeId }, locals: {} };
    const response = await dispatchHookRequest(event, {
      appUrl: loopback,
      admin: {
        env: bindings,
        completeForm: () => {
          throw new Error("unexpected form submission");
        },
      },
      honoFetch,
      resolve: async (owned) =>
        fetchKitFeaturedLegacy(
          owned.request,
          bindings,
          (owned.locals as { requestId: string }).requestId,
        ),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("x-two-renderer")).toBe("kit");
    expect(response.headers.get("location")).toBe(
      status === 301 ? location : status === 302 ? "/auth/discord" : null,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    if (method === "HEAD" || status === 301) expect(await response.text()).toBe("");
    if (status !== 301) expect(query).not.toHaveBeenCalled();
  }
  expect(honoFetch).not.toHaveBeenCalled();
  if (routeId === featuredEditRoute) {
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.slice(0, 2)).toEqual([
      'select "id" from "featured_contents" where "featured_contents"."legacy_id" = $1',
      ["91"],
    ]);
  } else expect(query).not.toHaveBeenCalled();
});

it.each([
  { appUrl: loopback, flag: "true", native: false },
  { appUrl: loopback, flag: "true", fixture: "true", native: true },
  { appUrl: loopback, fixture: "true", native: false },
  { appUrl: STAGING_APP_URL, flag: "true", fixture: "true", native: false },
])("admits the legacy event-create redirect only in its enabled admin lane (%j)", async (mode) => {
  const path = "/admin/events/create";
  const request = new Request(`${mode.appUrl}${path}?ignored=1`);
  const resolve = vi.fn(async () => new Response("", { status: 301 }));
  const honoFetch = vi.fn(async () => new Response("fallback"));
  const result = await dispatchHookRequest(
    { request, url: new URL(request.url), route: { id: path } },
    {
      appUrl: mode.appUrl,
      admin: {
        env: {
          ...env,
          APP_URL: mode.appUrl,
          KIT_ROUTE_ADMIN: mode.flag,
          KIT_PARITY_FIXTURE_ADMIN_EVENT_CREATE_REDIRECT: mode.fixture,
        },
        completeForm: () => {
          throw new Error("unexpected form submission");
        },
      },
      sessionFor: async () => ({
        status: "authenticated",
        session: { ...MODERATOR, avatar: null, moderator: true },
        returnTo: null,
        joinResult: null,
        expiredWrite: null,
      }),
      resolve,
      honoFetch,
    },
  );
  expect(result.headers.get("x-two-renderer")).toBe(mode.native ? "kit" : null);
  expect(resolve).toHaveBeenCalledTimes(mode.native ? 1 : 0);
  expect(honoFetch).toHaveBeenCalledTimes(mode.native ? 0 : 1);
});

it("keeps the legacy event-create endpoint behind admin admission when its manifest entry is enabled", async () => {
  const path = "/admin/events/create";
  const request = new Request(`${loopback}${path}`);
  const resolve = vi.fn(async () => new Response());
  const honoFetch = vi.fn(async () => new Response());
  await dispatchHookRequest(
    { request, url: new URL(request.url), route: { id: path } },
    {
      appUrl: loopback,
      manifest: ROUTE_MANIFEST.map((entry) =>
        entry.method === "GET" && entry.path === path ? { ...entry, enabled: true } : entry,
      ),
      resolve,
      honoFetch,
    },
  );
  expect(honoFetch).toHaveBeenCalledExactlyOnceWith(request);
  expect(resolve).not.toHaveBeenCalled();
});

it("registers the exact event duplication path on the shared action route", () => {
  const path = `${events}/seed-calendar-01/duplicate`;
  const id = "/admin/[...action]";
  expect(adminFormPath(path, id)).toBe(`${events}/:key/duplicate`);
  expect(adminFormPath(path, `${events}/[key]`)).toBeUndefined();
  expect(adminFormPath(`${path}/`, id)).toBeUndefined();
  expect(adminFormPath(`${events}/seed-calendar-01/duplicate/extra`, id)).toBeUndefined();
});

it.each(["guest", "unknown", "member", "moderator"] as const)(
  "admits %s via shared session state",
  async (role) => {
    const request = new Request(loopback + events);
    const context = new Context(request, { env, path: events });
    const result = await kitAdminAdmission(context, async () => ({
      status: role === "member" || role === "moderator" ? "authenticated" : role,
      session: { ...MODERATOR, avatar: null, moderator: role === "moderator" },
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    }));
    if (role === "moderator")
      expect(result).toMatchObject({ kind: "pass", actor: { id: MODERATOR.userId } });
    else
      expect(result).toMatchObject({
        kind: "refused",
        response: { status: { guest: 302, unknown: 503, member: 403 }[role] },
      });
  },
);

it("refuses a throwing session bridge and logs only the error class", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const context = new Context(new Request(loopback + events), { env, path: events });
    const result = await kitAdminAdmission(context, async () => {
      throw new TypeError("test detail");
    });
    expect(result).toMatchObject({ kind: "refused", response: { status: 503 } });
    expect(warn).toHaveBeenCalledWith("kit admin session bridge unavailable", {
      exception: "TypeError",
    });
  } finally {
    warn.mockRestore();
  }
});

it("distinguishes native default form submissions and enforces private HEAD", async () => {
  const form = () => ({ method: "POST", body: new URLSearchParams() });
  expect(usesKitDefaultAction(new Request(loopback + events, form()))).toBe(true);
  expect(usesKitDefaultAction(new Request(loopback + events + "?/save", form()))).toBe(false);
  expect(usesKitDefaultAction(new Request(loopback + events))).toBe(false);
  const head = privateAdminResponse(
    new Request(loopback + operator, { method: "HEAD" }),
    new Response("record", {
      headers: { etag: '"fixture"', "cache-control": "public, max-age=3600" },
    }),
  );
  expect(await head.text()).toBe("");
  expect(head.headers.get("etag")).toBeNull();
  expect(head.headers.get("cache-control")).toBe("private, no-store");
});

it("opens only exact POST form controllers and keeps shared refusal behavior", async () => {
  const actor = { id: MODERATOR.userId, username: MODERATOR.username };
  const id = "0123456789abcdef";
  expect((await fetchKitAdminForm(new Request(loopback + events), env, actor, id)).status).toBe(
    404,
  );
  expect(
    (await fetchKitAdminForm(new Request(loopback + operator, { method: "POST" }), env, actor, id))
      .status,
  ).toBe(404);
  const post = new Request(loopback + events, { method: "POST", body: new URLSearchParams() });
  expect((await fetchKitAdminForm(post, env, actor, id)).status).toBe(503);
});

it.each(["rsvp-pause", "rsvp-reopen"])("admits only the exact %s POST", async (action) => {
  const path = `/admin/events/seed-calendar-01/${action}`;
  const route = { id: `/admin/events/[key]/${action}` };
  expect(adminFormPath(path, route.id)).toBe(`/admin/events/:key/${action}`);
  expect(adminFormPath(path, "/admin/[...action]")).toBeUndefined();
  const actor = { id: MODERATOR.userId, username: MODERATOR.username };
  const context = (request: Request) => ({ request, url: new URL(request.url), route });
  const request = (method: string, suffix = "", origin = loopback) =>
    new Request(`${loopback}${path}${suffix}`, { method, headers: { origin } });
  const requestId = "0123456789abcdef";
  expect((await fetchKitAdminForm(request("POST"), env, actor, requestId)).status).toBe(404);
  expect(
    (
      await fetchKitAdminForm(
        new Request(loopback + events, { method: "POST" }),
        env,
        null,
        requestId,
      )
    ).status,
  ).toBe(404);

  const honoFetch = vi.fn(async () => new Response("fallback"));
  const resolve = vi.fn<HookDispatchDeps["resolve"]>(({ request, locals }) => {
    const { requestId } = locals as { requestId: string };
    return fetchKitAdminForm(request, env, null, requestId);
  });
  const sessionFor = vi.fn<NonNullable<HookDispatchDeps["sessionFor"]>>();
  const deps = {
    appUrl: loopback,
    featuredImageHosts: "",
    honoFetch,
    resolve,
    sessionFor,
    admin: {
      env: { ...env, KIT_ROUTE_ADMIN: "true" },
      completeForm: () => {
        throw new Error("Dedicated RSVP endpoints do not use a page action");
      },
    },
  } satisfies HookDispatchDeps;
  for (const fallback of [request("GET"), request("POST", "/"), request("POST", "/extra")]) {
    expect(await (await dispatchHookRequest(context(fallback), deps)).text()).toBe("fallback");
    expect(honoFetch).toHaveBeenLastCalledWith(fallback);
  }
  const off = request("POST");
  await dispatchHookRequest(context(off), {
    ...deps,
    admin: { ...deps.admin, env: { ...env, KIT_ROUTE_ADMIN: "false" } },
  });
  expect(honoFetch).toHaveBeenLastCalledWith(off);
  const cross = await dispatchHookRequest(
    context(request("POST", "", "https://other.example")),
    deps,
  );
  expect(cross.status).toBe(403);
  expect(resolve).not.toHaveBeenCalled();

  const guest = await dispatchHookRequest(context(request("POST")), deps);
  expect(guest.status).toBe(303);
  expect(guest.headers.get("location")).toBe(
    "/auth/recover?next=%2Fadmin%2Fevents%2Fseed-calendar-01",
  );
  expect(guest.headers.get("x-two-renderer")).toBe("kit");
  expect(resolve).toHaveBeenCalledOnce();
  expect(sessionFor).not.toHaveBeenCalled();
});
