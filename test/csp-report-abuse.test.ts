// route-inventory: POST /csp-reports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { MAX_CSP_REPORT_BYTES } from "../src/csp-reports";

const CAP = MAX_CSP_REPORT_BYTES;
const MARKER = "csp-abuse-probe-7f3a9d";
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

const makeEnv = (sampleRate: string) =>
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

const oversizeBodyWithMarker = () => `${MARKER}${"x".repeat(CAP + 1 - MARKER.length)}`;

async function post(
  body: BodyInit | null | undefined,
  env: Env = makeEnv("1"),
  headers: HeadersInit = {},
) {
  return app.request(
    "/csp-reports",
    { method: "POST", body, headers: { cookie: FORGED_COOKIE, ...headers } },
    env,
    executionCtx as never,
  );
}

async function expectFunnel(res: Response) {
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.getSetCookie()).toEqual([]);
}

beforeEach(() => {
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

describe("CSP sink abuse resistance (TOG-12864)", () => {
  it("pins the 8 KB cap", () => {
    expect(CAP).toBe(8192);
  });

  it("answers 204 with funnel headers on every sink path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const atCap = validBody().padEnd(CAP, " ");
    expect(atCap).toHaveLength(CAP);
    const cases: Array<BodyInit | null> = [
      validBody(),
      JSON.stringify([{ body: { blockedURL: "inline" } }]),
      "not-json{{{",
      JSON.stringify({ hello: "world" }),
      null,
      "x".repeat(CAP + 1),
      atCap,
    ];
    for (const body of cases) {
      await expectFunnel(await post(body));
    }
    expect(warn).toHaveBeenCalled();
  });

  it("absorbs a valid-report flood without amplifying: all 204, fixed keys, no echo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.mocked(console.log);
    const n = 20;
    for (let i = 0; i < n; i += 1) {
      await expectFunnel(await post(validBody()));
    }
    expect(warn).toHaveBeenCalledTimes(n);
    for (const call of warn.mock.calls) {
      expect(call).toEqual([
        "csp.report.violation",
        {
          blocked_uri: "inline",
          violated_directive: "script-src",
          document_uri: null,
          source_file: null,
          line_number: null,
        },
      ]);
    }
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(MARKER);
    expect(JSON.stringify(log.mock.calls)).not.toContain(MARKER);
  });

  it("stays silent under flood when sampled out, still 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeEnv("0.0");
    for (let i = 0; i < 20; i += 1) {
      await expectFunnel(await post(validBody(), env));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("bounds log volume under flood at a fractional rate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      calls += 1;
      return calls % 2 === 0 ? 0.6 : 0.4;
    });
    const env = makeEnv("0.5");
    for (let i = 0; i < 20; i += 1) {
      await expectFunnel(await post(validBody(), env));
    }
    expect(warn).toHaveBeenCalledTimes(10);
  });

  it("drops an oversize flood with byte-count logs and no payload echo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = oversizeBodyWithMarker();
    expect(body).toHaveLength(CAP + 1);
    expect(body).toContain(MARKER);
    for (let i = 0; i < 10; i += 1) {
      await expectFunnel(await post(body));
    }
    expect(warn).toHaveBeenCalledTimes(10);
    for (const call of warn.mock.calls) {
      expect(call).toEqual(["csp.report.dropped_oversize", { bytes: CAP + 1 }]);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });

  it("touches no persistence seam across a mixed abuse burst", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeEnv("1");
    const burst: Array<BodyInit | null> = [
      validBody(),
      oversizeBodyWithMarker(),
      "not-json{{{",
      null,
      JSON.stringify([{ type: "deprecation", body: { blockedURL: "inline" } }]),
    ];
    for (const body of burst) {
      await expectFunnel(await post(body, env));
    }
    expect(warn.mock.calls.map((call) => call[0]).sort()).toEqual(
      ["csp.report.dropped_oversize", "csp.report.violation"].sort(),
    );
    expect(bindingAccess).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(waitUntilCalls).toHaveLength(0);
  });
});
