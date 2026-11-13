// Pins the review-tiers.yml invariants: parse/version/default, this file is
// sensitive, ordinary is exactly the audited pure-copy modules, and the
// sensitive-wins overrides for gate-input docs and served SVG assets.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ReviewTiers {
  version: number;
  default_tier: string;
  tiers: Record<string, string[]>;
}

const doc = parse(readFileSync(resolve(root, ".github/review-tiers.yml"), "utf8")) as ReviewTiers;

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        if (pattern.charAt(i + 2) === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`${re}$`);
}

function classify(path: string): string {
  for (const tier of ["sensitive", "ordinary", "low"]) {
    if ((doc.tiers[tier] ?? []).some((glob) => globToRegExp(glob).test(path))) {
      return tier;
    }
  }
  return doc.default_tier;
}

describe("review-tiers.yml", () => {
  it("parses with version 1 and default_tier sensitive", () => {
    expect(doc.version).toBe(1);
    expect(doc.default_tier).toBe("sensitive");
  });

  it("classifies this bootstrap file as sensitive", () => {
    expect(classify(".github/review-tiers.yml")).toBe("sensitive");
    expect(classify(".github/workflows/ci.yml")).toBe("sensitive");
  });

  it("contains only the three audited pure-copy modules in ordinary", () => {
    expect(new Set(doc.tiers.ordinary)).toEqual(
      new Set(["src/about-content.ts", "src/faq-content.ts", "src/rules-content.ts"]),
    );
  });

  it("has no exact glob string in more than one tier", () => {
    const seen = new Map<string, string>();
    for (const [tier, globs] of Object.entries(doc.tiers)) {
      for (const glob of globs) {
        expect(seen.get(glob)).toBeUndefined();
        seen.set(glob, tier);
      }
    }
  });

  it("classifies CI gate-input docs as sensitive", () => {
    for (const file of [
      "docs/a11y-ci.md",
      "docs/ci-load-sensitive-tests.md",
      "docs/config.md",
      "docs/critical-journeys.md",
      "docs/db-migrations.md",
      "docs/kit-parity-gates.md",
      "docs/machine-errors.md",
      "docs/machine-interface.md",
      "docs/parity.md",
      "docs/performance-budgets.md",
      "docs/quality-gates.md",
      "docs/runbook.md",
      "docs/security-pin-contracts.md",
      "docs/threat-model.md",
      "docs/url-freeze.md",
    ]) {
      expect(classify(file), file).toBe("sensitive");
    }
    expect(classify("docs/nested/AGENTS.md")).toBe("sensitive");
    expect(classify("AGENTS.md")).toBe("sensitive");
  });

  it("classifies served SVG assets as sensitive and inert assets as low", () => {
    expect(classify("public/logo.svg")).toBe("sensitive");
    expect(classify("public/favicon.svg")).toBe("sensitive");
    expect(classify("public/icons/diagram.svg")).toBe("sensitive");
    expect(classify("public/fonts/display.svg")).toBe("sensitive");
    expect(classify("public/favicon.ico")).toBe("low");
    expect(classify("public/fonts/mona-sans-latin-wght.woff2")).toBe("low");
    expect(classify("public/icons/icon-192.png")).toBe("low");
  });

  it("keeps non-gate docs copy at low and unmatched paths sensitive", () => {
    expect(classify("README.md")).toBe("low");
    expect(classify("docs/architecture.md")).toBe("low");
    expect(classify("src/new-module.ts")).toBe("sensitive");
    expect(classify("new-top-level/file.md")).toBe("sensitive");
  });
});
