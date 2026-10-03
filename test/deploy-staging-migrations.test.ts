import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural contract of the staging deploy's migration steps (TOG-12965). The
// workflow itself only runs on main after CI, so these assertions pin what a
// green deploy relies on: the staging schema is applied from the CI-verified
// SHA before the first Cloudflare mutation, and a failed apply stops the job.
const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");

const stepNames = [...workflow.matchAll(/^ {6}- (?:name|uses|run): (.+)$/gm)].map((m) => m[1]);
const stepBlock = (name: string) => {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n {6}- /)[0];
  expect(block, `Missing workflow step: ${name}`).toBeDefined();
  return block as string;
};

const PLAN = "Plan staging web migrations (read-only journal diff)";
const GATE = "Re-verify exact-SHA full CI before staging migration";
const APPLY = "Apply staging web migrations (advisory lock, PITR timestamp)";
const VERIFY = "Verify zero pending staging web migrations";
const migration = [PLAN, GATE, APPLY, VERIFY];

describe("staging deploy applies web migrations before the Worker deploy", () => {
  it("runs plan, exact-SHA gate, apply, verify in order, after checks and before any Cloudflare step", () => {
    const at = (name: string) => {
      const index = stepNames.indexOf(name);
      expect(index, `Missing workflow step: ${name}`).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      "Require successful exact-SHA full CI",
      "npm run check",
      "Moderator role-config preflight (before any Cloudflare mutation)",
      ...migration,
      "Ensure queues exist",
      "Deploy alert Tail Worker before attaching the app",
      "Deploy to Cloudflare Workers",
      "Smoke test staging public routes",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The gate sits directly before the DDL it protects.
    expect(at(APPLY) - at(GATE)).toBe(1);
    // No wrangler (Cloudflare) command precedes the zero-pending verification.
    const verifyEnd = workflow.indexOf(stepBlock(VERIFY)) + stepBlock(VERIFY).length;
    expect(workflow.indexOf("npx wrangler")).toBeGreaterThan(verifyEnd);
  });

  it("runs the shared migration script with default success semantics so a failure stops the deploy", () => {
    expect(stepBlock(PLAN)).toContain("run: node ci/neon-migrate.mjs plan\n");
    expect(stepBlock(APPLY)).toContain("run: node ci/neon-migrate.mjs apply\n");
    expect(stepBlock(VERIFY)).toContain("run: node ci/neon-migrate.mjs verify");
    expect(stepBlock(GATE)).toContain("run: node ci/staging-deploy-gate.mjs\n");
    for (const name of migration) {
      expect(stepBlock(name)).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    }
    expect(workflow).not.toMatch(/if: (?:always|failure|cancelled)\(\)/);
    expect(workflow).not.toMatch(/continue-on-error/);
  });

  it("is staging only and exposes only the staging Environment secret to those steps", () => {
    const env = stepBlock(PLAN).split("        env: &staging-migration-env\n")[1];
    expect(env).toBeDefined();
    expect(env).toContain("          MIGRATION_TARGET: staging\n");
    expect(env).toContain(
      "          NEON_STAGING_DATABASE_URL: ${{ secrets.NEON_STAGING_DATABASE_URL }}\n",
    );
    // Release receipt names the CI-verified checkout, not workflow_run's main tip.
    expect(env).toContain(
      "GITHUB_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
    );
    for (const name of [APPLY, VERIFY]) {
      expect(stepBlock(name)).toMatch(/^ {8}env: \*staging-migration-env$/m);
    }
    // The secret appears only in the shared env anchor (key and expression), and
    // nothing production-shaped or fallback-shaped is reachable from this workflow.
    expect(workflow.match(/NEON_STAGING_DATABASE_URL/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /PRODUCTION_DATABASE_URL|PRODUCTION_DEPLOY_ENABLED|MIGRATION_TARGET: production|target: production|secrets: inherit/,
    );
    // The migration runs in this exact-SHA job, not in a reusable workflow that
    // would check out main's tip and run before the test suite.
    expect(workflow).not.toMatch(/^\s+uses: \.\/\.github\/workflows\//m);
  });

  it("keeps the staging Environment gate, serialized deploys and read-only token permissions", () => {
    expect(workflow).toMatch(/environment:\n {6}name: staging\n/);
    expect(workflow).toMatch(
      /concurrency:\n {6}group: deploy-staging\n {6}cancel-in-progress: false/,
    );
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read\n/m);
  });
});
