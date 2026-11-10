import { Hono, type Context } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import {
  BODY_LIMIT_BYTES,
  bodyLimitClass,
  requestBodyLimit,
  type BodyClass,
} from "../src/body-limit";
import {
  AUTH_THROTTLE_PER_MINUTE,
  WRITE_THROTTLE_PER_MINUTE,
  isThrottleMiddleware,
  type EnvWithThrottle,
} from "../src/throttle";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, hashToken, newSessionToken, type Sql } from "../src/sessions";

const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};
const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sharedRoutes = [
  ...new Set(
    rawApp.routes
      .filter((r) => mutating.has(r.method) && isThrottleMiddleware(r.handler))
      .map((r) => `${r.method} ${r.path}`),
  ),
];

// Moderator event writes, admin event forms, admin lifecycle actions, and the
// staging alert probe refuse oversized bodies before the shared throttle (and
// before any session read): cap-first, not throttle-first. The probe's QA gate
// still runs before its cap. Every other shared-throttle route keeps the
// throttle-before-buffering order.
const CAP_FIRST_ROUTES = new Set([
  "POST /events",
  "PATCH /events/:key",
  "POST /events/:key/publish",
  "POST /events/:key/cancel",
  "POST /events/:key/duplicate",
  "POST /events/:key/rsvp-pause",
  "POST /events/:key/rsvp-reopen",
  "POST /admin/events",
  "POST /admin/events/:key",
  "POST /admin/events/:key/publish",
  "POST /admin/events/:key/cancel",
  "POST /admin/events/:key/duplicate",
  "POST /admin/events/:key/rsvp-pause",
  "POST /admin/events/:key/rsvp-reopen",
  "POST /admin/queue/failed/:id/redispatch",
  "POST /__probe/alert",
]);

// Moderator featured writes refuse oversized bodies before the
// shared throttle (the moderator guard still runs first): cap-first, not
// throttle-first.
const FEATURED_WRITE_CAP_FIRST = new Set([
  "POST /admin/featured",
  "POST /admin/featured/:id",
  "POST /admin/featured/:id/delete",
  "POST /admin/featured/:id/unpublish",
]);

// Logout (both single and everywhere) and QA login refuse oversized bodies
// before the shared throttle: cap-first, not throttle-first. The QA
// identity/token gate still runs before the cap.
const AUTH_CAP_FIRST = new Set([
  "POST /logout",
  "POST /logout/everywhere",
  "POST /auth/qa/:identity",
]);

function routeInfo(key: string) {
  const [method, pattern] = key.split(" ");
  const kind = rawApp.routes
    .filter((r) => `${r.method} ${r.path}` === key)
    .map((r) => bodyLimitClass(r.handler))
    .find(Boolean) as BodyClass;
  // `:identity` first: it starts with `:id`, so the generic replacement would
  // rewrite `/auth/qa/:identity` to `/auth/qa/1entity` (an unknown identity,
  // which the S4 gate 404s before the throttle runs).
  const path = pattern!
    .replace(":identity", "qa-member")
    .replace(":key", "test-event")
    .replace(":id", "1");
  const budget =
    path.startsWith("/auth/qa/") || path === "/__probe/alert"
      ? AUTH_THROTTLE_PER_MINUTE
      : WRITE_THROTTLE_PER_MINUTE;
  return { method: method!, path, max: BODY_LIMIT_BYTES[kind], budget };
}

function throttleFixture(initial: number) {
  let hits = initial;
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  return { sql, count: () => hits };
}

async function sessionEnv(sql: Sql) {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "111111111111111111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  // In-process fixture only: this URL enables the gate; no staging HTTP or DB.
  // The staging-operator boundary opens for the fixture moderator, who is
  // its dedicated principal here; other routes ignore these flags.
  const env = {
    APP_URL: STAGING_APP_URL,
    QA_AUTH_TOKEN: "test-only-qa-token-with-32-plus-chars",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: store,
    THROTTLE_STORE: async () => withThrottleTx(sql),
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: "111111111111111111",
  } as unknown as EnvWithThrottle;
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
  return { env, cookie };
}

