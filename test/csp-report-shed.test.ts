// route-inventory: POST /csp-reports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";

const MARKER = "csp-shed-probe-9b4e21";
const FORGED_COOKIE = "__Host-two_session=two_forged.bad";

const forbiddenBindings = new Set([
  "ADMIN_DB",
  "DB",
  "DATABASE_URL",
  "AGENT_DB",
  "HYPERDRIVE",
  "SESSION_STORE",
  "ROSTER_STORE",
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "QA_AUTH_TOKEN",
]);
const bindingAccess = vi.fn();
const baseEnv = { APP_URL: "https://next.example.test" } as Env;

const makeEnv = (sampleRate = "1") =>
  new Proxy(baseEnv, {
    get(target, key, receiver) {
      if (key === "CSP_REPORT_SAMPLE_RATE") return sampleRate;
      if (typeof key === "string" && forbiddenBindings.has(key)) {
        bindingAccess(key);
        throw new Error("CSP sink must not read DB, session or auth bindings");
      }
      return Reflect.get(target, key, receiver);
    },
  });

const waitUntilCalls: unknown[][] = [];
const executionCtx = {
  waitUntil: (...args: unknown[]) => {
    waitUntilCalls.push(args);
  },
  passThroughOnException: () => {},
};

const validBody = () =>
  JSON.stringify({
    "csp-report": {
      "blocked-uri": "inline",
      "violated-directive": "script-src",
      "evil-extra": MARKER,
    },
  });

async function post(body: BodyInit | null | undefined, env: Env = makeEnv()) {
  return app.request(
    "/csp-reports",
    { method: "POST", body, headers: { cookie: FORGED_COOKIE } },
    env,
    executionCtx as never,
  );
}

async function expectFunnel(res: Response) {
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(res.headers.get("retry-after")).toBeNull();
}

const shedCalls = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((call) => call[0] === "csp.report.shed");

const expectedViolation = {
  blocked_uri: "inline",
  violated_directive: "script-src",
  document_uri: null,
  source_file: null,
  line_number: null,
};

let now = Date.now();
beforeEach(() => {
  // Refill the isolate budget between independent cases, never within a flood.
  now += 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  waitUntilCalls.length = 0;
  bindingAccess.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("CSP sink must not fetch");
  });
});

afterEach(() => {
  try {
    expect(bindingAccess).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(waitUntilCalls).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
});

describe("CSP sink shed signal (TOG-31725)", () => {
  it("emits one bounded shed signal under sustained flood, still all 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 80; i += 1) {
      await expectFunnel(await post(validBody()));
    }
    expect(warn).toHaveBeenCalledTimes(21);
    const violations = warn.mock.calls.filter((call) => call[0] === "csp.report.violation");
    expect(violations).toHaveLength(20);
    for (const call of violations) {
      expect(call).toEqual(["csp.report.violation", expectedViolation]);
    }
    // Fresh isolate: the first shed carries exactly this burst's first drop.
    expect(shedCalls(warn)).toEqual([["csp.report.shed", { dropped: 1 }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });

  it("stays silent on quiet traffic: no shed without drops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expectFunnel(await post(validBody()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("csp.report.violation", expectedViolation);
    await expectFunnel(await post("not-json{{{"));
    await expectFunnel(await post(validBody(), makeEnv("0")));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(shedCalls(warn)).toHaveLength(0);
  });

  it("rate-bounds the shed signal to one per refill window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 25; i += 1) await expectFunnel(await post(validBody()));
    expect(shedCalls(warn)).toHaveLength(1);
    for (let i = 0; i < 25; i += 1) await expectFunnel(await post(validBody()));
    expect(shedCalls(warn)).toHaveLength(1);
    now += 3_000;
    await expectFunnel(await post(validBody()));
    await expectFunnel(await post(validBody()));
    const sheds = shedCalls(warn);
    expect(sheds).toHaveLength(2);
    const dropped = (sheds[1]?.[1] as { dropped: unknown }).dropped;
    expect(Number.isInteger(dropped)).toBe(true);
    expect(dropped as number).toBeGreaterThanOrEqual(25);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });
});
