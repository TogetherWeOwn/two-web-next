import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { name?: string; steps?: Step[]; container?: unknown; services?: unknown }>;
};
const workflow = (name: string): Workflow =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
const action = parse(readFileSync(".github/actions/gradual-promote/action.yml", "utf8")) as {
  runs: { steps: Step[] };
};

function shellArguments(run: string, values: Record<string, string>) {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-boundaries-"));
  try {
    for (const command of ["node", "npx"]) {
      writeFileSync(
        join(scratch, command),
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.ARGUMENT_LOG, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + '\\n');
if (process.argv.includes('--deploy-spec')) process.stdout.write('version@5%\\ntag\\n');
else process.stdout.write('version-id\\n');
`,
        { mode: 0o700 },
      );
    }
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", run], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: scratch,
        BASH_ENV: "/dev/null",
        ENV: "/dev/null",
        ARGUMENT_LOG: join(scratch, "arguments"),
        GITHUB_OUTPUT: join(scratch, "output"),
        ...values,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(scratch, "INJECTED"))).toBe(false);
    return readFileSync(join(scratch, "arguments"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; args: string[] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const hostile = "space ' \" $(touch INJECTED) `touch INJECTED`;\nnext";

describe("workflow source data boundaries", () => {
  it("passes the composite's own path through step env and preserves quoted arguments", () => {
    const helpers = action.runs.steps.filter((step) => step.run?.includes("$ACTION_PATH/"));
    expect(helpers).toHaveLength(8);
    for (const step of helpers) {
      expect(step.env?.ACTION_PATH, step.name).toBe("${{ github.action_path }}");
      expect(step.run, step.name).not.toContain("${{");
      const calls = shellArguments(step.run!, {
        ACTION_PATH: hostile,
        VERSION_TAG: hostile,
        PREV_VERSION: hostile,
        WORKER_NAME: hostile,
      });
      const helper = calls.find((call) => call.command === "node")!;
      expect(helper.args[0], step.name).toMatch(
        new RegExp(
          `^${hostile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:gradual-promote|error-rate-gate)\\.mjs$`,
        ),
      );
      if (step.run?.includes("--resolve-tag")) expect(helper.args.slice(-1)).toEqual([hostile]);
      if (step.run?.includes("--deploy-spec")) {
        expect(helper.args[2]).toBe(hostile);
        expect(helper.args[4]).toBe(hostile);
      }
    }
  });

  it("passes validated staging route flags as single quoted arguments, not shell source", () => {
    const step = workflow("deploy").jobs["deploy-staging"]!.steps?.find(
      (candidate) => candidate.name === "Deploy to Cloudflare Workers",
    )!;
    expect(step.env?.KIT_ROUTE_ARCHIVE).toBe("${{ steps.kit-route-flags.outputs.archive }}");
    expect(step.env?.KIT_ROUTE_STATIC).toBe("${{ steps.kit-route-flags.outputs.static }}");
    expect(step.run).not.toContain("${{");
    const [call] = shellArguments(step.run!, {
      DEPLOY_SHA: "a".repeat(40),
      KIT_ROUTE_ARCHIVE: hostile,
      KIT_ROUTE_STATIC: hostile,
    });
    expect(call!.args.slice(-4)).toEqual([
      "--var",
      `KIT_ROUTE_ARCHIVE:${hostile}`,
      "--var",
      `KIT_ROUTE_STATIC:${hostile}`,
    ]);
  });

  it("keeps scope event/SHA, rehearsal version and performance results in step environments", () => {
    const scope = workflow("e2e-staging").jobs.scope!.steps?.find((step) => step.id === "scope")!;
    expect(scope.env?.HEAD_SHA).toContain("github.event.workflow_run.head_sha");
    expect(scope.env?.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(scope.run).not.toContain("${{");
    expect(scope.run).toContain('"$HEAD_SHA~1"');
    expect(scope.run).toContain('"$EVENT_NAME"');
    const rehearsal = Object.values(workflow("error-rate-gate-rehearsal").jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name?.startsWith("Simulated elevated rate"))!;
    expect(rehearsal.env?.SIM_VERSION).toBe("${{ steps.staging-version.outputs.id }}");
    expect(rehearsal.run).not.toContain("${{");
    const performance = workflow("ci").jobs["ci-ok"]!.steps?.find((step) =>
      step.run?.startsWith("node ci/require-performance.mjs"),
    )!;
    expect(performance.env?.LIGHTHOUSE_RESULT).toBe("${{ needs.lighthouse.result }}");
    expect(performance.env?.BUDGET_RESULT).toBe("${{ needs.bundle-budget.result }}");
    expect(performance.run).toBe(
      'node ci/require-performance.mjs "$LIGHTHOUSE_RESULT" "$BUDGET_RESULT"',
    );
  });

  it("serializes origin quality across callers and standalone events without recursive locks", () => {
    const quality = workflow("web-quality-origin");
    expect(quality.concurrency).toEqual({
      group: "web-quality-origin-${{ inputs.origin || 'https://next.togetherweown.com' }}",
      "cancel-in-progress": false,
    });
    const caller = workflow("e2e-staging");
    expect(caller.concurrency?.group).not.toContain("web-quality-origin");
    expect(quality.concurrency?.group).not.toMatch(
      /github\.workflow|github\.ref|pull_request|run_id/,
    );
  });

  it("uses an isolated locked Playwright runtime matching the unchanged browser image", () => {
    const manifest = JSON.parse(readFileSync("ci/featured-proof/runtime/package.json", "utf8"));
    const lock = JSON.parse(readFileSync("ci/featured-proof/runtime/package-lock.json", "utf8"));
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ playwright: "1.58.2" });
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages["node_modules/playwright"].version).toBe("1.58.2");
    expect(lock.packages["node_modules/playwright-core"].version).toBe("1.58.2");
    for (const dependency of Object.values(lock.packages) as {
      resolved?: string;
      integrity?: string;
    }[]) {
      if (dependency.resolved) expect(dependency.integrity).toMatch(/^sha512-/);
    }
    const proof = workflow("featured-offline-proof");
    for (const id of ["capture", "current-source"]) {
      const job = proof.jobs[id]!;
      expect(job.container).toEqual({
        image:
          "mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d",
        options: "--init --ipc=host",
      });
      const install = job.steps?.find((step) =>
        step.run?.includes('npm ci --prefix "$RUNNER_TEMP/featured-runtime"'),
      )!;
      expect(install.run).toContain(
        'cp ci/featured-proof/runtime/package.json ci/featured-proof/runtime/package-lock.json "$RUNNER_TEMP/featured-runtime/"',
      );
      expect(install.run).toContain("--ignore-scripts --no-audit --no-fund");
      expect(install.run).not.toContain("npm install");
    }
  });

  it("pins official images without changing the declared runtime tags or Postgres major", () => {
    const expected: Record<string, string> = {
      "node:24-bookworm": "e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
      "node:22.23.0-bookworm": "e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a",
      "python:3.13-bookworm": "3856e3e7bf4d0ba061501a84ed2eb0d429663307c0f54f191dc4de03c7081c3e",
      "postgres:17": "3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1",
      "postgres:18": "3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81",
    };
    const files = [
      "ci",
      "backup-bootstrap-selftest",
      "backup-restore-proof",
      "e2e",
      "staging-smoke",
    ];
    let images = 0;
    for (const name of files) {
      const text = readFileSync(`.github/workflows/${name}.yml`, "utf8");
      for (const match of text.matchAll(
        /(?:image|container): ((?:node|python|postgres):[^\s@]+)@sha256:([0-9a-f]{64})/g,
      )) {
        expect(match[2], `${name}: ${match[1]}`).toBe(expected[match[1]!]);
        images += 1;
      }
      expect(text).not.toMatch(/(?:image|container): (?:node|python|postgres):[^\s@]+\s*\n/);
    }
    expect(images).toBe(11);
    expect(workflow("ci").jobs.check!.services).toHaveProperty(
      "postgres.image",
      `postgres:17@sha256:${expected["postgres:17"]}`,
    );
  });
});
