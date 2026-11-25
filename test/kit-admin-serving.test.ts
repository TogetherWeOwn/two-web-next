import { Context } from "hono";
import { expect, it, vi } from "vitest";
import { fetchKitAdminForm } from "../src/admin/kit-form-fetch";
import {
  adminFormPath,
  admitsKitAdmin,
  kitAdminAdmission,
  privateAdminResponse,
  usesKitDefaultAction,
} from "../src/admin/kit-serving";
import { STAGING_APP_URL } from "../src/qa";
import { type HookDispatchDeps, dispatchHookRequest } from "../src/route-ownership";
import { MODERATOR, env as baseEnv } from "./helpers/member-data";

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
