import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

const numericSettings = ["E2E_PUBLIC_READ_BUDGET", "AGENT_EVENTS_ROUTE_PER_MINUTE"] as const;

async function readIntegerSetting(variable: (typeof numericSettings)[number], value: unknown) {
  const env = { [variable]: value } as Env;
  if (variable === "E2E_PUBLIC_READ_BUDGET") {
    const { publicReadBudget } = await import("../src/events/routes-shared");
    return publicReadBudget(env);
  }
  const { ingressConfig } = await import("../src/agent-events/route");
  const config = ingressConfig(env);
  expect(config.enabled).toBe(false);
  return config.routePerMinute;
}

describe.each(numericSettings)("%s diagnostics preserve Number parsing", (variable) => {
  it.each([undefined, "", " \t\n"])("silently keeps 60 for unset/blank %j", async (value) => {
    expect(await readIntegerSetting(variable, value)).toBe(60);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["600", 600],
    [" 2 ", 2],
    ["1e2", 100],
    ["0x10", 16],
    [12, 12],
  ])("silently retains accepted coercion %j -> %j", async (value, expected) => {
    expect(await readIntegerSetting(variable, value)).toBe(expected);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["typo", "0", "-1", "0.5", "Infinity", "1tail", 0, null, {}, []].map((value) => [value]))(
    "warns once without throwing or changing the fallback for %j",
    async (value) => {
      expect(await readIntegerSetting(variable, value)).toBe(60);
      expect(await readIntegerSetting(variable, value)).toBe(60);
      expect(vi.mocked(console.warn).mock.calls).toEqual([
        ["operator.config.invalid", { variable, action: "using_default" }],
      ]);
    },
  );

  it("deduplicates distinct invalid values without logging secret-shaped input", async () => {
    for (const value of [
      "fixture-secret-marker",
      "https://user:password@evil.com/?token=query",
      "-2",
    ]) {
      expect(await readIntegerSetting(variable, value)).toBe(60);
    }
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["operator.config.invalid", { variable, action: "using_default" }],
    ]);
  });

  it("does not let a broken warning logger change the fallback", async () => {
    vi.mocked(console.warn).mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    expect(await readIntegerSetting(variable, "typo")).toBe(60);
    expect(await readIntegerSetting(variable, "typo")).toBe(60);
    expect(await readIntegerSetting(variable, "typo")).toBe(60);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("CSP sample diagnostics preserve parseFloat and clamping", () => {
  it.each([undefined, "", " \t\n"])("silently keeps 1 for unset/blank %j", async (value) => {
    const { parseCspSampleRate } = await import("../src/csp-reports");
    expect(parseCspSampleRate(value)).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["0", 0],
    ["0.5", 0.5],
    ["1", 1],
    ["2", 1],
    ["-1", 0],
    ["0.5suffix", 0.5],
    ["0x10", 0],
  ])("silently preserves accepted/clamped %j -> %j", async (value, expected) => {
    const { parseCspSampleRate } = await import("../src/csp-reports");
    expect(parseCspSampleRate(value)).toBe(expected);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["typo", "Infinity", "-Infinity", "NaN", null, {}, false])(
    "warns once and keeps 1 for %j, including JSON-shaped runtime vars",
    async (value) => {
      const { parseCspSampleRate } = await import("../src/csp-reports");
      expect(parseCspSampleRate(value as string)).toBe(1);
      expect(parseCspSampleRate(value as string)).toBe(1);
      expect(vi.mocked(console.warn).mock.calls).toEqual([
        [
          "operator.config.invalid",
          { variable: "CSP_REPORT_SAMPLE_RATE", action: "using_default" },
        ],
      ]);
    },
  );
});

describe("serving paths retain their configuration fallbacks", () => {
  it("shares host diagnostics across Hono and framework-neutral CSP headers", async () => {
    const { securityHeadersFor } = await import("../src/headers");
    const { default: app } = await import("./app");
    const raw = "images.unsplash.com,*.evil.com";
    const neutral = new Headers(securityHeadersFor({ path: "/csp-reports", method: "POST" }, raw));
    const response = await app.request("/csp-reports", { method: "POST" }, {
      APP_URL: "https://next.example.test",
      FEATURED_IMAGE_HOSTS: raw,
    } as Env);
    expect(response.status).toBe(204);
    expect(response.headers.get("content-security-policy")).toBe(
      neutral.get("content-security-policy"),
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "https://images.unsplash.com",
    );
    expect(response.headers.get("content-security-policy")).not.toContain("evil.com");
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["operator.config.invalid", { variable: "FEATURED_IMAGE_HOSTS", action: "ignored_entries" }],
    ]);
  });

  it("keeps the CSP sink always-204 and sampled when configuration logging fails", async () => {
    const { Hono } = await import("hono");
    const { cspReportsRoute } = await import("../src/csp-reports");
    const app = new Hono<{ Bindings: Env }>();
    app.post("/csp-reports", cspReportsRoute);
    vi.mocked(console.warn).mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    const response = await app.request(
      "/csp-reports",
      { method: "POST", body: JSON.stringify({ "csp-report": { "blocked-uri": "inline" } }) },
      { CSP_REPORT_SAMPLE_RATE: "typo" } as Env,
    );
    expect(response.status).toBe(204);
    expect(vi.mocked(console.warn).mock.calls.map((call) => call[0])).toEqual([
      "operator.config.invalid",
      "csp.report.violation",
    ]);
  });
});
