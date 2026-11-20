import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };
type Call = { command: string; args: string[] };

function workflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
}

function shellArguments(run: string | undefined, env: Record<string, string>): Call[] {
  if (!run) throw new Error("Expected a shell step");
  expect(run).not.toContain("${{");
  const scratch = mkdtempSync(join(tmpdir(), "workflow-argv-"));
  const log = join(scratch, "calls.jsonl");
  try {
    // Only record arguments: never invoke the real scripts, Wrangler, or npm.
    for (const command of ["node", "npx"]) {
      writeFileSync(
        join(scratch, command),
        String.raw`#!${process.execPath}
const command = "${command}";
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.ARGUMENT_LOG, JSON.stringify({ command, args }) + "\n");
// The npx stub is a pipeline producer; the node stub does not read stdin.
if (command === "node") {
  process.stdout.write(args.includes("--deploy-spec") ? "version@5%\ntag\n" : "version-id\n");
}
`,
        { mode: 0o700 },
      );
    }
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 5000,
      env: { ...env, PATH: scratch, ARGUMENT_LOG: log, GITHUB_OUTPUT: join(scratch, "output") },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("workflow source argument boundaries", () => {
  it.each([
    [
      "values with shell metacharacters",
      {
        KIT_ROUTE_ARCHIVE: "archive with spaces",
        KIT_ROUTE_STATIC: "static\twith a tab",
        KIT_ROUTE_EVENTS: 'events with "quotes"\nand a newline',
        KIT_ROUTE_HOME: "home with 'single quotes'",
        KIT_ROUTE_JOIN: 'join with "double quotes"\tand a tab',
      },
    ],
    [
      "the default-off Hono values",
      {
        KIT_ROUTE_ARCHIVE: "false",
        KIT_ROUTE_STATIC: "false",
        KIT_ROUTE_EVENTS: "false",
        KIT_ROUTE_HOME: "false",
        KIT_ROUTE_JOIN: "false",
      },
    ],
  ])("passes all five staging Kit route flags as single Wrangler arguments for %s", (_, flags) => {
    const steps = workflow("deploy").jobs["deploy-staging"]?.steps;
    const selector = steps?.find(({ id }) => id === "kit-route-flags");
    expect(selector?.env).toMatchObject({
      KIT_ROUTE_FAMILY: "${{ inputs.kit_route_family }}",
      KIT_STAGING_ROUTE_FAMILY:
        "${{ github.event_name == 'workflow_run' && vars.KIT_STAGING_ROUTE_FAMILY || '' }}",
    });
    const step = steps?.find(({ name }) => name === "Deploy to Cloudflare Workers");
    expect(step?.env).toMatchObject({
      KIT_ROUTE_ARCHIVE: "${{ steps.kit-route-flags.outputs.archive }}",
      KIT_ROUTE_STATIC: "${{ steps.kit-route-flags.outputs.static }}",
      KIT_ROUTE_EVENTS: "${{ steps.kit-route-flags.outputs.events || 'false' }}",
      KIT_ROUTE_HOME: "${{ steps.kit-route-flags.outputs.home || 'false' }}",
      KIT_ROUTE_JOIN: "${{ steps.kit-route-flags.outputs.join || 'false' }}",
    });
    const sha = "a".repeat(40);
    const calls = shellArguments(step?.run, { DEPLOY_SHA: sha, ...flags });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe("npx");
    const args = call?.args ?? [];
    expect(args.slice(0, 6)).toEqual([
      "wrangler",
      "deploy",
      "--config",
      "web/wrangler.staging.jsonc",
      "--tag",
      sha,
    ]);
    expect(args.slice(6)).toEqual(
      Object.entries(flags).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    );
  });

  it("passes the gradual-promote helper paths through each calling step's environment", () => {
    const action: { runs: { steps: Step[] } } = parse(
      readFileSync(".github/actions/gradual-promote/action.yml", "utf8"),
    );
    const promotionHelpers = ["gradual-promote.mjs", "pre-promotion-check.mjs"];
    const helpersByStep = {
      "rollback-target": ["gradual-promote.mjs"],
      "promoted-version": ["gradual-promote.mjs"],
      "deploy-5": promotionHelpers,
      "error-rate-5": ["error-rate-gate.mjs"],
      "deploy-50": promotionHelpers,
      "error-rate-50": ["error-rate-gate.mjs"],
      "deploy-100": promotionHelpers,
      "error-rate-100": ["error-rate-gate.mjs"],
    };
    const helperPath =
      /\$(?:ACTION_PATH|\{ACTION_PATH\})\/|\b(?:gradual-promote|pre-promotion-check|error-rate-gate)\.mjs\b/;
    const callers = action.runs.steps.filter(({ run }) => helperPath.test(run ?? ""));
    expect(callers.map(({ id }) => id).sort()).toEqual(Object.keys(helpersByStep).sort());

    const env = {
      ACTION_PATH: "/fixture/action with spaces",
      WORKER_NAME: "fixture worker",
      VERSION_TAG: "build tag 123",
      PREV_VERSION: "previous version",
    };
    for (const [id, helpers] of Object.entries(helpersByStep)) {
      const step = action.runs.steps.find((step) => step.id === id);
      expect(step, id).toBeDefined();
      expect(step?.env?.ACTION_PATH, id).toBe("${{ github.action_path }}");
      const calls = shellArguments(step?.run, env).filter(({ command }) => command === "node");
      expect(
        calls.map(({ args }) => args[0]),
        id,
      ).toEqual(helpers.map((name) => `${env.ACTION_PATH}/${name}`));
      for (const { args } of calls) {
        if (args[1] === "--resolve-tag") expect(args.slice(2)).toEqual([env.VERSION_TAG]);
        if (args[1] === "--deploy-spec") {
          expect(args).toHaveLength(5);
          expect(args[2]).toBe(env.VERSION_TAG);
          expect(args[4]).toBe(env.PREV_VERSION);
        }
      }
    }
  });

  it("keeps the validated staging scope inputs in env and quotes the shell arguments", () => {
    const scope = workflow("e2e-staging").jobs.scope?.steps?.find(({ id }) => id === "scope");
    expect(scope?.env).toMatchObject({
      HEAD_SHA: "${{ steps.candidate.outputs.sha }}",
      WORKFLOW_SHA: "${{ github.sha }}",
      EVENT_NAME: "${{ github.event_name }}",
    });
    expect(scope?.run).not.toContain("${{");
    expect(scope?.run).toContain('"$EVENT_NAME"');
    expect(scope?.run).toContain('"$HEAD_SHA" != "$WORKFLOW_SHA"');
    expect(scope?.run).toContain('"$HEAD_SHA~1" "$HEAD_SHA"');
  });

  it("does not interpolate expressions into the staging error-rate rehearsal script", () => {
    const rehearsal = Object.values(workflow("error-rate-gate-rehearsal").jobs)
      .flatMap(({ steps }) => steps ?? [])
      .find(({ name }) => name?.startsWith("Simulated elevated rate"));
    expect(rehearsal?.run).toEqual(expect.any(String));
    expect(rehearsal?.run).not.toContain("${{");
  });
});
