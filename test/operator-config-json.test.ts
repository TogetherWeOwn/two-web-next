import { describe, expect, it } from "vitest";
import { ingressConfig } from "../src/agent-events/route";
import { DEFAULT_CONFIG } from "../src/agent-events/service";
import { parseCspSampleRate } from "../src/csp-reports";
import type { Env } from "../src/env";
import { publicReadBudget, PUBLIC_EVENT_READS_PER_MINUTE } from "../src/events/routes-shared";

// Wrangler JSON bindings can reach these string-typed fields at runtime.
function binding(value: unknown): string {
  return value as string;
}

const exceptionalJson = [
  '{"toString":null}',
  '{"toString":0}',
  '{"toString":{}}',
  '[{"toString":null}]',
];

describe("JSON-valued operator configuration", () => {
  it.each(exceptionalJson)("uses existing numeric defaults when %s cannot coerce", (json) => {
    const raw = binding(JSON.parse(json));
    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: raw } as Env)).toBe(
      PUBLIC_EVENT_READS_PER_MINUTE,
    );
    expect(ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: raw } as Env).routePerMinute).toBe(
      DEFAULT_CONFIG.routePerMinute,
    );
    expect(parseCspSampleRate(raw)).toBe(1);
  });

  it.each([
    ["600", 600],
    [" 600 ", 600],
    ["1e2", 100],
    ["0x10", 16],
    [600, 600],
    [true, 1],
    [[12], 12],
    [[[12]], 12],
    [undefined, null],
    [null, null],
    [false, null],
    [[], null],
    [{}, null],
    ["", null],
    ["typo", null],
    ["12suffix", null],
    ["0", null],
    ["-1", null],
    ["1.5", null],
    ["Infinity", null],
  ])("preserves successful Number coercion and budget validation for %j", (value, expected) => {
    const raw = binding(value);
    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: raw } as Env)).toBe(
      expected ?? PUBLIC_EVENT_READS_PER_MINUTE,
    );
    expect(ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: raw } as Env).routePerMinute).toBe(
      expected ?? DEFAULT_CONFIG.routePerMinute,
    );
  });

  it.each([
    [undefined, 1],
    [null, 1],
    [true, 1],
    [false, 1],
    [{}, 1],
    [[], 1],
    ["", 1],
    ["typo", 1],
    ["Infinity", 1],
    ["0.25suffix", 0.25],
    [" 0.25 ", 0.25],
    ["0x10", 0],
    ["1e-1", 0.1],
    [0.25, 0.25],
    [[0.25], 0.25],
    [[0.25, 0.75], 0.25],
    ["2", 1],
    ["-1", 0],
  ])("preserves parseFloat prefixes, JSON coercion and clamping for %j", (value, expected) => {
    expect(parseCspSampleRate(binding(value))).toBe(expected);
  });
});
