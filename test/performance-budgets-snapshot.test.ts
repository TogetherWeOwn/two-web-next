import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISCORD_STORE_DEADLINE_MS,
  DISCORD_STORE_SQL_TIMEOUT_MS,
} from "../src/events/discord-snapshot-postgres";
import { DISCORD_READ_DEADLINE_MS } from "../src/events/discord-transients";
import {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
  DISCORD_REFRESH_LEASE_MS,
} from "../src/events/discord-snapshot";

const require = createRequire(import.meta.url);
const doc = readFileSync(new URL("../docs/performance-budgets.md", import.meta.url), "utf8");
const lighthouse = require("../ci/lighthouserc.cjs").ci;
const qualityBudget = JSON.parse(
  readFileSync(new URL("../ci/quality-budget.json", import.meta.url), "utf8"),
) as {
  mobilePerformance: number;
  categories: Record<string, number>;
};
const stagingWorkflow = readFileSync(
  new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
  "utf8",
);
const originWorkflow = readFileSync(
  new URL("../.github/workflows/web-quality-origin.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const promotionResolver = readFileSync(
  new URL("../ci/resolve-promotion-sha.mjs", import.meta.url),
  "utf8",
);
// Comma-grouped thousands ("1,500 ms") and plain ("1500 ms") are the same bound.
const flat = doc.replace(/,/g, "");
const lineFor = (label: RegExp): string => {
  const line = flat.split("\n").find((line) => label.test(line));
  expect(line, `budgets doc line for ${label}`).toBeDefined();
  return line!;
};
const rowFor = lineFor;
// Whole-number match: "500 ms" must not match inside "1500 ms".
const num = (ms: number): RegExp => new RegExp(`(^|\\D)${ms} ms`);

describe("performance budgets snapshot path", () => {
  it("pins the asserted deadline constants", () => {
    expect(DISCORD_STORE_DEADLINE_MS).toBe(1500);
    expect(DISCORD_STORE_SQL_TIMEOUT_MS).toBe(400);
    expect(DISCORD_READ_DEADLINE_MS).toBe(1000);
    expect(DISCORD_CACHE_FRESH_MS).toBe(60_000);
    expect(DISCORD_CACHE_STALE_MS).toBe(600_000);
    expect(DISCORD_REFRESH_LEASE_MS).toBe(5_000);
    expect(DISCORD_FAILURE_HOLD_MS).toBe(10_000);
  });

  it("documents snapshot cold-claim, stale-serve and refresh-lease rows", () => {
    expect(doc).toMatch(/snapshot cold-claim/i);
    expect(doc).toMatch(/stale-serve/i);
    expect(doc).toMatch(/refresh-lease/i);
    expect(doc).toContain("test/discord-snapshot-deadline.test.ts");
  });

  it("keeps each documented bound equal to its asserted constant", () => {
    expect(rowFor(/snapshot cold-claim/i)).toMatch(num(DISCORD_STORE_DEADLINE_MS));
    const stale = rowFor(/stale-serve/i);
    expect(stale).toMatch(num(DISCORD_CACHE_FRESH_MS));
    expect(stale).toMatch(num(DISCORD_CACHE_STALE_MS));
    expect(rowFor(/refresh-lease/i)).toMatch(num(DISCORD_REFRESH_LEASE_MS));
    expect(lineFor(/headers-and-body deadline/i)).toMatch(num(DISCORD_READ_DEADLINE_MS));
    const statements = lineFor(/lock timeout/i);
    expect(statements).toMatch(num(DISCORD_STORE_SQL_TIMEOUT_MS));
    expect(statements).toMatch(num(DISCORD_STORE_SQL_TIMEOUT_MS - 50));
    expect(lineFor(/retry hold/i)).toMatch(num(DISCORD_FAILURE_HOLD_MS));
  });

  it("pins documented Lighthouse thresholds and mobile score to their configuration", () => {
    const thresholds = lighthouse.assert.assertions as Record<
      string,
      [string, Record<string, number>]
    >;
    const documented = [
      ["Largest contentful paint", "largest-contentful-paint"],
      ["Cumulative layout shift", "cumulative-layout-shift"],
      ["Server response time (observed TTFB)", "server-response-time"],
      ["Total blocking time", "total-blocking-time"],
      ["First contentful paint", "first-contentful-paint"],
    ] as const;

    for (const [label, audit] of documented) {
      const [severity, assertion] = thresholds[audit]!;
      const line = flat.split("\n").find((row) => row.startsWith(`| ${label} |`));
      expect(line, `threshold row for ${label}`).toBeDefined();
      const ceiling =
        audit === "cumulative-layout-shift"
          ? String(assertion.maxNumericValue)
          : `${assertion.maxNumericValue} ms`;
      expect(line!).toContain(ceiling);
      expect(line!).toContain(severity === "warn" ? "warning" : severity);
    }

    expect(lineFor(/^\| Performance category score \(mobile\) \|/)).toContain(
      `${qualityBudget.mobilePerformance} (${qualityBudget.mobilePerformance * 100}%)`,
    );
    expect(lighthouse.assert.assertions["categories:performance"][1].minScore).toBe(
      qualityBudget.mobilePerformance,
    );
  });

  it("documents every desktop quality category floor", () => {
    for (const [category, score] of Object.entries(qualityBudget.categories)) {
      const line = lineFor(new RegExp(`^\\| ${category} \\|`));
      expect(line).toContain(`${score} (${score * 100}%)`);
    }
  });

  it("distinguishes staging journeys, blocking quality checks and informational standards", () => {
    expect(doc).toMatch(/`staging-journeys`[^\n]*critical journey/i);
    expect(doc).toMatch(/`staging-quality`[^\n]*Lighthouse/i);
    expect(doc).toMatch(/\| Web standards \([^\n]*informational/i);
    expect(stagingWorkflow).toContain("name: staging-journeys");
    expect(stagingWorkflow).toContain("name: staging-quality");
    expect(originWorkflow).toContain(
      "name: Web standards (security headers, HTML basics, internal links)",
    );
    expect(originWorkflow).toMatch(
      /continue-on-error: true[\s\S]*?run: npm run standards -- --origin/,
    );
    expect(ciWorkflow).toContain(
      "name: Web standards (security headers, HTML basics, internal links)",
    );
    const ciStandards = ciWorkflow
      .split("name: Web standards (security headers, HTML basics, internal links)")[1]!
      .split("- name:")[0]!;
    expect(ciStandards).not.toContain("continue-on-error");
    expect(stagingWorkflow).toContain("Docs-only and test-only deploys");
    expect(stagingWorkflow).toContain("e2e-staging gates no merge");
    expect(promotionResolver).toContain('passed("staging-journeys") && passed("staging-quality")');
  });
});
