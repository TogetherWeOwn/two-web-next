import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

const RAMP = {
  "--color-brand-ember": "#ff9c36",
  "--color-brand-magenta": "#ff0e52",
  "--color-brand-violet": "#5701ae",
} as const;
const RAMP_HEX = new Set(Object.values(RAMP).map((hex) => hex.slice(1).toLowerCase()));

// Text sources that ship to visitors or render pages. Artwork (*.svg) carries
// its own baked-in copy of the ramp; docs, ci rationale, tests and the
// generated leaf bundle name the hexes without shipping them to components.
const SCAN_ROOTS = ["src", "web/src", "public"] as const;
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".svelte", ".html", ".css", ".mjs", ".js"]);
const ALLOWLISTED = new Set(["public/theme-tokens.css", "src/leaf-critical-css.ts"]);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      const rel = relative(repoRoot, full);
      if (!ALLOWLISTED.has(rel)) out.push(rel);
    }
  }
  return out;
}

describe("brand token layer (Logo/Icon 1 ramp)", () => {
  it("defines the ember/magenta/violet ramp as semantic tokens", () => {
    const css = readFileSync(join(repoRoot, "public/theme-tokens.css"), "utf8");
    for (const [token, hex] of Object.entries(RAMP)) {
      expect(css).toContain(`${token}: ${hex};`);
    }
  });

  it("keeps raw ramp hex out of components, pages and shipped styles", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const rel of collect(join(repoRoot, root))) {
        const lower = readFileSync(join(repoRoot, rel), "utf8").toLowerCase();
        if ([...RAMP_HEX].some((hex) => lower.includes(hex))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
