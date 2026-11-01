import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the dead-letter baseline capture shell blocks from all three
// workflows with a fake node/sleep. The string pins (deploy-smoke,
// probe-workflows) assert the blocks' substrings but never run them: an
// inverted emptiness test or a dropped break keeps every pinned string yet
// breaks the retry contract, so this file runs each block and pins its
// behavior. No network here: only the fakes are on PATH, and the fake node
// executes the block's real `node -e` fetch/validate program with fetch
// stubbed to canned /up JSON, so validation mutants (a `> 0` comparison, a
// dropped `>= 0` lower bound, a mistyped field, a dropped type check) fail
// loudly instead of surviving.
interface CaptureTarget {
  workflow: string;
  stepName: string;
  host: string;
  sink: "output" | "env";
  outputKey: string;
  env?: Record<string, string>;
}

const TARGETS: CaptureTarget[] = [
  {
    workflow: ".github/workflows/deploy.yml",
    stepName: "Capture pre-deploy dead-letter baseline",
    host: "next.togetherweown.com/up",
    sink: "output",
    outputKey: "failed",
  },
  {
    workflow: ".github/workflows/deploy-production.yml",
    stepName: "Capture pre-promote dead-letter baseline",
    host: "togetherweown.com/up",
    sink: "env",
    outputKey: "SMOKE_FAILED_BASELINE",
  },
  {
    workflow: ".github/workflows/rollback-production.yml",
    stepName: "Capture pre-rollback dead-letter baseline",
    // The rollback reads the environment's origin from ci/rollback-target.mjs.
    host: 'new URL("/up", process.env.ROLLBACK_ORIGIN)',
    sink: "output",
    outputKey: "failed",
    env: { ROLLBACK_ORIGIN: "https://togetherweown.com" },
  },
];

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCaptureBlock(
  target: CaptureTarget,
  succeedOnAttempt: number,
  failedCount: number,
  opts: { nodeExitOnAttempt?: number } = {},
) {
  const workflow = readFileSync(target.workflow, "utf8");
  const block = workflow.match(
    new RegExp(
      `- name: ${escapeRegExp(target.stepName)}\n[\\s\\S]*?run: \\|\\n((?:          .*\\n)+)`,
    ),
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "capture-baseline-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "node"),
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.length !== 4 || process.argv[2] !== "-e" || !process.argv[3].includes(${JSON.stringify(target.host)})) {
  console.error("unexpected node invocation");
  process.exit(2);
}
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
const count = readFileSync(attempts, "utf8").length;
if (count === Number(process.env.CAPTURE_NODE_EXIT_ON_ATTEMPT)) {
  process.exit(1);
}
const succeedOn = Number(process.env.CAPTURE_SUCCEED_ON_ATTEMPT);
const failed = Number(process.env.CAPTURE_FAILED_COUNT);
// Canned /up answers per attempt. The success attempt returns a healthy
// payload; earlier attempts fail the way a real outage does, except attempts
// 2, 4 and 5, which return malformed payloads the validation must reject: a
// string count, a float count and a negative count (the float kills a dropped
// Number.isInteger check, the negative kills a dropped f >= 0 lower bound;
// dropping the typeof check alone is unobservable because isInteger already
// implies it).
globalThis.fetch = async () => {
  if (count === succeedOn) {
    return { json: async () => ({ queue: { failed } }) };
  }
  if (count === 2) {
    return { json: async () => ({ queue: { failed: "bogus" } }) };
  }
  if (count === 4) {
    return { json: async () => ({ queue: { failed: 2.5 } }) };
  }
  if (count === 5) {
    return { json: async () => ({ queue: { failed: -1 } }) };
  }
  throw new Error("fetch failed");
};
// Run the block's real program, then flush its promise chain before exiting.
eval(process.argv[3]);
await new Promise((resolve) => setImmediate(resolve));
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(scratch, "sleep"),
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$RUNNER_TEMP/sleeps"\nexit 0\n',
      { mode: 0o700 },
    );
    writeFileSync(join(scratch, "sleeps"), "");
    writeFileSync(join(scratch, "attempts"), "");
    writeFileSync(join(scratch, "github-output"), "");
    writeFileSync(join(scratch, "github-env"), "");
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only our fakes are on PATH: no real network request or retry delay.
    const result = spawnSync(
      bash.stdout.trim(),
      ["-e", "-c", block!.replace(/^          /gm, "")],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          // This container exports BASH_ENV pointing at a profile that
          // reassigns PATH, which would drop the fakes below and send real
          // network requests plus real 5s sleeps. Neutralize both profile
          // hooks so only our fakes are on PATH.
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
          PATH: scratch,
          RUNNER_TEMP: scratch,
          GITHUB_OUTPUT: join(scratch, "github-output"),
          GITHUB_ENV: join(scratch, "github-env"),
          CAPTURE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
          CAPTURE_FAILED_COUNT: String(failedCount),
          CAPTURE_NODE_EXIT_ON_ATTEMPT: String(opts.nodeExitOnAttempt ?? -1),
          ...target.env,
        },
      },
    );
    expect(result.error).toBeUndefined();
    const sleepsRaw = readFileSync(join(scratch, "sleeps"), "utf8");
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: readFileSync(join(scratch, "attempts"), "utf8").length,
      sleepDelays: sleepsRaw.length === 0 ? [] : sleepsRaw.trimEnd().split("\n"),
      stepOutput: readFileSync(join(scratch, "github-output"), "utf8"),
      stepEnv: readFileSync(join(scratch, "github-env"), "utf8"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.each(TARGETS)("$stepName ($workflow)", (target) => {
  const sinkOf = (run: { stepOutput: string; stepEnv: string }) =>
    target.sink === "env" ? run.stepEnv : run.stepOutput;

  it("writes the fetched failed count and stops after the first success", () => {
    const run = runCaptureBlock(target, 1, 3);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(1);
    expect(run.sleepDelays).toEqual([]);
    expect(sinkOf(run)).toContain(`${target.outputKey}=3`);
    expect(run.output).toContain("dead-letter baseline: 3");
    expect(run.output).not.toContain("::warning::");
    if (target.sink === "env") {
      expect(run.stepEnv).toContain("SMOKE_ALLOW_MISSING_BASELINE=1");
    }
  });

  it("retries unreadable baselines until one reads", () => {
    const run = runCaptureBlock(target, 3, 7);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(3);
    expect(run.sleepDelays).toEqual(["5", "5"]);
    expect(sinkOf(run)).toContain(`${target.outputKey}=7`);
    expect(run.output).toContain("dead-letter baseline: 7");
    expect(run.output).not.toContain("::warning::");
  });

  it("treats a healthy zero failed count as a readable baseline", () => {
    // The block's emptiness test must accept "0": it is a healthy empty
    // queue, not an unreadable baseline. A numeric comparison here would
    // misclassify it and silently degrade the dead-letter gate to
    // skip-on-history instead of enforcing growth past zero.
    const run = runCaptureBlock(target, 1, 0);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(1);
    expect(run.sleepDelays).toEqual([]);
    expect(sinkOf(run)).toContain(`${target.outputKey}=0`);
    expect(run.output).toContain("dead-letter baseline: 0");
    expect(run.output).not.toContain("::warning::");
  });

  it("leaves the baseline empty with a warning after five unreadable attempts, without failing the deploy", () => {
    const run = runCaptureBlock(target, 99, 0);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(5);
    expect(run.sleepDelays).toEqual(["5", "5", "5", "5"]);
    expect(sinkOf(run)).toContain(`${target.outputKey}=\n`);
    expect(sinkOf(run)).not.toContain(`${target.outputKey}=0`);
    expect(run.output).toContain("::warning::dead-letter baseline unreadable");
    expect(run.output).toContain("dead-letter baseline: unknown");
    if (target.sink === "env") {
      expect(run.stepEnv).toContain("SMOKE_ALLOW_MISSING_BASELINE=1");
    }
  });

  it("tolerates a node crash on one attempt without failing the deploy", () => {
    // The block's `|| true` keeps a non-zero node exit from tripping
    // `set -e`: attempt 1 crashes, attempt 2 reads, the deploy continues.
    const run = runCaptureBlock(target, 2, 7, { nodeExitOnAttempt: 1 });
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(2);
    expect(run.sleepDelays).toEqual(["5"]);
    expect(sinkOf(run)).toContain(`${target.outputKey}=7`);
    expect(run.output).toContain("dead-letter baseline: 7");
    expect(run.output).not.toContain("::warning::");
  });
});
