import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const docs = workflow.split("\n  docs-links:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";

describe("timeout ledger CI wiring", () => {
  it("runs the selftest and gate in the always-selected docs job", () => {
    expect(docs).toContain("node-version: 24");
    expect(docs).toContain("npm ci --include=dev --ignore-scripts --no-audit --no-fund");
    const step = docs
      .split(/\n      - /)
      .find((entry) => entry.startsWith("name: Timeout ledger ratchet (HARD)\n"));
    expect(step).toBeDefined();
    expect(step).toContain("run: npm run ledger:timeouts:selftest && npm run ledger:timeouts");
    expect(step).not.toMatch(/\bif:|continue-on-error:/);
    expect(docs).not.toMatch(/^    if:/m);
    expect(docs.indexOf("npm ci")).toBeLessThan(docs.indexOf("npm run ledger:timeouts:selftest"));
  });

  it("requires docs-links success in ci-ok", () => {
    const gate = workflow.split("\n  ci-ok:\n")[1] ?? "";
    expect(gate).toMatch(/needs:.*docs-links/);
    expect(gate).toContain("needs.docs-links.result");
  });
});
