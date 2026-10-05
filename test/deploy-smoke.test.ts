import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
          // This container exports BASH_ENV pointing at a profile that
          // reassigns PATH, which would drop the fakes below and send real
          // network requests plus real 10s sleeps. Neutralize both profile
          // hooks so only our fakes are on PATH.
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
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
          // This container exports BASH_ENV pointing at a profile that
          // reassigns PATH, which would drop the fakes below and send real
          // network requests plus real 10s sleeps. Neutralize both profile
          // hooks so only our fakes are on PATH.
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
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
type JsonSmokeLedger = {
  summary: { total: number; passed: number; failed: number; skipped: number };
  checks: { check: string; status: string; reason?: string }[];
} | null;

function stagingJsonSmoke(
  succeedOnAttempt: number,
  withToken: boolean,
  ledgerSkips: string[] = [],
) {
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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "bin/json-smoke.mjs") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
// Evidence-only modes never probe: run the real implementation so the ledger,
// summary and warning rendering are exercised, not emulated.
if (args.includes("--report-ledger") || args.includes("--skip-ledger")) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(typeof result.status === "number" ? result.status : 1);
}
const ledgerFlag = args.indexOf("--ledger");
const ledgerPath = ledgerFlag >= 0 ? args[ledgerFlag + 1] : null;
const rest = args.filter((_, index) => index !== ledgerFlag && index !== ledgerFlag + 1);
if (rest.length !== 2 || rest[1] !== "https://next.togetherweown.com") {
  console.error("unexpected checker invocation");
  process.exit(2);
}
if (!process.env.QA_AUTH_TOKEN) {
  console.error("checker ran without QA_AUTH_TOKEN");
  process.exit(2);
}
const attempts = join(process.env.RUNNER_TEMP, "attempts");
appendFileSync(attempts, "x");
const count = readFileSync(attempts, "utf8").length;
const pass = count === Number(process.env.SMOKE_SUCCEED_ON_ATTEMPT);
const CHECKS = ["guest collection refusal", "guest show refusal", "QA login issues a session cookie", "collection paging envelope", "malformed event_key filter", "JSON show", "cancelled show", "malformed show key", "session cookie flags", "status cookie flags", "session rotation replay", "logout revokes session", "logout clears cookies", "QA bad-token 404 matches missing route"];
if (pass && ledgerPath) {
  const skips = String(process.env.SMOKE_LEDGER_SKIPS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const entries = CHECKS.map((check) => (skips.includes(check) ? { check: check, status: "skip", reason: "emulated contract skip" } : { check: check, status: "pass" }));
  const skipped = entries.filter((entry) => entry.status === "skip").length;
  writeFileSync(ledgerPath, JSON.stringify({ ledger: "json-smoke/1", origin: "https://next.togetherweown.com", checks: entries, summary: { total: entries.length, passed: entries.length - skipped, failed: 0, skipped: skipped } }));
}
console.log(pass ? "json-smoke: 14 checks, 0 failed, 0 skipped" : "FAIL JSON show: expected HTTP 200 show; actual HTTP 503");
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
      // Neutralize the container's BASH_ENV/ENV shell profiles (see above):
      // without this the fakes below are dropped from PATH.
      BASH_ENV: "/dev/null",
      ENV: "/dev/null",
      PATH: scratch,
      RUNNER_TEMP: scratch,
      SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
      SMOKE_LEDGER_SKIPS: ledgerSkips.join(","),
      GITHUB_STEP_SUMMARY: join(scratch, "summary"),
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
    const summaryPath = join(scratch, "summary");
    const ledgerPath = join(scratch, "json-smoke-ledger.json");
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      attempts: readFileSync(join(scratch, "attempts"), "utf8").length,
      sleeps: readFileSync(join(scratch, "sleeps"), "utf8").length,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
      ledger: (existsSync(ledgerPath)
        ? JSON.parse(readFileSync(ledgerPath, "utf8"))
        : null) as JsonSmokeLedger,
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
    expect(result.output).not.toContain("::warning::");
    expect(result.ledger?.summary).toEqual({ total: 14, passed: 14, failed: 0, skipped: 0 });
    expect(result.summary).toContain("## Staging event-JSON smoke: passed (attempt 1)");
    expect(result.summary).toContain("Skipped exposure guards: none.");
  });

  it("names every skipped exposure guard without the token instead of failing the deploy", () => {
    const result = stagingJsonSmoke(0, false);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(0);
    expect(result.output).toContain("json-smoke skipped: staging QA_AUTH_TOKEN is not configured");
    for (const guard of [
      "guest collection refusal",
      "guest show refusal",
      "collection paging envelope",
      "JSON show",
      "cancelled show",
      "malformed show key",
    ]) {
      expect(result.output).toContain(`SKIP ${guard}: staging QA_AUTH_TOKEN is not configured`);
    }
    expect(result.output).toContain(
      "::warning::staging json-smoke skipped with unverified exposure guards",
    );
    expect(result.output).toContain("Tracked follow-up: #531");
    expect(result.output).not.toContain("::error::");
    expect(result.output).not.toContain("never-log-this");
    expect(result.ledger?.summary).toEqual({ total: 14, passed: 0, failed: 0, skipped: 14 });
    expect(result.summary).toContain("## Staging event-JSON smoke: skipped (no QA token)");
    expect(result.summary).toContain("- JSON show: staging QA_AUTH_TOKEN is not configured");
    expect(result.summary).toContain("#531");
  });

  it("warns loudly when the probe passes with skipped exposure guards", () => {
    const result = stagingJsonSmoke(1, true, ["JSON show", "cancelled show"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "::warning::staging json-smoke passed with skipped exposure guards: " +
        "JSON show (emulated contract skip); cancelled show (emulated contract skip). " +
        "Tracked follow-up: #531",
    );
    expect(result.ledger?.summary).toEqual({ total: 14, passed: 12, failed: 0, skipped: 2 });
    expect(result.summary).toContain("- cancelled show: emulated contract skip");
  });

  it("emits the per-check ledger as deploy evidence on both paths", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const block = workflow.match(
      /      - name: Smoke test staging event JSON contract\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(block).toBeDefined();
    for (const marker of [
      "--skip-ledger",
      "--ledger",
      "--report-ledger",
      "GITHUB_STEP_SUMMARY",
      "::warning::",
      "#531",
      "::error::staging event-JSON smoke failed after deploy",
    ]) {
      expect(block).toContain(marker);
    }
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
    expect(result.summary).toBe("");
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
