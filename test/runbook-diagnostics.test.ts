import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Offline documentation drift checks; runtime behavior has its own route fixtures.
const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
const deploy = runbook.split("## Deploy and record the rollback pointer")[1]!.split("### Worker rollback")[0]!;
const health = runbook.split("## Read `/up` without mistaking liveness for readiness")[1]!.split("## Neon / Hyperdrive outage behavior")[0]!;
const outage = runbook.split("## Neon / Hyperdrive outage behavior")[1]!.split("## Queue containment, drain and failed-job replay")[0]!;
const rows = outage.split("\n").filter((line) => line.startsWith("| "));
const retired = ["/health", "/healthz", "/db-ping"];

function routeRow(path: string) {
  const row = rows.find((line) => line.split("|")[1]!.includes(`\`${path}\``));
  expect(row, `outage row for ${path}`).toBeDefined();
  return row!;
}

describe("runbook diagnostic and homepage contract", () => {
  it("documents the deployed public-route smoke, not removed diagnostic probes", () => {
    expect(deploy).toMatch(/node bin\/smoke\.mjs https:\/\/next\.togetherweown\.com/);
    for (const path of retired) expect(deploy).not.toContain(`\`${path}\``);
    const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
    expect(workflow).toContain("node bin/smoke.mjs https://next.togetherweown.com");
  });

  it("explicitly retires all removed routes instead of listing them as outage diagnostics", () => {
    const retirement = health.split("\n\n").find((paragraph) => retired.every((path) => paragraph.includes(`\`${path}\``)));
    expect(retirement).toMatch(/retired[\s\S]*404/);
    for (const path of retired) {
      expect(rows.some((row) => row.split("|")[1]!.includes(`\`${path}\``))).toBe(false);
    }
  });

  it("keeps liveness and unknown queue evidence separate from readiness", () => {
    expect(health).toMatch(/always returns \*\*200\*\*/);
    expect(health).toMatch(/liveness[^.]*not[^.]*readiness/);
    expect(health).toContain("healthy + unknown");
    expect(health).toContain("lack of evidence");
    expect(routeRow("/up")).toMatch(/\*\*200\*\*.*`unknown`.*not readiness/);
  });

  it("distinguishes the guest homepage fallback from unavailable private writes", () => {
    const home = routeRow("/");
    expect(home).toMatch(/\*\*200\*\*.*guest/);
    expect(home).not.toMatch(/500|Not guaranteed/);
    expect(home).toMatch(/counts.*events.*featured/i);
    expect(routeRow("/events/:key")).toMatch(/500 HTML.*503 JSON/);
    expect(outage).toMatch(/public\s+fallback[^.]*not[^.]*private[^.]*writes/i);
  });

  it("labels readiness and broader outage PRs as pending rather than shipped", () => {
    expect(health).toMatch(/Pending[^\n]*\[#111\]\(https:\/\/github.com\/TogetherWeOwn\/two-web-next\/pull\/111\)/);
    expect(outage).toMatch(/Pending[^\n]*\[#92\]\(https:\/\/github.com\/TogetherWeOwn\/two-web-next\/pull\/92\)/);
    expect(health).not.toMatch(/curl\s|fetch\(/);
    expect(outage).not.toMatch(/curl\s|fetch\(/);
  });
});
