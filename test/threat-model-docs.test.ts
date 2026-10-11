import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const model = readFileSync(new URL("../docs/threat-model.md", import.meta.url), "utf8");
const references = [...model.matchAll(/`((?:test|docs|src|tail|drizzle)\/[^`]+)`/g)].map(
  (match) => match[1]!,
);
const relativeLinks = [...model.matchAll(/\]\((\.\.\/[^)#]+)/g)].map((match) => match[1]!);

// Keep repository paths cited by the threat model resolvable as the repo changes.
describe("threat model documentation references", () => {
  it("references existing repository paths and relative documents", () => {
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(existsSync(new URL(`../${reference}`, import.meta.url)), reference).toBe(true);
    }
    for (const link of relativeLinks) {
      expect(
        existsSync(new URL(link, new URL("../docs/threat-model.md", import.meta.url))),
        link,
      ).toBe(true);
    }
  });
});
