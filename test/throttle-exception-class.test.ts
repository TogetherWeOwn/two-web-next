// Throttle fail-open log line (src/throttle.ts exceptionClass): a store
// rejection logs only a bounded, de-newlined class name. Non-Error throws,
// non-string names and empty names degrade to "unknown" and still allow the
// request, never a 500.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { throttle, type EnvWithThrottle } from "../src/throttle";

afterEach(() => vi.restoreAllMocks());

async function failWith(thrown: unknown) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  warn.mockClear();
  const app = new Hono<{ Bindings: Env }>();
  app.post("/x", throttle("probe", 1), (c) => c.text("ok"));
  const env = {
    THROTTLE_STORE: () => Promise.reject(thrown),
  } as unknown as EnvWithThrottle;
  const res = await app.request("/x", { method: "POST" }, env);
  const line = warn.mock.calls.find(
    ([msg]) => msg === "Throttle store failed; allowing the request.",
  );
  return { status: res.status, exception: (line?.[1] as { exception?: string })?.exception };
}

describe("throttle store failure class", () => {
  it("logs an Error's name", async () => {
    expect(await failWith(new TypeError("secret bindings"))).toEqual({
      status: 200,
      exception: "TypeError",
    });
  });

  it("logs a non-Error's constructor name", async () => {
    class StoreFault {}
    expect(await failWith(new StoreFault())).toEqual({ status: 200, exception: "StoreFault" });
  });

  it("degrades a missing constructor to unknown", async () => {
    expect(await failWith(Object.create(null))).toEqual({ status: 200, exception: "unknown" });
    expect(await failWith(undefined)).toEqual({ status: 200, exception: "unknown" });
  });

  it("degrades a non-string or empty name to unknown", async () => {
    expect(await failWith({ constructor: { name: 42 } })).toEqual({
      status: 200,
      exception: "unknown",
    });
    const nameless = new Error("x");
    nameless.name = "";
    expect(await failWith(nameless)).toEqual({ status: 200, exception: "unknown" });
  });

  it("de-newlines and bounds a hostile name", async () => {
    const hostile = new Error("x");
    hostile.name = `Fake\r\nthrottle.refused ${"z".repeat(200)}`;
    const { status, exception } = await failWith(hostile);
    expect(status).toBe(200);
    expect(exception).not.toMatch(/[\r\n]/);
    expect(exception).toHaveLength(100);
    expect(exception!.startsWith("Fake_throttle.refused ")).toBe(true);
  });
});
