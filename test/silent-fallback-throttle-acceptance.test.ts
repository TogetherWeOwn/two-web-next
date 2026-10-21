// Acceptance contract: throttle fail-open paths warn (X3 leg B), route-only (rev 2).
//
// Acceptance-owned: the Builder builds on this branch and never edits this file.
// Failing-first: the three "warns" tests run RED on main (both fail-open paths
// are silent today) and go green when the build lands. The verdict controls
// already pass and must keep passing.
//
// Contract for the Builder (exact console.warn lines, each fired once per allow):
//   1. Null store (checkJoinThrottle with sql === null):
//      "Throttle store unavailable; allowing the request." { throttle }
//   2. Throwing store (throttleGuard catch, covering both a throwing
//      THROTTLE_STORE and a non-55P03 throw from the verdict transaction):
//      "Throttle store failed; allowing the request." { throttle, exception }
// The null-store warn lives in checkJoinThrottle so every caller (generic
// middleware, join funnel, profile writes) reports it; the store-throw warn
// lives in the throttleGuard catch. Emit exactly one line per allow: no
// pre-rethrow warn inside the verdict transaction. Verdicts are unchanged,
// including the 55P03 busy -> 429 refusal, which stays silent (a refusal is
// not a fail-open). Throttle names the route/throttle only (e.g. "probe");
// never the full "<name>:<client>" bucket, never IP bytes, never Discord or
// member IDs (content/privacy-policy-v5.md "never your IP address or who you
// are"; docs/throttling.md "No header bytes are logged"). Exception is the
// class only, never the message (it can quote statement bindings).
//
// Hermetic: in-memory SQL doubles, no database, no network.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { type EnvWithThrottle, throttleGuard } from "../src/throttle";

const IP = "192.0.2.44";
const THROTTLE = "probe";
const BUCKET = `${THROTTLE}:${IP}`;

function memorySql(opts: { count: number; wait?: number }): Sql {
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("pg_advisory_xact_lock")) return [];
    if (statement.includes("SELECT count(*)")) return [{ n: opts.count, wait: opts.wait ?? 1 }];
    if (statement.includes("INSERT INTO web_throttle_hits")) return [];
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (tag as { unsafe?: unknown }).unsafe = async () => [];
  tag.begin = (run) => run(tag as unknown as Sql);
  return tag as unknown as Sql;
}

/** First verdict transaction hits a held advisory lock (55P03); the prune then succeeds. */
function busyThenHealthySql(): Sql {
  let begins = 0;
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected busy-path statement");
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (tag as { unsafe?: unknown }).unsafe = async () => [];
  tag.begin = (run) => {
    begins += 1;
    if (begins === 1) {
      const busy = new Error("throttle busy throttle-busy-marker") as Error & { code?: string };
      busy.code = "55P03";
      return Promise.reject(busy);
    }
    return run(tag as unknown as Sql);
  };
  return tag as unknown as Sql;
}

function probeApp(throttleStore: () => Promise<Sql | null>) {
  const app = new Hono<{ Bindings: EnvWithThrottle }>();
  app.get("/probe", async (c) => {
    const limited = await throttleGuard(c, "probe", 10);
    if (limited) return limited;
    return c.json({ limited: false });
  });
  return (init?: RequestInit) =>
    app.request("/probe", { headers: { "cf-connecting-ip": IP }, ...init }, {
      THROTTLE_STORE: throttleStore,
    } as unknown as EnvWithThrottle);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("throttle fail-open warns (failing-first)", () => {
  it("null store allows with a throttle-naming warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkJoinThrottle(null, BUCKET, 10);
    expect(verdict).toEqual({ limited: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Throttle store unavailable; allowing the request.", {
      throttle: THROTTLE,
    });
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("bucket");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain(BUCKET);
  });

  it("throwing throttle store allows with a class-carrying warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = probeApp(async () => {
      throw new Error("private store failure throttle-store-marker");
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limited: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Throttle store failed; allowing the request.",
      expect.objectContaining({ throttle: THROTTLE, exception: "Error" }),
    );
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("bucket");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain(BUCKET);
    expect(logged).not.toContain("throttle-store-marker");
    expect(logged).not.toContain("private store failure");
  });

  it("verdict-transaction throw allows with a class-carrying warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = memorySql({ count: 0 }) as unknown as {
      begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    };
    failing.begin = async () => {
      throw new Error("private verdict failure throttle-verdict-marker");
    };
    const get = probeApp(async () => failing as unknown as Sql);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limited: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Throttle store failed; allowing the request.",
      expect.objectContaining({ throttle: THROTTLE, exception: "Error" }),
    );
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("bucket");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain(BUCKET);
    expect(logged).not.toContain("throttle-verdict-marker");
    expect(logged).not.toContain("private verdict failure");
  });
});

describe("throttle verdict stability + refusal silence", () => {
  it("an admitted request stays admitted with no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkJoinThrottle(memorySql({ count: 0 }), "join:admit-quiet", 10);
    expect(verdict).toEqual({ limited: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a refused request stays refused with no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkJoinThrottle(
      memorySql({ count: 999, wait: 42 }),
      "join:refuse-quiet",
      10,
    );
    expect(verdict).toEqual({ limited: true, retryAfter: 42 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("lock-busy stays a silent 55P03 refusal with no hit charged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkJoinThrottle(busyThenHealthySql(), "join:busy-quiet", 10);
    expect(verdict).toEqual({ limited: true, retryAfter: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a refused guard answers 429 with Retry-After and no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = probeApp(async () => memorySql({ count: 999, wait: 17 }));
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(warn).not.toHaveBeenCalled();
  });
});
