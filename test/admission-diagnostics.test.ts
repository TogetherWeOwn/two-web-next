import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warnAdmissionStoreFailure } from "../src/admission-diagnostics";
import type { Env } from "../src/env";
import { trustHosts } from "../src/trust-hosts";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRIVATE = "private-member-value";

afterEach(() => vi.restoreAllMocks());

describe("admission diagnostics do not inspect arbitrary error properties", () => {
  it.each([
    [new TypeError(PRIVATE), "TypeError"],
    [new RangeError(PRIVATE), "RangeError"],
    [new ReferenceError(PRIVATE), "ReferenceError"],
    [new SyntaxError(PRIVATE), "SyntaxError"],
    [new URIError(PRIVATE), "URIError"],
    [new EvalError(PRIVATE), "EvalError"],
    [new AggregateError([PRIVATE], PRIVATE), "AggregateError"],
    [new Error(PRIVATE), "Error"],
    [PRIVATE, "unknown"],
    [null, "unknown"],
    [{ name: PRIVATE, constructor: { name: PRIVATE } }, "unknown"],
  ])("projects %s to a fixed category", async (error, category) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono();
    app.get("/", (c) => {
      c.set("requestId", ULID);
      warnAdmissionStoreFailure(c, "join", error);
      return c.body(null, 204);
    });
    expect((await app.request("/")).status).toBe(204);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "join.throttle.store_failed",
        throttle: "join",
        exception: category,
        request_id: ULID,
      }),
    );
  });

  it.each(["getters", "proxy"])("preserves admission for hostile %s", async (kind) => {
    const reads = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    const error =
      kind === "proxy"
        ? new Proxy({}, { get: reads, getPrototypeOf: reads })
        : Object.defineProperties(new Error(PRIVATE), {
            name: { get: reads },
            constructor: { get: reads },
            message: { get: reads },
            stack: { get: reads },
          });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono();
    app.get("/", (c) => {
      warnAdmissionStoreFailure(c, "profile-write", error);
      return c.body(null, 204);
    });
    expect((await app.request("/")).status).toBe(204);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "profile.throttle.store_failed",
        throttle: "profile-write",
        exception: kind === "proxy" ? "unknown" : "Error",
      }),
    );
    expect(reads).toHaveBeenCalledTimes(kind === "proxy" ? 1 : 0);
  });
});

describe("host warning correlation uses only a validated context id", () => {
  it.each([ULID, PRIVATE])("projects context correlation %s", async (id) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("requestId", id);
      await next();
    });
    app.use("*", trustHosts());
    const response = await app.request("https://hostile.example.test/", {}, {
      APP_URL: "https://trusted.example.test",
    } as Env);
    expect(response.status).toBe(404);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "http.untrusted_host",
        ...(id === ULID ? { request_id: ULID } : {}),
        next_action: "check_app_url_and_proxy_host",
      }),
    );
  });
});
