import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the staging workflow's actual shell block with a fake checker and sleep.
// The checker itself has loopback-fixture coverage in smoke.test.mjs.
function stagingSmoke(succeedOnAttempt: number) {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(
    /      - name: Smoke test staging public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "route-smoke-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "node"),
      `#!${process.execPath}
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
          PATH: scratch,
          RUNNER_TEMP: scratch,
          SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
        },
      },
    );
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

// Execute the production workflow's actual public-route shell block with a fake
// checker and sleep, mirroring the staging helper. The checker itself has
// loopback-fixture coverage in smoke.test.mjs: no production requests here.
function productionSmoke(succeedOnAttempt: number) {
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const block = workflow.match(
    /      - name: Smoke test production public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "prod-route-smoke-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "node"),
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
if (process.argv.length !== 5 || process.argv[2] !== "bin/smoke.mjs" || process.argv[3] !== "https://togetherweown.com" || process.argv[4] !== "--allow-indexable") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
const count = readFileSync(attempts, "utf8").length;
const pass = count === Number(process.env.SMOKE_SUCCEED_ON_ATTEMPT);
console.log(pass ? "smoke: 16 routes, 0 failed assertions" : "FAIL /faq: expected HTTP 200; actual HTTP 503");
process.exit(pass ? 0 : 1);
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
          PATH: scratch,
          RUNNER_TEMP: scratch,
          SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
        },
      },
    );
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
    const result = stagingSmoke(attempt);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(attempt);
    expect(result.sleeps).toBe(attempt - 1);
    expect(result.output).toContain(`staging smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = stagingSmoke(0);
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
    expect(checkJob).toMatch(
      /      - name: Public-route smoke selftest \(loopback fixtures\)\n(?:        if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)\n)?        run: npm run test:smoke\n/,
    );
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.check).toContain("npm run test:smoke");
    expect(pkg.scripts["test:smoke"]).toBe(
      "node --test test/smoke.test.mjs test/json-smoke.test.mjs test/revision-check.test.mjs",
    );
  });
});

// Execute the staging workflow's actual JSON-contract shell block with a fake
// checker and sleep. The checker itself has loopback-fixture coverage in
// test/json-smoke.test.mjs.
function stagingJsonSmoke(succeedOnAttempt: number, withToken: boolean) {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const block = workflow.match(
    /      - name: Smoke test staging event JSON contract\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "json-smoke-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "node"),
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
if (process.argv.length !== 4 || process.argv[2] !== "bin/json-smoke.mjs" || process.argv[3] !== "https://next.togetherweown.com") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
if (!process.env.QA_AUTH_TOKEN) {
  console.error("checker ran without QA_AUTH_TOKEN");
  process.exit(2);
}
const count = readFileSync(attempts, "utf8").length;
const pass = count === Number(process.env.SMOKE_SUCCEED_ON_ATTEMPT);
console.log(pass ? "json-smoke: 8 checks, 0 failed, 0 skipped" : "FAIL JSON show: expected HTTP 200 show; actual HTTP 503");
process.exit(pass ? 0 : 1);
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
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only our fakes are on PATH: no real network request or retry delay.
    // The workflow block must read the token from its own env mapping, never
    // from the test's ambient environment.
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: scratch,
      RUNNER_TEMP: scratch,
      SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
    };
    delete env.QA_AUTH_TOKEN;
    if (withToken) env.QA_AUTH_TOKEN = "fixture-token-never-log-this";
    const result = spawnSync(
      bash.stdout.trim(),
      ["-e", "-c", block!.replace(/^          /gm, "")],
      {
        encoding: "utf8",
        timeout: 5000,
        env,
      },
    );
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

describe("deploy event-JSON smoke (offline)", () => {
  it("passes the token only through the workflow env mapping", () => {
    const result = stagingJsonSmoke(1, true);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.output).toContain("staging json-smoke ok (attempt 1)");
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("checker ran without QA_AUTH_TOKEN");
    expect(result.output).not.toContain("never-log-this");
    expect(result.output).not.toContain("::error::");
  });

  it("skips visibly without the token instead of failing the deploy", () => {
    const result = stagingJsonSmoke(0, false);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(0);
    expect(result.output).toContain("json-smoke skipped: staging QA_AUTH_TOKEN is not configured");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = stagingJsonSmoke(0, true);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL JSON show: expected HTTP 200 show; actual HTTP 503");
    expect(result.output).toContain("::error::staging event-JSON smoke failed after deploy");
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("never-log-this");
  });
});

describe("production deploy smoke (offline)", () => {
  it.each([1, 3, 6])("stops on successful attempt %s", (attempt) => {
    const result = productionSmoke(attempt);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(attempt);
    expect(result.sleeps).toBe(attempt - 1);
    expect(result.output).toContain(`production smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = productionSmoke(0);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL /faq: expected HTTP 200; actual HTTP 503");
    expect(result.output).toContain("::error::production public-route smoke failed after deploy");
    expect(result.output).not.toContain("unexpected checker invocation");
  });

  it("probes the apex origin with the indexable posture, never staging", () => {
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const block = workflow.match(
      /      - name: Smoke test production public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain("node bin/smoke.mjs https://togetherweown.com --allow-indexable");
    expect(block).not.toContain("next.togetherweown.com");
  });

  it("stays on standard hosted runners with no secrets", () => {
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const block = workflow.match(
      /      - name: Smoke test production public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).not.toMatch(/secrets\./);
    expect(block).not.toMatch(/self-hosted/);
  });
});
