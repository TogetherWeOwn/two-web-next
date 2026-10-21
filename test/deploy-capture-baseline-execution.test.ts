import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute deploy.yml's actual "Capture pre-deploy dead-letter baseline" shell
// block with a fake node/sleep. The string pin in deploy-smoke.test.ts asserts
// the block's substrings but never runs it: an inverted emptiness test or a
// dropped break keeps every pinned string yet breaks the retry contract, so
// this file runs the block and pins its behavior. No network here: only the
// fakes are on PATH, and the fake node answers the /up fetch from env.
function runCaptureBlock(succeedOnAttempt: number, failedCount: number) {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(
    /- name: Capture pre-deploy dead-letter baseline\n[\s\S]*?run: \|\n((?:          .*\n)+)/,
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
if (process.argv.length !== 4 || process.argv[2] !== "-e" || !process.argv[3].includes("next.togetherweown.com/up")) {
  console.error("unexpected node invocation");
  process.exit(2);
}
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
const count = readFileSync(attempts, "utf8").length;
if (count === Number(process.env.CAPTURE_SUCCEED_ON_ATTEMPT)) {
  process.stdout.write(String(process.env.CAPTURE_FAILED_COUNT));
}
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(scratch, "sleep"),
      '#!/bin/sh\nprintf x >> "$RUNNER_TEMP/sleeps"\nexit 0\n',
      { mode: 0o700 },
    );
    writeFileSync(join(scratch, "sleeps"), "");
    writeFileSync(join(scratch, "attempts"), "");
    writeFileSync(join(scratch, "github-output"), "");
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
          CAPTURE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
          CAPTURE_FAILED_COUNT: String(failedCount),
        },
      },
    );
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: readFileSync(join(scratch, "attempts"), "utf8").length,
      sleeps: readFileSync(join(scratch, "sleeps"), "utf8").length,
      stepOutput: readFileSync(join(scratch, "github-output"), "utf8"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("deploy dead-letter baseline capture block", () => {
  it("writes the fetched failed count and stops after the first success", () => {
    const run = runCaptureBlock(1, 3);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(1);
    expect(run.sleeps).toBe(0);
    expect(run.stepOutput).toContain("failed=3");
    expect(run.output).toContain("dead-letter baseline: 3");
    expect(run.output).not.toContain("::warning::");
  });

  it("retries unreadable baselines until one reads", () => {
    const run = runCaptureBlock(3, 7);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(3);
    expect(run.sleeps).toBe(2);
    expect(run.stepOutput).toContain("failed=7");
    expect(run.output).toContain("dead-letter baseline: 7");
    expect(run.output).not.toContain("::warning::");
  });

  it("treats a healthy zero failed count as a readable baseline", () => {
    // The block's emptiness test must accept "0": it is a healthy empty
    // queue, not an unreadable baseline. A numeric comparison here would
    // misclassify it and silently degrade the dead-letter gate to
    // skip-on-history instead of enforcing growth past zero.
    const run = runCaptureBlock(1, 0);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(1);
    expect(run.sleeps).toBe(0);
    expect(run.stepOutput).toContain("failed=0");
    expect(run.output).toContain("dead-letter baseline: 0");
    expect(run.output).not.toContain("::warning::");
  });

  it("leaves the baseline empty with a warning after five unreadable attempts, without failing the deploy", () => {
    const run = runCaptureBlock(99, 0);
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(5);
    expect(run.sleeps).toBe(4);
    expect(run.stepOutput).toContain("failed=\n");
    expect(run.stepOutput).not.toContain("failed=0");
    expect(run.output).toContain("::warning::dead-letter baseline unreadable");
    expect(run.output).toContain("dead-letter baseline: unknown");
  });
});
