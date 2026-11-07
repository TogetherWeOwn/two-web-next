// Characterize the registered pure-Hono member gate, not Worker/Kit parity.
// Existing profile suites own successful writes, 405/Allow, validation and caps.
// These cases cover missing method/path edges; observed quirks are not approval
// to carry them into a migration or change the runtime contract.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import { registerErrorHandlers } from "../src/errors";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken } from "../src/sessions";

const APP_URL = "https://fixture.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const USER_ID = "111111111111111111";
const env = { APP_URL, SESSION_SECRET } as Env;
const roles = ["guest", "non-member", "member"] as const;
type Role = (typeof roles)[number];

async function fixture(role: Role, limited = false) {
  const sessions = createMemorySessionStore();
  let cookie = "";
  if (role !== "guest") {
    const token = `two_${"a".repeat(43)}`;
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: USER_ID,
      username: "synthetic-member",
      avatar: null,
      member: role === "member",
      moderator: false,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }
  const get = vi.spyOn(sessions, "get");
  const rotate = vi.spyOn(sessions, "rotate");
  const store = createMemoryProfileStore([]);
  const find = vi.spyOn(store, "find");
  const save = vi.spyOn(store, "save");
  const accessLog = vi.fn(async () => true);
  const throttle = vi.fn(async (_bucket: string) =>
    limited ? ({ limited: true, retryAfter: 31 } as const) : ({ limited: false } as const),
  );
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", sameOrigin);
  registerErrorHandlers(app);
  app.route("/", profilesApp({ sessionStore: sessions, store, accessLog, throttle }));
  return { app, cookie, get, rotate, find, save, accessLog, throttle };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function noProfileEffects(f: Fixture) {
  expect(f.find).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.accessLog).not.toHaveBeenCalled();
  expect(f.throttle).not.toHaveBeenCalled();
  expect(f.rotate).not.toHaveBeenCalled();
}

const unsupported = [
  ...["/profile", "/leaderboards/members"].flatMap((path) =>
    ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => ({ method, path })),
  ),
  ...["PUT", "DELETE", "OPTIONS"].map((method) => ({ method, path: `/members/${USER_ID}` })),
];

describe("Hono member gates on unsupported methods", () => {
  it.each(unsupported)(
    "$method $path gates before falling through, without Allow",
    async ({ method, path }) => {
      for (const role of roles) {
        for (const accept of ["application/json", "text/html"]) {
          const f = await fixture(role);
          const response = await f.app.request(
            new URL(path, APP_URL).href,
            { method, headers: { cookie: f.cookie, origin: APP_URL, accept } },
            env,
          );
          const label = `${role} ${accept}`;
          expect(response.status, label).toBe(
            role === "guest"
              ? accept === "application/json"
                ? 401
                : 303
              : role === "non-member"
                ? 403
                : 404,
          );
          expect(response.headers.get("allow"), label).toBeNull();
          expect(response.headers.get("cache-control"), label).toMatch(/private/);
          expect(response.headers.get("cache-control"), label).toMatch(/no-store/);
          if (role === "guest") {
            // The existing recovery helper falls back to /events outside /members/.
            const recovery = `/auth/recover?next=${path.startsWith("/members/") ? "%2Fprofile" : "%2Fevents"}`;
            if (accept === "application/json") {
              expect(await response.json()).toEqual({ error: "unauthenticated", recovery });
              expect(response.headers.get("set-cookie")).toBeNull();
            } else {
              expect(response.headers.get("location")).toBe(recovery);
            }
            expect(f.get).not.toHaveBeenCalled();
          } else {
            expect(f.get).toHaveBeenCalledOnce();
            expect(response.headers.get("location")).toBeNull();
            expect(response.headers.get("set-cookie")).toBeNull();
            if (role === "member")
              expect(await response.text()).toContain("We cannot find that page");
          }
          noProfileEffects(f);
        }
      }
    },
  );
});

describe("Hono strict member paths", () => {
  it.each(["/profile/", "/leaderboards/members/"])(
    "%s misses the exact gate on unsupported verbs",
    async (path) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        for (const role of roles) {
          const f = await fixture(role);
          const response = await f.app.request(
            new URL(path, APP_URL).href,
            {
              method,
              headers: { cookie: f.cookie, origin: APP_URL, accept: "text/html" },
            },
            env,
          );
          expect(response.status, `${method} ${role}`).toBe(404);
          expect(response.headers.get("allow")).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(await response.text()).toContain("We cannot find that page");
          expect(f.get).not.toHaveBeenCalled();
          noProfileEffects(f);
        }
      }
    },
  );

  it.each(["/members", "/members/", `/members/${USER_ID}/`])(
    "write verbs on %s retain the wildcard gate, not the frozen GET handler",
    async (path) => {
      for (const method of ["POST", "PATCH"]) {
        // Guest slash writes already have explicit recovery assertions in
        // body-limit-route-admission; these are the missing signed-in controls.
        for (const role of ["non-member", "member"] as const) {
          const f = await fixture(role);
          const response = await f.app.request(
            new URL(path, APP_URL).href,
            {
              method,
              headers: { cookie: f.cookie, origin: APP_URL, accept: "text/html" },
              body: "_method=PATCH&bio=not-saved&games_text=",
            },
            env,
          );
          expect(response.status, `${method} ${role}`).toBe(role === "non-member" ? 403 : 404);
          expect(response.headers.get("allow")).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(f.get).toHaveBeenCalledOnce();
          noProfileEffects(f);
        }
      }
    },
  );
});

describe("Hono profile admission precedence", () => {
  it.each(["PATCH", "POST"])("%s spent budget precedes the non-owner refusal", async (method) => {
    const f = await fixture("member", true);
    const response = await f.app.request(
      new URL("/members/222222222222222222", APP_URL).href,
      {
        method,
        headers: {
          cookie: f.cookie,
          origin: APP_URL,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "_method=PATCH&bio=not-saved&games_text=",
      },
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
    expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.throttle).toHaveBeenCalledExactlyOnceWith(`profile-write:${USER_ID}`);
    expect(f.find).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.accessLog).not.toHaveBeenCalled();
  });
});
