// Builder-owned supplement to test/invalid-operator-config-warn-acceptance.test.ts.
//
// The frozen acceptance surface pins warn-once for nonblank invalid values at
// the three numeric operator-config sites but never asserts warn-silence for
// blank values, so dropping any site's `raw.trim() !== ""` guard keeps every
// related suite green. Blank is this repo's cleared-var convention, so such a
// regression would mislead operators with an empty-value Invalid-config warn
// on every isolate. These tests pin that blank and whitespace-only values stay
// silent and keep their fallbacks. This file — not the frozen acceptance file,
// which the builder must not edit — owns that pin.
//
// Local fixtures only; no network, no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invalid operator config blank values stay silent", () => {
  it.each(["", "   "])("read budget %j keeps 60 without warning", async (value) => {
    const { publicReadBudget } = await import("../src/events/routes-shared");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: value } as Env)).toBe(60);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("ingress rate %j keeps 60 without warning", async (value) => {
    const { ingressConfig } = await import("../src/agent-events/route");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: value } as Env).routePerMinute).toBe(60);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("CSP sample rate %j keeps 1.0 without warning", async (value) => {
    const { parseCspSampleRate } = await import("../src/csp-reports");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCspSampleRate(value)).toBe(1.0);
    expect(warn).not.toHaveBeenCalled();
  });
});
