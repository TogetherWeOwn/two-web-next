import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { auditPaths } from "../ci/lighthouse-paths";

const require = createRequire(import.meta.url);
const { ci } = require("../ci/lighthouserc.cjs");
const admission = require("../ci/lighthouse-admission.cjs");

const origin = "http://127.0.0.1:8787";
const expected = ["/", "/events", "/join", "/about", "/faq", "/rules", "/privacy"];

// The worker allowlist (ci/lighthouse-paths.ts), the LHCI collect list and the
// admission probe list are three copies of one inventory. Returns what disagrees.
function inventoryMismatches(inventory: {
  worker: readonly string[];
  config: readonly string[];
  admission: readonly string[];
}): string[] {
  const configPaths = inventory.config.map((url) => url.replace(origin, ""));
  const problems: string[] = [];
  for (const path of inventory.worker) {
    if (!configPaths.includes(path)) problems.push(`config omits ${path}`);
    if (!inventory.admission.includes(path)) problems.push(`admission omits ${path}`);
  }
  for (const path of configPaths) {
    if (!inventory.worker.includes(path)) problems.push(`worker omits ${path}`);
  }
  for (const path of inventory.admission) {
    if (!inventory.worker.includes(path)) problems.push(`worker omits ${path}`);
  }
  if (configPaths.join() !== inventory.admission.join()) problems.push("config/admission order");
  return problems;
}

const real = { worker: auditPaths, config: ci.collect.url, admission: admission.paths };

describe("Lighthouse path inventory", () => {
  it("audits the five existing pages and the three static leaves", () => {
    expect(auditPaths).toHaveLength(8);
    for (const path of expected) expect(auditPaths).toContain(path);
    expect(auditPaths.filter((path: string) => path.startsWith("/e/"))).toHaveLength(1);
    expect(ci.collect.url).toHaveLength(8);
  });

  it("keeps the worker allowlist, LHCI config and admission probe in agreement", () => {
    expect(admission.origin).toBe(origin);
    expect(inventoryMismatches(real)).toEqual([]);
  });

  it.each(["/faq", "/rules", "/privacy", "/about"])(
    "rejects %s omitted from any one list",
    (path) => {
      const without = (list: readonly string[]) =>
        list.filter((entry) => entry !== path && entry !== `${origin}${path}`);
      expect(inventoryMismatches({ ...real, worker: without(real.worker) })).not.toEqual([]);
      expect(inventoryMismatches({ ...real, config: without(real.config) })).not.toEqual([]);
      expect(inventoryMismatches({ ...real, admission: without(real.admission) })).not.toEqual([]);
    },
  );

  it("rejects a path swapped for a different one in the config", () => {
    const config = real.config.map((url: string) =>
      url === `${origin}/privacy` ? `${origin}/terms` : url,
    );
    expect(inventoryMismatches({ ...real, config })).not.toEqual([]);
  });

  it("leaves the budget thresholds unchanged for all paths", () => {
    expect(ci.assert.assertions).toEqual({
      "largest-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median" }],
      "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median" }],
      "server-response-time": ["error", { maxNumericValue: 600, aggregationMethod: "median" }],
      "total-blocking-time": ["warn", { maxNumericValue: 300, aggregationMethod: "median" }],
      "first-contentful-paint": ["warn", { maxNumericValue: 1800, aggregationMethod: "median" }],
    });
  });
});