function upload(
  path: string,
  method: string,
  cookie: string,
  max: number,
  advertised: boolean,
  appUrl: string = STAGING_APP_URL,
) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const body = new ReadableStream({ pull }, { highWaterMark: 0 });
  const headers: Record<string, string> = { cookie, origin: appUrl, accept: "application/json" };
  if (path === "/__probe/alert") headers[QA_HEADER] = "test-only-qa-token-with-32-plus-chars";
  // Gated QA logins exercise cap-after-gate, throttle-after-cap: the seam's
  // identity/token gate admits this fixture identity, then the body cap runs
  // before the throttle (S4 gate-first ordering is unchanged).
  if (path.startsWith("/auth/qa/")) headers[QA_HEADER] = "test-only-qa-token-with-32-plus-chars";
  if (advertised) headers["content-length"] = String(max + 1);
  const request = new Request(new URL(path, appUrl), {
    method,
    body,
    headers,
    duplex: "half",
  } as RequestInit);
  return { request, pull };
}

describe("shared throttles admit before buffering", () => {
  it.each(sharedRoutes)("%s rejects exhausted buckets without pulling any upload", async (key) => {
    const { method, path, max, budget } = routeInfo(key);
    const capFirst =
      CAP_FIRST_ROUTES.has(key) || FEATURED_WRITE_CAP_FIRST.has(key) || AUTH_CAP_FIRST.has(key);
    const { sql, count } = throttleFixture(budget);
    const { env, cookie } = await sessionEnv(sql as unknown as Sql);
    const empty = await app.request(
      path,
      {
        method,
        headers: {
          cookie,
          origin: env.APP_URL,
          accept: "application/json",
          ...(path === "/__probe/alert" ? { [QA_HEADER]: env.QA_AUTH_TOKEN! } : {}),
          ...(path.startsWith("/auth/qa/") ? { [QA_HEADER]: env.QA_AUTH_TOKEN! } : {}),
        },
      },
      env,
    );
    expect(empty.status).toBe(429);
    for (const advertised of [false, true]) {
      const { request, pull } = upload(path, method, cookie, max, advertised);
      const response = await app.request(request, undefined, env);
      if (capFirst) {
        // Cap-first routes refuse the oversized body before the throttle runs:
        // 413 even with a spent budget, spending no throttle row. (The probe's
        // and QA login's gates still run before the cap, so these requests
        // carry the token.)
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject(ERROR);
        if (advertised) expect(pull).not.toHaveBeenCalled();
        else expect(pull.mock.calls.length).toBeLessThanOrEqual(max / 1024 + 2);
      } else {
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
        expect(pull).not.toHaveBeenCalled();
      }
      await request.body?.cancel().catch(() => {});
    }
    if (capFirst) {
      // Empty refusal spends the usual select + age-only prune; the two
      // oversized refusals spend nothing.
      expect(sql).toHaveBeenCalledTimes(2);
    } else {
      // Count + age-only prune per refused request; no insert, no upload pull.
      expect(sql).toHaveBeenCalledTimes(6);
    }
    expect(count()).toBe(budget);
  });

  it.each(sharedRoutes)("%s counts advertised and chunked oversized attempts", async (key) => {
    const { method, path, max, budget } = routeInfo(key);
    const capFirst =
      CAP_FIRST_ROUTES.has(key) || FEATURED_WRITE_CAP_FIRST.has(key) || AUTH_CAP_FIRST.has(key);
    for (const advertised of [false, true]) {
      const { sql, count } = throttleFixture(budget - 1);
      const { env, cookie } = await sessionEnv(sql as unknown as Sql);
      const first = upload(path, method, cookie, max, advertised);
      const response = await app.request(first.request, undefined, env);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject(ERROR);
      if (capFirst) {
        // The cap runs before the throttle, so an oversized body spends no
        // throttle row; the budget still has room, so the follow-up oversized
        // body is a second 413, not a 429.
        expect(count()).toBe(budget - 1);
        expect(sql).not.toHaveBeenCalled();
        if (advertised) expect(first.pull).not.toHaveBeenCalled();
        else expect(first.pull.mock.calls.length).toBeLessThanOrEqual(max / 1024 + 2);
        const second = upload(path, method, cookie, max, false);
        const retry = await app.request(second.request, undefined, env);
        expect(retry.status).toBe(413);
        expect(await retry.json()).toMatchObject(ERROR);
        expect(second.pull.mock.calls.length).toBeLessThanOrEqual(max / 1024 + 2);
        expect(count()).toBe(budget - 1);
        expect(sql).not.toHaveBeenCalled();
        await first.request.body?.cancel().catch(() => {});
        await second.request.body?.cancel().catch(() => {});
        continue;
      }
      expect(count()).toBe(budget);
      expect(sql).toHaveBeenCalledTimes(3); // select, insert, prune
      if (advertised) expect(first.pull).not.toHaveBeenCalled();
      else expect(first.pull.mock.calls.length).toBeLessThanOrEqual(max / 1024 + 2);
      const second = upload(path, method, cookie, max, false);
      expect((await app.request(second.request, undefined, env)).status).toBe(429);
      expect(second.pull).not.toHaveBeenCalled();
      await second.request.body?.cancel().catch(() => {});
    }
  });
});

