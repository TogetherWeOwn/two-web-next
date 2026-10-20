// Acceptance: invalid operator config warns loudly instead of failing silent.
//
// Four operator-controlled settings currently fall back with no signal, so a
// one-character typo is indistinguishable from "unset" in every log stream:
//   - FEATURED_IMAGE_HOSTS entries dropped (src/image-policy.ts imageHosts)
//   - E2E_PUBLIC_READ_BUDGET override ignored (src/events/routes-shared.ts publicReadBudget)
//   - AGENT_EVENTS_ROUTE_PER_MINUTE override ignored (src/agent-events/route.ts ingressConfig)
//   - CSP_REPORT_SAMPLE_RATE typo keeps logging (src/csp-reports.ts parseCspSampleRate)
//
// Contract for the fix (builder owns src/ + docs/config.md; this file is
// the frozen acceptance surface and must not be edited by the builder):
//   - Each invalid value logs exactly one console.warn per isolate naming the
//     variable and the offending entry shape/value. A shared helper all four
//     sites import owns the warn (dedup + console.warn live in the helper).
//   - Valid and unset values stay silent. All fallback values and behaviors
//     are unchanged (Discord CDN default, 60/60 budgets, 1.0 sample rate,
//     clamping, fail-closed image filtering).
//   - docs/config.md rows for the four settings describe the warn.
//   - Dedup state is module-level (not globalThis): vi.resetModules plus a
//     fresh dynamic import is a fresh isolate that warns again. Every test
//     below uses dynamic imports for this reason; static value imports of the
//     four sites would pin stale dedup state.
//
// Local fixtures only; no network, no database.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET_SENTINEL = "***synthetic-secret-9q2w***";

function warnText(warn: ReturnType<typeof vi.spyOn>): string {
  return JSON.stringify(warn.mock.calls);
}

