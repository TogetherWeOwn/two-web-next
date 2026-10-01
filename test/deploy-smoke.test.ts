import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the workflow's actual shell block with a fake checker and sleep.
// The checker itself has loopback-fixture coverage in smoke.test.mjs.
function smoke(succeedOnAttempt: number) {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(/      - name: Smoke test staging public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "route-smoke-"));
  try {
    writeFileSync(join(scratch, "node"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
if (process.argv.length !== 4 || process.argv[2] !== "bin/smoke.mjs" || process.argv[3] !== "https://next.togetherweown.com") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
const count = readFileSync(attempts, "utf8").length;
const pass = count === Number(process.env.SMOKE_SUCCEED_ON_ATTEMPT);
console.log(pass ? "smoke: 16 routes, 0 failed assertions" : "FAIL /faq: expected HTTP 200; actual HTTP 503");
process.exit(pass ? 0 : 1);
`, { mode: 0o700 });
    writeFileSync(join(scratch, "sleep"), "#!/bin/sh\nprintf x >> \"$RUNNER_TEMP/sleeps\"\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(scratch, "sleeps"), "");
    writeFileSync(join(scratch, "attempts"), "");
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only our fakes are on PATH: no real network request or retry delay.
    const result = spawnSync(bash.stdout.trim(), ["-e", "-c", block!.replace(/^          /gm, "")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: scratch,
        RUNNER_TEMP: scratch,
        SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: readFileSync(join(scratch, "attempts"), "utf8").length,
      sleeps: readFileSync(join(scratch, "sleeps"), "utf8").length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("deploy public-route smoke (offline)", () => {
  it.each([1, 3, 6])("stops on successful attempt %s", (attempt) => {
    const result = smoke(attempt);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(attempt);
    expect(result.sleeps).toBe(attempt - 1);
    expect(result.output).toContain(`staging smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = smoke(0);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL /faq: expected HTTP 200; actual HTTP 503");
    expect(result.output).toContain("::error::staging public-route smoke failed after deploy");
    expect(result.output).not.toContain("unexpected checker invocation");
  });

  it("runs the loopback selftest in required CI as well as pre-deploy check", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const checkJob = ci.slice(ci.indexOf("  check:\n"));
    expect(checkJob).toMatch(/      - name: Public-route smoke selftest \(loopback fixtures\)\n        run: npm run test:smoke\n/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.check).toContain("npm run test:smoke");
    expect(pkg.scripts["test:smoke"]).toBe("node --test test/smoke.test.mjs");
  });
});
