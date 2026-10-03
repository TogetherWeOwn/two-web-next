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

function routeInfo(key: string) {
  const [method, pattern] = key.split(" ");
  const kind = rawApp.routes
    .filter((r) => `${r.method} ${r.path}` === key)
    .map((r) => bodyLimitClass(r.handler))
    .find(Boolean) as BodyClass;
  const path = pattern!
    .replace(":key", "test-event")
    .replace(":id", "1")
    .replace(":identity", "qa-member");
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
  const env = {
    APP_URL: STAGING_APP_URL,
    QA_AUTH_TOKEN: "test-only-qa-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: store,
    THROTTLE_STORE: async () => withThrottleTx(sql),
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
  if (path === "/__probe/alert") headers[QA_HEADER] = "test-only-qa-token";
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
        },
      },
      env,
    );
    expect(empty.status).toBe(429);
    for (const advertised of [false, true]) {
      const { request, pull } = upload(path, method, cookie, max, advertised);
      const response = await app.request(request, undefined, env);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
      expect(pull).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    }
    expect(sql).toHaveBeenCalledTimes(3);
    expect(count()).toBe(budget);
  });

  it.each(sharedRoutes)("%s counts advertised and chunked oversized attempts", async (key) => {
    const { method, path, max, budget } = routeInfo(key);
    for (const advertised of [false, true]) {
      const { sql, count } = throttleFixture(budget - 1);
      const { env, cookie } = await sessionEnv(sql as unknown as Sql);
      const first = upload(path, method, cookie, max, advertised);
      const response = await app.request(first.request, undefined, env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
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
        if (gate !== "host") expect(await response.json()).toEqual({ error: "cross_origin" });
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
      { APP_URL: "https://next.example.test", QA_AUTH_TOKEN: "test-only-qa-token" },
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