describe("global gates reject before admission or buffering", () => {
  it.each(sharedRoutes)("%s never pulls an upload rejected by host or origin", async (key) => {
    const { method, path, max } = routeInfo(key);
    const { sql } = throttleFixture(0);
    const { env, cookie } = await sessionEnv(sql as unknown as Sql);
    for (const gate of ["host", "origin", "missing-origin"] as const) {
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          path,
          method,
          cookie,
          max,
          advertised,
          gate === "host" ? "https://untrusted.example.test" : env.APP_URL,
        );
        if (gate === "origin") request.headers.set("origin", "https://untrusted.example.test");
        if (gate === "missing-origin") request.headers.delete("origin");
        const response = await app.request(request, undefined, env);
        expect(response.status).toBe(gate === "host" ? 404 : 403);
        if (gate !== "host")
          expect(await response.json()).toEqual({
            error: "cross_origin",
            request_id: expect.any(String),
          });
        expect(pull).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    }
  });
});

describe.each(["/auth/qa/qa-member", "/__probe/alert"])(
  "%s disabled QA seam rejects before admission or buffering",
  (path) => {
    it.each([
      {
        APP_URL: "https://next.example.test",
        QA_AUTH_TOKEN: "test-only-qa-token-with-32-plus-chars",
      },
      { APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: undefined },
    ])("returns 404 for advertised and chunked overflow with %j", async (config) => {
      const store = vi.fn(async () => null);
      const env = { ...config, THROTTLE_STORE: store } as unknown as EnvWithThrottle;
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          path,
          "POST",
          "",
          BODY_LIMIT_BYTES.action,
          advertised,
          config.APP_URL,
        );
        const response = await app.request(request, undefined, env);
        expect(response.status).toBe(404);
        expect(pull).not.toHaveBeenCalled();
        expect(store).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    });
  },
);

describe("alert probe authentication rejects before admission or buffering", () => {
  it.each(["", "wrong"])(
    "returns 404 for token %j without upload pulls or side effects",
    async (token) => {
      const { sql } = throttleFixture(0);
      const { env } = await sessionEnv(sql as unknown as Sql);
      const send = vi.fn();
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          "/__probe/alert",
          "POST",
          "",
          BODY_LIMIT_BYTES.action,
          advertised,
        );
        if (token) request.headers.set(QA_HEADER, token);
        else request.headers.delete(QA_HEADER);
        const response = await app.request(request, undefined, {
          ...env,
          INTERNAL_ACTION_QUEUE: { send } as unknown as Queue,
        });
        expect(response.status).toBe(404);
        expect(pull).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("qa seam authentication rejects before admission or buffering", () => {
  it.each(["", "wrong"])(
    "returns 404 for token %j without upload pulls or throttle writes",
    async (token) => {
      const { sql } = throttleFixture(0);
      const { env } = await sessionEnv(sql as unknown as Sql);
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          "/auth/qa/qa-member",
          "POST",
          "",
          BODY_LIMIT_BYTES.action,
          advertised,
        );
        if (token) request.headers.set(QA_HEADER, token);
        else request.headers.delete(QA_HEADER);
        const response = await app.request(request, undefined, env);
        expect(response.status).toBe(404);
        expect(pull).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );
});

describe("bounded-reader error scope", () => {
  it("does not translate downstream exceptions into upload errors", async () => {
    const fixture = new Hono<{ Bindings: Env }>();
    const error = new Error("fixture downstream failure");
    const onError = vi.fn((_error: Error, c: Context) => c.text("Internal Server Error", 500));
    fixture.onError(onError);
    fixture.post("/x", requestBodyLimit("json"), async (c) => {
      expect(await c.req.text()).toBe("{}");
      throw error;
    });
    const response = await fixture.request("/x", { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBe(error);
  });
});
