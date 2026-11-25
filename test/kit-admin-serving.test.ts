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
import { dispatchHookRequest, KIT_RENDERER_HEADER } from "../src/route-ownership";
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

it.each([
  { origin: loopback, fixture: undefined, owned: false },
  { origin: loopback, fixture: "TRUE", owned: false },
  { origin: loopback, fixture: "true", owned: true },
  { origin: loopback, fixture: "true", family: "false", owned: false },
  { origin: loopback, fixture: "true", method: "GET", owned: false },
  { origin: loopback, fixture: "true", isDataRequest: true, owned: false },
  { origin: loopback, fixture: "true", routeId: null, owned: false },
  { origin: STAGING_APP_URL, fixture: "true", owned: false },
  { origin: "https://togetherweown.com", fixture: "true", owned: false },
])(
  "keeps featured unpublish dormant outside the admitted fixture (%j)",
  async ({
    origin,
    fixture,
    family = "true",
    method = "POST",
    isDataRequest = false,
    routeId = "/admin/[...action]",
    owned,
  }) => {
    const url = new URL("/admin/featured/12/unpublish", origin);
    const request = new Request(url, { method, headers: { origin } });
    const sessionFor = vi.fn(async () => ({
      status: "guest" as const,
      session: null,
      returnTo: null,
      joinResult: null,
      expiredWrite: null,
    }));
    const honoFetch = vi.fn(async () => new Response(null, { status: 303 }));
    const resolve = vi.fn(async () => new Response(null, { status: 500 }));
    const response = await dispatchHookRequest(
      { request, url, route: { id: routeId }, isDataRequest },
      {
        appUrl: origin,
        kitRouteEmberPages: "true",
        admin: {
          env: {
            ...baseEnv,
            APP_URL: origin,
            KIT_ROUTE_ADMIN: family,
            KIT_PARITY_FIXTURE_ADMIN_FEATURED_UNPUBLISH: fixture,
          },
          completeForm: () => {
            throw new Error("Guest reached the admin form");
          },
        },
        sessionFor,
        honoFetch,
        resolve,
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(owned ? "kit" : null);
    expect(sessionFor).toHaveBeenCalledTimes(owned ? 1 : 0);
    expect(honoFetch).toHaveBeenCalledTimes(owned ? 0 : 1);
    expect(resolve).not.toHaveBeenCalled();
  },
);
