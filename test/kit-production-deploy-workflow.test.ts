import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source contracts for the delivered slice only: deploy-production.yml gains a
// validated kit_route_family input (not consumed by any deploy step), and
// rollback-production.yml gains a read-only dry run. Production Kit upload, a
// fail-closed verified pure-Hono pointer and same-byte bundle receipts for Kit
// are UNIMPLEMENTED.

const deploy = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const rollback = readFileSync(".github/workflows/rollback-production.yml", "utf8");
const staging = readFileSync(".github/workflows/deploy.yml", "utf8");

const section = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
};

const preflightJob = section(deploy, "\n  preflight:\n", "\n  staging-soak:\n");

describe("production Kit route family selection", () => {
  it("mirrors the staging dispatch input with hono as the default", () => {
    expect(deploy).toMatch(/workflow_dispatch:\n\s+inputs:[\s\S]*?\n\s+kit_route_family:/);
    const input = section(deploy, "      kit_route_family:\n", "  workflow_run:");
    expect(input).toContain("default: hono");
    expect(input).toContain("- hono\n          - archive\n          - archive-static");
    expect(staging).toContain("- hono\n          - archive\n          - archive-static");
  });

  it("validates the family with the shared helper before any approval, off on automatic runs", () => {
    const step = section(preflightJob, "      - name: Select and validate Kit route families\n");
    expect(step).toContain("id: kit-route-flags");
    expect(step).toContain(
      "run: |\n          set -euo pipefail\n          node ci/kit-route-flags.mjs",
    );
    expect(step).toContain(
      "KIT_ROUTE_FAMILY: ${{ github.event_name == 'workflow_dispatch' && inputs.kit_route_family || 'hono' }}",
    );
    expect(step).not.toMatch(/run:[^\n]*\$\{\{ inputs\./);
    for (const output of ["kit_route_family", "kit_archive", "kit_static"]) {
      expect(preflightJob).toContain(`${output}: \${{ steps.kit-route-flags.outputs.`);
    }
  });
});

describe("production deploy is unchanged apart from the validated input", () => {
  it("still uploads the Hono build and consumes no Kit flag", () => {
    // Kit upload is intentionally not implemented here: the input is only
    // validated, so nothing that deploys reads the flags yet.
    const deployJob = section(deploy, "\n  deploy-production:\n", "\n  post-deploy-watch:\n");
    expect(deployJob).toContain("npx wrangler versions upload --env production --tag ");
    expect(deployJob).toContain("--no-bundle dist-production/worker.js");
    expect(deployJob).not.toMatch(/KIT_ROUTE|kit_archive|kit_static|wrangler\.production\.jsonc/);
  });
});

describe("rollback-production dry run", () => {
  const rollbackJob = section(rollback, "\n  rollback-production:\n", "\n  notify:\n");

  it("declares a boolean dry_run input defaulting to false on dispatch and call", () => {
    const declaration =
      /\n {6}dry_run:\n {8}description: [^\n]+\n {8}required: false\n {8}type: boolean\n {8}default: false\n/g;
    expect(rollback.match(declaration)).toHaveLength(2);
  });

  it("skips the rollback, smoke and notification but keeps every validation gate", () => {
    expect(rollbackJob).toContain(
      "if: steps.guard.outputs.action == 'rollback' && inputs.dry_run != true",
    );
    const smoke = section(
      rollbackJob,
      "      - name: Smoke test public routes on the rolled-back version\n",
    );
    expect(smoke).toContain("if: ${{ inputs.dry_run != true }}");
    expect(section(rollback, "\n  notify:\n")).toContain(
      "if: ${{ always() && inputs.environment == 'production' && inputs.dry_run != true }}",
    );
    const report = section(
      rollbackJob,
      "      - name: Dry run report (read-only; stops before any rollback)\n",
      "      - name: Capture pre-rollback dead-letter baseline\n",
    );
    expect(report).toContain("if: ${{ inputs.dry_run == true }}");
    expect(report).toContain("wrangler deployments list");
    expect(report).not.toMatch(/wrangler (?:deploy\b|rollback\b|versions)|migrate/);
    const order = [
      "node ci/production-deploy-gate.mjs --rollback",
      "node ci/production-deploy-gate.mjs --version-id",
      "node ci/production-deploy-gate.mjs --credentials",
      "node ci/check-production-secrets.mjs --rollback-version",
      "- name: Dry run report",
      "npx wrangler rollback",
    ].map((marker) => rollbackJob.indexOf(marker));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
