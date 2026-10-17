import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The staging QA token must stay out of failure artifacts at the source, not
// only via the ci/scrub-qa-token.py sweep (which stays as a fail-closed
// backstop). Playwright records every API call made in a test as a step and,
// with tracing on, as a trace action — both carry the raw call, headers
// included, before qa-request.mjs can scrub the rethrown error. The staging
// journeys run in a public repo whose artifacts are downloadable, so the
// staging config must not record traces or an HTML report (the report
// embeds the per-step raw errors). The JSON report that feeds the journey
// ledger carries neither step errors nor trace actions.
//
// The canary stands in for the real token; it is never a secret.
const CANARY = "canary-QA-token-do-not-leak-9f3a";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRUB = join(REPO_ROOT, "ci", "scrub-qa-token.py");
const PLAYWRIGHT_CLI = join(REPO_ROOT, "node_modules", "playwright", "cli.js");
const STAGING_CONFIG = readFileSync(join(REPO_ROOT, "playwright.staging.config.ts"), "utf8");

test("the staging config records no trace and no HTML report, but keeps the JSON ledger feed", () => {
  const traces = [...STAGING_CONFIG.matchAll(/trace:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(traces.length >= 1, "staging config must state its trace mode explicitly");
  assert.deepEqual([...new Set(traces)], ["off"]);
  assert.doesNotMatch(STAGING_CONFIG, /\[\s*"html"/, "the HTML reporter embeds raw step errors");
  assert.match(
    STAGING_CONFIG,
    /\[\s*"json",\s*\{\s*outputFile:\s*"test-results\/staging-journeys\.json"\s*\}\s*\]/,
  );
  // Failure evidence that cannot carry request data stays on.
  assert.match(STAGING_CONFIG, /screenshot:\s*"only-on-failure"/);
});

function stagingTraceMode() {
  return /trace:\s*"([^"]+)"/.exec(STAGING_CONFIG)?.[1] ?? "off";
}

function stagingHasHtmlReporter() {
  return /\[\s*"html"/.test(STAGING_CONFIG);
}

// A real Playwright run in the staging config's own recording posture (trace
// mode and reporter set read from playwright.staging.config.ts above), no
// browser needed: token-bearing requests go through the real
// e2e/qa-request.mjs, one transport-fails against a closed port, one
// succeeds against a local server and the journey then fails on something
// else. Both shapes reached uploaded artifacts before this fix.
function realStagingPostureRun() {
  const root = mkdtempSync(join(tmpdir(), "qa-artifacts-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  copyFileSync(join(REPO_ROOT, "e2e", "qa-request.mjs"), join(root, "qa-request.mjs"));
  const reporters = [
    '["list"]',
    ...(stagingHasHtmlReporter()
      ? ['["html", { open: "never", outputFolder: "playwright-report" }]']
      : []),
    '["json", { outputFile: "test-results/staging-journeys.json" }]',
  ];
  writeFileSync(
    join(root, "playwright.config.mjs"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "canary.spec.mjs",
  outputDir: "test-results",
  retries: 0,
  workers: 1,
  reporter: [${reporters.join(", ")}],
  use: { trace: ${JSON.stringify(stagingTraceMode())}, screenshot: "only-on-failure" },
});
`,
  );
  writeFileSync(
    join(root, "canary.spec.mjs"),
    `import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { sendTokenRequest } from "./qa-request.mjs";

test("transport failure on the QA path", async ({ request }) => {
  await sendTokenRequest("staging QA login as qa-member", process.env.CANARY, () =>
    request.post("http://127.0.0.1:1/auth/qa/qa-member", {
      headers: { "X-TWO-QA-Auth": process.env.CANARY },
    }),
  );
});

test("successful QA request, then the journey fails elsewhere", async ({ request }) => {
  const server = createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await sendTokenRequest("staging QA login as qa-member", process.env.CANARY, () =>
      request.post("http://127.0.0.1:" + port + "/auth/qa/qa-member", {
        headers: { "X-TWO-QA-Auth": process.env.CANARY },
      }),
    );
    expect(response.status()).toBe(204);
  } finally {
    server.close();
  }
  throw new Error("later journey failure");
});
`,
  );
  const run = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", "-c", "playwright.config.mjs"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CANARY },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(run.error, undefined, `the canary run must finish: ${run.error}`);
  assert.equal(run.status, 1, `both canary specs must fail:\n${run.stdout}\n${run.stderr}`);
  return root;
}

test("a failing run in the staging recording posture leaves no token in its artifact tree", () => {
  const root = realStagingPostureRun();
  try {
    const results = join(root, "test-results");
    const report = join(root, "playwright-report");
    // The ledger feed is still produced for ci/check-staging-journeys.mjs.
    assert.ok(existsSync(join(results, "staging-journeys.json")), "JSON report missing");
    // The sweep is the oracle for the token itself, including inside zips
    // and the report's embedded archive: a clean tree exits 0 and the sweep
    // removes nothing (it stays in the workflow as the backstop).
    const sweep = spawnSync("python3", [SCRUB, "test-results", "playwright-report"], {
      cwd: root,
      env: { PATH: process.env.PATH, QA_AUTH_TOKEN: CANARY },
      encoding: "utf8",
    });
    assert.equal(
      sweep.status,
      0,
      `the sweep had to remove a file, so the token was recorded:\n${sweep.stderr}`,
    );
    assert.doesNotMatch(sweep.stderr, /removed/);
    // No trace is recorded and no plain file holds the canary either.
    for (const dir of [results, report]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        assert.ok(
          entry.name !== "trace.zip" && !entry.name.endsWith(".trace"),
          `a trace was recorded: ${entry.name}`,
        );
        const text = readFileSync(join(entry.parentPath, entry.name), "latin1");
        assert.ok(!text.includes(CANARY), `canary token in ${entry.name}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
