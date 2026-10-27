// The island sources are standalone scripts, so the finite HTML cap is mirrored
// as a literal in each. Pin both mirrors to the one contract constant.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISCOVERY_HTML_MAX_BYTES } from "../src/islands/contracts";

describe("discovery HTML byte cap mirrors", () => {
  it.each(["events-calendar", "past-events"])("%s mirrors the contract constant", (island) => {
    const source = readFileSync(`assets/islands/${island}.js`, "utf8");
    const literals = [...source.matchAll(/var HTML_MAX_BYTES = (\d+);/g)].map((m) => Number(m[1]));
    expect(literals).toEqual([DISCOVERY_HTML_MAX_BYTES]);
  });

  it("is a finite cap above the largest measured page and below the 4 MiB ceiling", () => {
    expect(DISCOVERY_HTML_MAX_BYTES).toBeGreaterThan(177_177);
    expect(DISCOVERY_HTML_MAX_BYTES).toBeLessThanOrEqual(4_194_304);
  });
});
