import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Tie the hermetic action mirror to the immutable production ref. A pin change
// needs verified upstream hashes so local tests cannot cover stale code.
const gradualPromoteHashesByRef: Record<
  string,
  { helper: string; manifest: string; gate: string }
> = {
  "89c290be20c0044efaf6916f28341c76e75fff06": {
    helper: "8f87a83d79cc24dacdb5a7247eb1ad67afa0dde71ce3d210980927fe681a320a",
    manifest: "3ec491a337a484c5cdcb25695c6d0d9c48576a76a13c94453bd5ff98aa59b13a",
    gate: "973d48bd7a0ee0c130a4842e4bd2441451791d1483abdef37fcd7a0895766914",
  },
};

function actionManifestSha256(content: string) {
  const executableContent = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== "")
    .join("\n");
  return createHash("sha256").update(executableContent).digest("hex");
}

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
if (process.argv.length !== 5 || process.argv[2] !== "bin/smoke.mjs" || process.argv[3] !== "https://next.togetherweown.com" || process.argv[4] !== "--fail-on-ready-wait-critical") {
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

// Execute the shared gradual-promotion action's actual 5-percent health/SLO gate
// shell block with a fake checker and sleep, mirroring the staging helper. The
// checker itself has loopback-fixture coverage in smoke.test.mjs: no production
// requests here. The gate pins its probes to the NEW version through
// --version-override, so the canary is tested directly instead of through
// sampled traffic.
function productionSmoke(succeedOnAttempt: number) {
  const action = readFileSync(".github/actions/gradual-promote/action.yml", "utf8");
  const block = action.match(
    /    - name: Health and SLO gate at 5 percent\n[\s\S]*?      run: \|\n((?:        .*\n)+)/,
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "prod-route-smoke-",
    ),
  );
  const smokeUrl = pathToFileURL(join(process.cwd(), "bin/smoke.mjs")).href;
  try {
    writeFileSync(
      join(scratch, "node"),
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const attempts = join(process.env.RUNNER_TEMP, "attempts");
// On success the smoke block stamps its finish time with \`node -e ...\` for
// the error-rate gate's window start. Run that snippet like real node (a
// broken stamp throws here and fails the step) without counting it as a
// checker attempt.
if (process.argv[2] === "-e") {
  (0, eval)(process.argv[3]);
  process.exit(0);
}
appendFileSync(attempts, "x");
// The shell must hand the checker a value the REAL checker accepts. The
// fake validates the received override with the real assertVersionOverride
// (not a retyped pattern), so shell/checker drift fails here instead of
// failing every canary gate into rollback in production.
const { assertVersionOverride } = await import(${JSON.stringify(smokeUrl)});
try {
  assertVersionOverride(process.argv[6]);
} catch (error) {
  console.error("checker rejected version override: " + (error instanceof Error ? error.message : error));
  process.exit(2);
}
const expectedOverride = 'two-web-next-production="' + process.env.NEW_VERSION + '"';
if (process.argv.length !== 7 || process.argv[2] !== "bin/smoke.mjs" || process.argv[3] !== "https://togetherweown.com" || process.argv[4] !== "--allow-indexable" || process.argv[5] !== "--version-override" || process.argv[6] !== expectedOverride) {
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
    writeFileSync(join(scratch, "github-output"), "");
    const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    // Only our fakes are on PATH: no real network request or retry delay.
    const result = spawnSync(bash.stdout.trim(), ["-e", "-c", block!.replace(/^        /gm, "")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        // The block appends its finished-at step output here on success.
        GITHUB_OUTPUT: join(scratch, "github-output"),
        // This container exports BASH_ENV pointing at a profile that
        // reassigns PATH, which would drop the fakes below and send real
        // network requests plus real 10s sleeps. Neutralize both profile
        // hooks so only our fakes are on PATH.
        BASH_ENV: "/dev/null",
        ENV: "/dev/null",
        PATH: scratch,
        RUNNER_TEMP: scratch,
        SMOKE_SUCCEED_ON_ATTEMPT: String(succeedOnAttempt),
        // The gate block reads these from its own env mapping in the
        // action; the test wires the production values directly.
        DOMAIN: "togetherweown.com",
        INDEXABLE: "--allow-indexable",
        WORKER_NAME: "two-web-next-production",
        NEW_VERSION: "12345678-1234-1234-1234-123456789abc",
      },
    });
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

  it("scopes the fail-closed ready-wait gate to staging only", () => {
    // S6: staging fails closed on critical ready-wait (shared queue_jobs age
    // would otherwise be promotable); production promote and post-rollback
    // smoke stay warn-only so a stuck queue cannot block its own fix.
    const staging = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(staging).toContain(
      "node bin/smoke.mjs https://next.togetherweown.com --fail-on-ready-wait-critical",
    );
    const action = readFileSync(".github/actions/gradual-promote/action.yml", "utf8");
    for (const name of [
      "Health and SLO gate at 5 percent",
      "Health and SLO gate at 50 percent",
      "Health and SLO gate at 100 percent \\(new version\\)",
      "Health and SLO gate at 100 percent \\(live traffic\\)",
    ]) {
      const block = action.match(
        new RegExp(`    - name: ${name}\\n[\\s\\S]*?      run: \\|\\n((?:        .*\\n)+)`),
      )?.[1];
      expect(block).toBeDefined();
      expect(block).not.toContain("--fail-on-ready-wait-critical");
    }
    const rollback = readFileSync(".github/workflows/rollback-production.yml", "utf8");
    const rollbackBlock = rollback.match(
      /      - name: Smoke test production public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(rollbackBlock).toBeDefined();
    expect(rollbackBlock).not.toContain("--fail-on-ready-wait-critical");
  });

  it("hands the pre-deploy dead-letter baseline to staging smoke after capture", () => {
    // S7: staging /up serves retained queue.failed rows today, so the smoke
    // fails only on growth past this baseline. Dropping the env handoff
    // silently restores the absolute failed > 0 gate and reds every deploy.
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const captureAt = workflow.indexOf("- name: Capture pre-deploy dead-letter baseline");
    const smokeAt = workflow.indexOf("- name: Smoke test staging public routes");
    const migrateAt = workflow.indexOf("- name: Apply staging web migrations");
    expect(captureAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(captureAt);
    expect(smokeAt).toBeGreaterThan(migrateAt);
    const captureBlock = workflow.match(
      /- name: Capture pre-deploy dead-letter baseline\n[\s\S]*?run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(captureBlock).toBeDefined();
    expect(captureBlock).toContain("for i in 1 2 3 4 5");
    expect(captureBlock).toContain('fetch("https://next.togetherweown.com/up"');
    expect(captureBlock).toContain("::warning::dead-letter baseline unreadable");
    expect(captureBlock).toContain('echo "failed=$baseline" >> "$GITHUB_OUTPUT"');
    const smokeSection = workflow.slice(smokeAt, smokeAt + 2000);
    expect(smokeSection).toContain(
      "SMOKE_FAILED_BASELINE: ${{ steps.dead-letter-baseline.outputs.failed }}",
    );
    expect(smokeSection).toContain('SMOKE_ALLOW_MISSING_BASELINE: "1"');
  });

  it("hands the pre-promote dead-letter baseline to every promote smoke via GITHUB_ENV", () => {
    // The gradual-promote action runs this repo's bin/smoke.mjs in the same
    // job, so the $GITHUB_ENV export scopes every stage gate plus the
    // post-promotion verify to growth past the retained count.
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const jobAt = workflow.indexOf("\n  deploy-production:\n");
    const releaseAt = workflow.indexOf("\n  release:\n");
    expect(jobAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(jobAt);
    const job = workflow.slice(jobAt, releaseAt);
    const captureAt = job.indexOf("- name: Capture pre-promote dead-letter baseline");
    const gradualAt = job.indexOf("- name: Gradual promotion 5-50-100 with automatic rollback");
    const verifyAt = job.indexOf("- name: Verify public routes on the promoted version");
    expect(captureAt).toBeGreaterThan(-1);
    expect(gradualAt).toBeGreaterThan(captureAt);
    expect(verifyAt).toBeGreaterThan(gradualAt);
    const captureBlock = job.match(
      /- name: Capture pre-promote dead-letter baseline\n[\s\S]*?run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(captureBlock).toBeDefined();
    expect(captureBlock).toContain("for i in 1 2 3 4 5");
    expect(captureBlock).toContain('fetch("https://togetherweown.com/up"');
    expect(captureBlock).toContain("::warning::dead-letter baseline unreadable");
    expect(captureBlock).toContain('echo "SMOKE_FAILED_BASELINE=$baseline" >> "$GITHUB_ENV"');
    expect(captureBlock).toContain('echo "SMOKE_ALLOW_MISSING_BASELINE=1" >> "$GITHUB_ENV"');
  });

  it("hands the pre-rollback dead-letter baseline to rollback smoke after capture", () => {
    // The emergency path must never go red on retained history: growth past
    // the pre-rollback baseline fails, an unreadable capture skips the gate.
    const workflow = readFileSync(".github/workflows/rollback-production.yml", "utf8");
    const captureAt = workflow.indexOf("- name: Capture pre-rollback dead-letter baseline");
    const smokeAt = workflow.indexOf("- name: Smoke test production public routes");
    const rollbackAt = workflow.indexOf(
      "- name: Roll back to the recorded production Worker Version",
    );
    expect(captureAt).toBeGreaterThan(-1);
    expect(rollbackAt).toBeGreaterThan(captureAt);
    expect(smokeAt).toBeGreaterThan(rollbackAt);
    const captureBlock = workflow.match(
      /- name: Capture pre-rollback dead-letter baseline\n[\s\S]*?run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(captureBlock).toBeDefined();
    expect(captureBlock).toContain("for i in 1 2 3 4 5");
    expect(captureBlock).toContain('fetch("https://togetherweown.com/up"');
    expect(captureBlock).toContain("::warning::dead-letter baseline unreadable");
    expect(captureBlock).toContain('echo "failed=$baseline" >> "$GITHUB_OUTPUT"');
    const smokeSection = workflow.slice(smokeAt, smokeAt + 2000);
    expect(smokeSection).toContain(
      "SMOKE_FAILED_BASELINE: ${{ steps.dead-letter-baseline.outputs.failed }}",
    );
    expect(smokeSection).toContain('SMOKE_ALLOW_MISSING_BASELINE: "1"');
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
      "node --test test/smoke.test.mjs test/json-smoke.test.mjs test/revision-check.test.mjs test/smoke-ordinary-traffic-identity-acceptance.test.mjs",
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

  it("fails closed without the token while keeping the skip ledger as evidence", () => {
    const result = stagingJsonSmoke(0, false);
    expect(result.status, result.output).toBe(1);
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
    expect(result.output).toContain(
      "::error::staging event-JSON smoke missing QA token: exposure guards unverified",
    );
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
      "ledger write failed",
      "::error::staging event-JSON smoke failed after deploy",
      "::error::staging event-JSON smoke missing QA token: exposure guards unverified",
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
    expect(result.output).toContain(`stage 5 percent smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
    // The error-rate gate's window starts at this stamp, so a successful
    // smoke must emit a parseable finished-at step output.
    expect(result.stepOutput).toMatch(/^finished-at=\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    expect(Number.isNaN(Date.parse(result.stepOutput.trim().slice("finished-at=".length)))).toBe(
      false,
    );
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = productionSmoke(0);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL /faq: expected HTTP 200; actual HTTP 503");
    expect(result.output).toContain(
      "::error::stage 5 percent health/SLO gate failed after smoke retries",
    );
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.stepOutput).toBe("");
  });

  it("probes the apex origin with the indexable posture, never staging", () => {
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    expect(workflow).toContain(
      "uses: TogetherWeOwn/.github/actions/gradual-promote@89c290be20c0044efaf6916f28341c76e75fff06",
    );
    const centralActionRef = workflow.match(
      /uses: TogetherWeOwn\/\.github\/actions\/gradual-promote@([0-9a-f]{40})/,
    )?.[1];
    const expectedHashes = gradualPromoteHashesByRef[centralActionRef ?? ""];
    expect(expectedHashes).toBeDefined();
    const helperSha256 = createHash("sha256")
      .update(readFileSync(".github/actions/gradual-promote/gradual-promote.mjs"))
      .digest("hex");
    expect(helperSha256).toBe(expectedHashes?.helper);
    const gateSha256 = createHash("sha256")
      .update(readFileSync(".github/actions/gradual-promote/error-rate-gate.mjs"))
      .digest("hex");
    expect(gateSha256).toBe(expectedHashes?.gate);
    const action = readFileSync(".github/actions/gradual-promote/action.yml", "utf8");
    expect(actionManifestSha256(action)).toBe(expectedHashes?.manifest);
    expect(workflow).toContain("domain: togetherweown.com");
    expect(workflow).not.toContain("next.togetherweown.com");
    expect(action).toContain('default: "true"');
    for (const stage of ["5", "50", "100"]) {
      const block = action.match(
        new RegExp(
          `    - name: Health and SLO gate at ${stage} percent[\\s\\S]*?      run: \\|\\n((?:        .*\\n)+)`,
        ),
      )?.[1];
      expect(block).toBeDefined();
      expect(block).toContain('node bin/smoke.mjs "https://$DOMAIN" $INDEXABLE');
      expect(block).toContain("--version-override");
      // The checker override shape carries inner quotes (worker-name="uuid");
      // an unquoted shell value is rejected before any probe, which would
      // fail every canary gate into rollback.
      expect(block).toContain('--version-override "$WORKER_NAME=\\"$NEW_VERSION\\""');
      expect(block).not.toContain("next.togetherweown.com");
      expect(block).not.toContain("https://togetherweown.com --allow-indexable");
    }
    const live = action.match(
      /    - name: Health and SLO gate at 100 percent \(live traffic\)\n[\s\S]*?      run: \|\n((?:        .*\n)+)/,
    )?.[1];
    expect(live).toBeDefined();
    expect(live).toContain('node bin/smoke.mjs "https://$DOMAIN" $INDEXABLE');
    expect(live).not.toContain("--version-override");
  });

  it("stays on standard hosted runners with no secrets", () => {
    const action = readFileSync(".github/actions/gradual-promote/action.yml", "utf8");
    for (const name of [
      "Health and SLO gate at 5 percent",
      "Health and SLO gate at 50 percent",
      "Health and SLO gate at 100 percent \\(new version\\)",
      "Health and SLO gate at 100 percent \\(live traffic\\)",
    ]) {
      const block = action.match(
        new RegExp(`    - name: ${name}\\n[\\s\\S]*?      run: \\|\\n((?:        .*\\n)+)`),
      )?.[1];
      expect(block).toBeDefined();
      expect(block).not.toMatch(/secrets\./);
      expect(block).not.toMatch(/self-hosted/);
    }
  });
});

// Execute deploy-production.yml's post-promotion verification step with a fake
// checker and sleep, mirroring the helpers above. The checker itself has
// loopback-fixture coverage in smoke.test.mjs: no production requests here.
// The step probes live traffic (no --version-override) after the gradual
// promotion reaches 100%, so a promotion serving broken public content fails
// the deploy-production job before the release job can tag. A failed run
// leaves the promoted candidate live at 100% with the tag withheld and prints
// PREV_VERSION as the recorded restoration target for the rollback-production
// workflow; there is no automatic restore (the gradual action's rollback only
// covers in-action failures, and an inline wrangler rollback would bypass the
// rollback target-version secrets preflight).
function postPromotionSmoke(
  succeedOnAttempt: number,
  prevVersion = "pre-promote-version-for-test",
) {
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const block = workflow.match(
    /      - name: Verify public routes on the promoted version\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  expect(block).toBeDefined();
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "post-promote-smoke-",
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
console.log(pass ? "smoke: 18 routes, 0 failed assertions" : "FAIL /join: expected HTTP 200; actual HTTP 503");
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
          PREV_VERSION: prevVersion,
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

describe("production post-promotion verification (offline)", () => {
  it.each([1, 3, 6])("stops on successful attempt %s", (attempt) => {
    const result = postPromotionSmoke(attempt);
    expect(result.status, result.output).toBe(0);
    expect(result.attempts).toBe(attempt);
    expect(result.sleeps).toBe(attempt - 1);
    expect(result.output).toContain(`post-promotion production smoke ok (attempt ${attempt})`);
    expect(result.output).not.toContain("unexpected checker invocation");
    expect(result.output).not.toContain("::error::");
  });

  it("fails closed after six failed checker runs without a final sleep", () => {
    const result = postPromotionSmoke(0);
    expect(result.status, result.output).toBe(1);
    expect(result.attempts).toBe(6);
    expect(result.sleeps).toBe(5);
    expect(result.output).toContain("FAIL /join: expected HTTP 200; actual HTTP 503");
    expect(result.output).toContain(
      "::error::post-promotion public-route smoke failed; promoted candidate remains live at 100%; release will not tag",
    );
    expect(result.output).not.toContain("unexpected checker invocation");
  });

  it("names the live promoted candidate and the recorded restoration target on failure", () => {
    const result = postPromotionSmoke(0, "aaaabbbb-cccc-dddd-eeee-ffffffffffff");
    expect(result.status, result.output).toBe(1);
    // The gradual action's rollback only covers in-action failures, so the
    // promoted candidate stays live at 100% with the tag withheld: the error
    // must name the live candidate, the recorded restoration target id, and
    // the restore path, without asserting the target is currently serving.
    expect(result.output).toContain("promoted candidate remains live at 100%");
    expect(result.output).toContain("release will not tag");
    expect(result.output).toContain("recorded restoration target");
    expect(result.output).toContain("aaaabbbb-cccc-dddd-eeee-ffffffffffff");
    expect(result.output).toContain("rollback-production");
    expect(result.output).not.toContain("still live at 100%");
  });

  it("wires the gradual rollback target into the step and documents the manual restore", () => {
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const stepAt = workflow.indexOf("- name: Verify public routes on the promoted version");
    expect(stepAt).toBeGreaterThan(-1);
    const section = workflow.slice(stepAt, workflow.indexOf("\n  release:\n"));
    // PREV_VERSION comes from the gradual action's recorded pre-promote
    // target, the same id its own rollback steps restore.
    expect(section).toContain("PREV_VERSION: ${{ steps.gradual.outputs.rollback-version-id }}");
    expect(section).toContain("rollback-production");
    // The failure annotation must name the promoted candidate as live and
    // PREV_VERSION as the recorded restoration target, never the target as
    // currently serving.
    expect(section).toContain("promoted candidate remains live at 100%");
    expect(section).toContain("recorded restoration target");
    expect(section).not.toContain("still live at 100%");
    // No inline restore: the rollback workflow checks the target version's
    // secrets before moving traffic (pinned by the negative control in
    // ci/check-production-secrets.test.mjs), so this step only blocks the tag.
    expect(section).not.toContain("npx wrangler rollback");
  });

  it("runs after the gradual promotion inside the deploy job, before the release job can tag", () => {
    const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const stepAt = workflow.indexOf("- name: Verify public routes on the promoted version");
    expect(stepAt).toBeGreaterThan(-1);
    expect(stepAt).toBeGreaterThan(
      workflow.indexOf("- name: Gradual promotion 5-50-100 with automatic rollback"),
    );
    // Still inside the deploy-production job: the release job keeps its
    // `needs: [preflight, deploy-production]`, so a failed verification fails
    // this job and the tag never publishes (pinned in release-workflow.test.ts).
    expect(stepAt).toBeLessThan(workflow.indexOf("\n  release:\n"));
    const block = workflow.match(
      /      - name: Verify public routes on the promoted version\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(block).toBeDefined();
    // Same shared checker and retry contract as the gradual live gate and the
    // rollback smoke, so the three post-deploy gates cannot drift.
    expect(block).toContain("node bin/smoke.mjs https://togetherweown.com --allow-indexable");
    expect(block).toContain("for i in 1 2 3 4 5 6");
    expect(block).not.toContain("curl ");
    // Live-traffic probe of the promoted apex: no version override, no
    // staging host, no secrets, no state-mutating probes.
    expect(block).not.toContain("--version-override");
    expect(block).not.toContain("next.togetherweown.com");
    expect(block).not.toMatch(/secrets\./);
    expect(block).not.toMatch(/\/auth\/discord/);
  });
});

describe("production release-docs contract (source)", () => {
  it("explains gradual promotion, manual restoration and release gating without static serving-state claims", () => {
    const readme = readFileSync("README.md", "utf8");
    const heading = "### Production (gated manual deployment)";
    expect(readme).toContain(heading);
    expect(readme).not.toContain("### Production (not live");
    const section = readme.slice(
      readme.indexOf(heading),
      readme.indexOf("Whoever is authorized to provision production"),
    );
    expect(section.length).toBeGreaterThan(0);
    // 5 -> 50 -> 100 with in-action automatic rollback versus post-action
    // manual restoration, and verification before release publication.
    expect(section).toContain("5% → 50% → 100%");
    expect(section).toContain("automatic rollback");
    expect(section).toContain("promoted candidate live at 100%");
    expect(section).toContain("recorded restoration target");
    expect(section).toContain("rollback-production");
    expect(section).toContain("before the `release`");
    // No unsupported static not-live/unprovisioned assertions and no claim
    // that the restoration target is currently serving.
    const flat = section.replace(/\s+/g, " ");
    for (const stale of [
      "not yet live",
      "not live",
      "legacy stack",
      "cutover template",
      "not a live deployment",
      "unprovisioned",
      "does not exist yet",
      "NO-GO",
      "still live at 100%",
    ]) {
      expect(flat).not.toContain(stale);
    }
  });
});

describe("staging readiness smoke docs contract (offline)", () => {
  it("pins the staging invocation and posture in source", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(workflow).toContain(
      "node bin/smoke.mjs https://next.togetherweown.com --fail-on-ready-wait-critical",
    );
    const smoke = readFileSync("bin/smoke.mjs", "utf8");
    expect(smoke).toContain("known queue.status and ready_wait_severity (not unknown)");
    expect(smoke).toContain("ready_wait_severity not critical");
  });

  it("states the strict staging command, DB/schema requirements and unknown/critical refusal in README", () => {
    const readme = readFileSync("README.md", "utf8");
    const deployAt = readme.indexOf("## Deploy");
    expect(deployAt).toBeGreaterThan(-1);
    const section = readme.slice(deployAt, readme.indexOf("Full procedures live in"));
    expect(section).toContain(
      "node bin/smoke.mjs https://next.togetherweown.com --fail-on-ready-wait-critical",
    );
    expect(section).toContain("`db:ok`");
    expect(section).toContain("`pending_migrations:0`");
    for (const phrase of ["`unknown`", "`critical`", "`ready_wait_severity`"]) {
      expect(section, `README staging smoke misses ${phrase}`).toContain(phrase);
    }
    expect(section).toContain("staging-only");
    expect(section).toContain("only warns");
    // No liveness-only contradiction and no unknown-passes claim.
    const flat = section.replace(/\s+/g, " ");
    expect(flat).not.toContain("liveness only");
    expect(flat).not.toContain("unknown queue health alone does not fail");
    // Literal refusal only: never promise every malformed field is rejected.
    expect(flat).not.toMatch(/malformed.*reject/i);
  });

  it("states the strict staging posture in the runbook deploy section without liveness-only language", () => {
    const runbook = readFileSync("docs/runbook.md", "utf8");
    const at = runbook.indexOf("The final staging smoke runs");
    expect(at).toBeGreaterThan(-1);
    const section = runbook.slice(
      at,
      runbook.indexOf("An explicitly authorized manual deployment"),
    );
    expect(section).toContain(
      "node bin/smoke.mjs https://next.togetherweown.com --fail-on-ready-wait-critical",
    );
    expect(section).toContain("`db:ok`");
    expect(section).toContain("`pending_migrations:0`");
    expect(section).toContain("`ready_wait_severity`");
    expect(section).toContain("fails the deploy");
    expect(section).toContain("Queue `degraded` passes");
    expect(section).not.toContain("public-route liveness only");
    expect(section).not.toMatch(/not DB\/schema readiness/);
    expect(section).not.toMatch(/`unknown` is allowed/);
    // Staging strict versus flag-less production posture in the same passage.
    expect(section).toContain("node bin/smoke.mjs https://togetherweown.com --allow-indexable");
    expect(section).toContain("without the strict flag");
    expect(section).toContain("only warns");
  });

  it("separates /up 200 behavior from the staging smoke verdict in the readiness section", () => {
    const runbook = readFileSync("docs/runbook.md", "utf8");
    const at = runbook.indexOf("The staging deploy smoke requires");
    expect(at).toBeGreaterThan(-1);
    const section = runbook.slice(at, runbook.indexOf("requires a recorded, authorized staging"));
    expect(section).toContain("--fail-on-ready-wait-critical");
    expect(section).toContain("fails closed on a literal `unknown`");
    expect(section).toContain("`critical` `ready_wait_severity`");
    expect(section).toContain("only warns on `critical`");
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toContain("still returns 200 from `/up` itself");
    expect(flat).not.toContain("queue-only `unknown` does not");
  });
});