describe("invalid operator config warns loudly (acceptance)", () => {
  it("image hosts: unset and valid stay silent; invalid warns once naming the entry", async () => {
    const { imageHosts } = await import("../src/image-policy");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fallback pinned: unset keeps the existing Discord CDN default.
    expect(imageHosts()).toEqual(["cdn.discordapp.com"]);
    expect(warn).not.toHaveBeenCalled();

    // Valid entries stay silent and are admitted exactly.
    expect(imageHosts("images.unsplash.com")).toEqual([
      "cdn.discordapp.com",
      "images.unsplash.com",
    ]);
    expect(warn).not.toHaveBeenCalled();

    // Invalid entries still fail closed (dropped), but now loudly.
    expect(imageHosts("*.evil.com")).toEqual(["cdn.discordapp.com"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("FEATURED_IMAGE_HOSTS");
    expect(warnText(warn)).toContain("*.evil.com");

    // Once per isolate: repeats stay silent.
    expect(imageHosts("*.evil.com")).toEqual(["cdn.discordapp.com"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("read budget: unset and valid stay silent; invalid warns once and keeps 60", async () => {
    const { PUBLIC_EVENT_READS_PER_MINUTE, publicReadBudget } = await import(
      "../src/events/routes-shared"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fallback pinned: the production budget is 60.
    expect(PUBLIC_EVENT_READS_PER_MINUTE).toBe(60);
    expect(publicReadBudget({} as Env)).toBe(60);
    expect(warn).not.toHaveBeenCalled();

    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: "600" } as Env)).toBe(600);
    expect(warn).not.toHaveBeenCalled();

    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: "bogus" } as Env)).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("E2E_PUBLIC_READ_BUDGET");
    expect(warnText(warn)).toContain("bogus");

    expect(publicReadBudget({ E2E_PUBLIC_READ_BUDGET: "bogus" } as Env)).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ingress rate: unset and valid stay silent; invalid warns once without leaking secrets", async () => {
    const { ingressConfig } = await import("../src/agent-events/route");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fallback pinned: the outer shield budget is 60.
    expect(ingressConfig({} as Env).routePerMinute).toBe(60);
    expect(warn).not.toHaveBeenCalled();

    expect(ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: "120" } as Env).routePerMinute).toBe(120);
    expect(warn).not.toHaveBeenCalled();

    const cfg = ingressConfig({
      AGENT_EVENTS_ROUTE_PER_MINUTE: "bogus",
      SESSION_SECRET: SECRET_SENTINEL,
    } as unknown as Env);
    expect(cfg.routePerMinute).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("AGENT_EVENTS_ROUTE_PER_MINUTE");
    expect(warnText(warn)).toContain("bogus");
    expect(warnText(warn)).not.toContain(SECRET_SENTINEL);

    ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: "bogus" } as Env);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("CSP sample rate: unset and valid stay silent; typo warns once and keeps logging", async () => {
    const { parseCspSampleRate } = await import("../src/csp-reports");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fallback pinned: unset and typo keep the sink logging at 1.0.
    expect(parseCspSampleRate(undefined)).toBe(1.0);
    expect(warn).not.toHaveBeenCalled();

    expect(parseCspSampleRate("0.5")).toBe(0.5);
    expect(warn).not.toHaveBeenCalled();

    expect(parseCspSampleRate("typo")).toBe(1.0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnText(warn)).toContain("CSP_REPORT_SAMPLE_RATE");
    expect(warnText(warn)).toContain("typo");

    expect(parseCspSampleRate("typo")).toBe(1.0);
    expect(warn).toHaveBeenCalledTimes(1);

    // Clamp behavior pinned unchanged (values only; warn posture for
    // out-of-range input is intentionally unpinned).
    expect(parseCspSampleRate("2")).toBe(1);
    expect(parseCspSampleRate("-1")).toBe(0);
  });

  it("all four settings warn again after an isolate restart (fresh module), independently", async () => {
    const triggerAll = async () => {
      const { imageHosts } = await import("../src/image-policy");
      const { publicReadBudget } = await import("../src/events/routes-shared");
      const { ingressConfig } = await import("../src/agent-events/route");
      const { parseCspSampleRate } = await import("../src/csp-reports");
      imageHosts("*.evil.com");
      publicReadBudget({ E2E_PUBLIC_READ_BUDGET: "bogus" } as Env);
      ingressConfig({ AGENT_EVENTS_ROUTE_PER_MINUTE: "bogus" } as Env);
      parseCspSampleRate("typo");
    };

    vi.resetModules();
    const first = vi.spyOn(console, "warn").mockImplementation(() => {});
    await triggerAll();
    // One warn per setting: no setting suppresses another, unset siblings
    // stay silent.
    expect(first).toHaveBeenCalledTimes(4);
    first.mockRestore();

    // A fresh isolate warns again: dedup is per-isolate, not global-once.
    vi.resetModules();
    const second = vi.spyOn(console, "warn").mockImplementation(() => {});
    await triggerAll();
    expect(second).toHaveBeenCalledTimes(4);
  });

  it("docs/config.md rows for the four settings describe the warn", () => {
    const docs = readFileSync("docs/config.md", "utf8");
    for (const name of [
      "FEATURED_IMAGE_HOSTS",
      "E2E_PUBLIC_READ_BUDGET",
      "AGENT_EVENTS_ROUTE_PER_MINUTE",
      "CSP_REPORT_SAMPLE_RATE",
    ]) {
      const row = docs.split("\n").find((line) => line.includes(`\`${name}\``));
      expect(row, `docs row for ${name}`).toBeDefined();
      expect(row).toMatch(/warn/i);
    }
  });

  it("all four sites warn through one shared helper module", () => {
    const sites = [
      "src/image-policy.ts",
      "src/events/routes-shared.ts",
      "src/agent-events/route.ts",
      "src/csp-reports.ts",
    ];
    const relativeImports = (source: string): string[] => {
      const out: string[] = [];
      const re = /from\s+["'](\.[^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) out.push(m[1]!);
      return out;
    };
    const resolveToRepoPath = (fromFile: string, spec: string): string | null => {
      const base = join(dirname(fromFile), spec);
      for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
        try {
          readFileSync(candidate, "utf8");
          return candidate;
        } catch {
          // Try the next candidate.
        }
      }
      return null;
    };
    const importedBy = new Map<string, Set<string>>();
    for (const site of sites) {
      const source = readFileSync(site, "utf8");
      for (const spec of relativeImports(source)) {
        const target = resolveToRepoPath(site, spec);
        if (!target) continue;
        if (!importedBy.has(target)) importedBy.set(target, new Set());
        importedBy.get(target)!.add(site);
      }
    }
    const shared = [...importedBy.entries()]
      .filter(([, users]) => users.size === sites.length)
      .map(([target]) => target);
    expect(
      shared,
      "one helper module imported by all four sites (image-policy, routes-shared, agent-events/route, csp-reports)",
    ).not.toHaveLength(0);
    // The shared helper owns the warn: dedup + console.warn live there, so a
    // flood-cap change touches one file, not four call sites.
    const helperOwnsWarn = shared.some((target) =>
      readFileSync(target, "utf8").includes("console.warn"),
    );
    expect(helperOwnsWarn).toBe(true);
  });
});
