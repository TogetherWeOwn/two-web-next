import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import worker from "../ci/lighthouse-worker";
import { auditPaths, fixtureKey } from "../ci/lighthouse-paths";

const require = createRequire(import.meta.url);
const config = require("../ci/lighthouserc.cjs").ci;
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function request(path: string, method = "GET") {
  // The wrapper must not trust/inherit even a mistakenly injected live binding.
  return worker.fetch(new Request(`http://127.0.0.1:8787${path}`, { method }), {
    DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
    DB: { connectionString: "postgres://must-not-connect.invalid/forbidden" },
    DISCORD_BOT_TOKEN: "must-not-use",
  }, context);
}

describe("performance CI", () => {
  it("measures all five real public pages, not error pages or redirects", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound fetch"));
    try {
      for (const path of auditPaths) {
        const response = await request(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("location"), path).toBeNull();
        expect(response.headers.get("content-type"), path).toContain("text/html");
        const html = await response.text();
        expect(html, path).toContain("/styles.css");
        if (path === "/events" || path.startsWith("/e/")) {
          expect(html).toContain("Lighthouse fixture game night");
          expect(html).toContain(fixtureKey);
        }
        if (path === "/join") expect(html).not.toContain("<iframe");
      }
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
  });

  it("blocks OAuth, mutations and nonfixture routes", async () => {
    for (const path of ["/auth/discord", "/auth/discord/callback?code=fixture", "/events?q=search", "/admin"]) {
      expect((await request(path)).status).toBe(404);
    }
    expect((await request("/join", "POST")).status).toBe(404);
    expect((await request("/e/01ARZ3NDEKTSV4RRFFQ69G5FAA")).status).toBe(404);
  });

  it("pins legacy public thresholds, median sampling and the phone profile", () => {
    expect(config.collect.url).toEqual(auditPaths.map((path) => `http://127.0.0.1:8787${path}`));
    expect(config.collect.numberOfRuns).toBe(3);
    expect(config.assert.assertions).toEqual({
      "largest-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median" }],
      "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median" }],
      "server-response-time": ["error", { maxNumericValue: 600, aggregationMethod: "median" }],
      "total-blocking-time": ["warn", { maxNumericValue: 300, aggregationMethod: "median" }],
      "first-contentful-paint": ["warn", { maxNumericValue: 1800, aggregationMethod: "median" }],
    });
    expect(config.collect.settings.formFactor).toBe("mobile");
    expect(config.collect.settings.screenEmulation).toEqual({
      mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false,
    });
    expect(config.collect.settings.throttlingMethod).toBe("simulate");
    expect(config.collect.settings.throttling).toEqual({
      rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4,
      requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675,
    });
    expect(config.upload.target).toBe("filesystem");
  });

  it.each([
    ["largest-contentful-paint", 2001],
    ["cumulative-layout-shift", 0.11],
  ])("blocks the required check after a real LHCI %s assertion failure", (audit, numericValue) => {
    const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "performance-assert-"));
    try {
      const audits = Object.fromEntries(Object.keys(config.assert.assertions)
        .map((key) => [key, { numericValue: 0 }]));
      audits[audit] = { numericValue };
      const report = join(root, "report.json");
      writeFileSync(report, JSON.stringify({ finalUrl: "http://127.0.0.1:8787/events", audits }));
      // Real assertion command and production thresholds; no collection/network.
      const assertion = spawnSync(process.execPath, [resolve("node_modules/.bin/lhci"), "assert",
        "--config", resolve("ci/lighthouserc.cjs"), "--lhr", report], { cwd: root, encoding: "utf8" });
      expect(assertion.status, assertion.stdout + assertion.stderr).toBe(1);
      expect(assertion.stdout + assertion.stderr).toContain(audit);
      const gate = spawnSync(process.execPath, [resolve("ci/require-performance.mjs"),
        assertion.status === 0 ? "success" : "failure", "success"], { encoding: "utf8" });
      expect(gate.status, gate.stdout + gate.stderr).toBe(1);
      expect(gate.stderr).toContain("lighthouse did not succeed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires both performance results into the always-running required check", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const check = workflow.split("\n  check:\n")[1]!.split("\n  bundle-budget:\n")[0]!;
    expect(check).toContain("name: check");
    expect(check).toContain("needs: [a11y, lighthouse, bundle-budget]");
    expect(check).toContain("if: always()");
    expect(check).toContain('node ci/require-performance.mjs "${{ needs.lighthouse.result }}" "${{ needs.bundle-budget.result }}"');
  });

  it("uses a standalone local-only Wrangler config", () => {
    const raw = readFileSync(new URL("../ci/wrangler.lighthouse.jsonc", import.meta.url), "utf8");
    const wrangler = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    expect(wrangler.main).toBe("./lighthouse-worker.ts");
    expect(wrangler.assets.directory).toBe("../public");
    for (const remote of ["hyperdrive", "queues", "routes", "triggers", "vars", "services"]) {
      expect(wrangler).not.toHaveProperty(remote);
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["dev:lighthouse"]).toContain("--local --ip 127.0.0.1 --port 8787");
    expect(config.collect.startServerCommand).toBe("npm run dev:lighthouse");
  });
});
