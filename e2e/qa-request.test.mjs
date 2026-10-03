import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
import { sendTokenRequest, transportFailureReason } from "./qa-request.mjs";

// TOG-13046: the staging QA token must not reach a Playwright failure
// artifact. The canary stands in for the real token; it is never a secret.
const CANARY = "canary-QA-token-do-not-leak-9f3a";

// Shape of a Playwright 1.63 transport failure: the first line names the
// failure, the call log that follows carries the request headers.
function playwrightTransportError() {
  return new Error(
    [
      "apiRequestContext.post: socket hang up",
      "Call log:",
      "  - → POST https://next.togetherweown.com/auth/qa/qa-member",
      "  -   user-agent: Playwright/1.63.0",
      `  -   X-TWO-QA-Auth: ${CANARY}`,
      "  -   Origin: https://next.togetherweown.com",
    ].join("\n"),
  );
}

function everyErrorText(error) {
  const own = Object.getOwnPropertyNames(error).map((key) => String(error[key]));
  return [error.message, error.stack, String(error), ...own, JSON.stringify(error)];
}

test("a canary header in a transport error's call log does not survive", async () => {
  await assert.rejects(
    sendTokenRequest("staging QA login as qa-member", CANARY, () =>
      Promise.reject(playwrightTransportError()),
    ),
    (error) => {
      assert.equal(
        error.message,
        "staging QA login as qa-member failed: apiRequestContext.post: socket hang up",
      );
      assert.equal(error.cause, undefined);
      for (const text of everyErrorText(error)) {
        assert.ok(!text.includes(CANARY), "canary leaked into the rethrown error");
        assert.ok(!text.includes("Call log"), "call log leaked into the rethrown error");
        assert.ok(!text.includes("X-TWO-QA-Auth"), "request header leaked into the rethrown error");
      }
      return true;
    },
  );
});

test("a node error code is the whole reason", () => {
  const error = Object.assign(playwrightTransportError(), { code: "ECONNRESET" });
  assert.equal(transportFailureReason(error, CANARY), "ECONNRESET");
});

test("the token is scrubbed even from a one-line message or a code field", () => {
  assert.equal(
    transportFailureReason(new Error(`request failed with X-TWO-QA-Auth: ${CANARY}`), CANARY),
    "request failed with X-TWO-QA-Auth: [redacted]",
  );
  assert.equal(
    transportFailureReason(Object.assign(new Error("x"), { code: "TOKEN_ABC" }), "TOKEN_ABC"),
    "[redacted]",
  );
});

test("an unusable error value gives a generic reason", () => {
  for (const value of [undefined, null, "boom", 42, {}, new Error("")]) {
    assert.equal(transportFailureReason(value, CANARY), "request error");
  }
});

test("a long first line is bounded", () => {
  const reason = transportFailureReason(new Error("x".repeat(500)), CANARY);
  assert.equal(reason.length, 120);
});

test("a successful request passes its response through untouched", async () => {
  const response = { status: () => 204 };
  assert.equal(await sendTokenRequest("probe", CANARY, async () => response), response);
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRUB = join(REPO_ROOT, "ci", "scrub-qa-token.py");
const PLAYWRIGHT_CLI = join(REPO_ROOT, "node_modules", "playwright", "cli.js");

function sweep(token, ...dirs) {
  return spawnSync("python3", [SCRUB, ...dirs], {
    env: { PATH: process.env.PATH, ...(token === undefined ? {} : { QA_AUTH_TOKEN: token }) },
    encoding: "utf8",
  });
}

// The workflow uploads only when the sweep wrote `swept=true` to GITHUB_OUTPUT.
function sweepWithOutput(token, ...dirs) {
  const dir = mkdtempSync(join(tmpdir(), "scrub-qa-output-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  try {
    const run = spawnSync("python3", [SCRUB, ...dirs], {
      env: { PATH: process.env.PATH, QA_AUTH_TOKEN: token, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return { run, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Real Playwright output for a failing spec, no browser needed. The spec makes
// a token-bearing request to a closed port, so its error text carries the
// request headers (the real failure), records a standalone request trace, and
// rethrows. That leaves the token in the places the sweep must reach: the
// html report's embedded data zip, a trace zip, and plain error files.
function realFailureArtifacts(token) {
  const root = mkdtempSync(join(tmpdir(), "scrub-qa-token-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "playwright.config.mjs"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "canary.spec.mjs",
  outputDir: "test-results",
  retries: 0,
  reporter: [["html", { open: "never", outputFolder: "playwright-report" }]],
});
`,
  );
  writeFileSync(
    join(root, "canary.spec.mjs"),
    `import { test, request } from "@playwright/test";
test("canary", async ({}, testInfo) => {
  const context = await request.newContext();
  await context.tracing.start();
  let failure;
  try {
    await context.post("http://127.0.0.1:1/auth/qa/qa-member", {
      headers: { "X-TWO-QA-Auth": process.env.CANARY },
    });
  } catch (error) {
    failure = error;
  }
  await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
  await context.dispose();
  throw failure;
});
`,
  );
  const run = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", "-c", "playwright.config.mjs"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CANARY: token },
    encoding: "utf8",
  });
  assert.equal(run.status, 1, `the canary spec must fail:\n${run.stdout}\n${run.stderr}`);
  return {
    root,
    results: join(root, "test-results"),
    report: join(root, "playwright-report"),
  };
}

// Only a real Playwright run proves the report really hides the token in its
// embedded zip rather than in plain text, so a grep of index.html finds nothing.
test("a real failing run keeps the token out of a plain-text search of index.html", () => {
  const { root, report } = realFailureArtifacts(CANARY);
  try {
    assert.ok(!readFileSync(join(report, "index.html"), "latin1").includes(CANARY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep removes the report whose embedded zip holds the token", () => {
  const { root, report } = realFailureArtifacts(CANARY);
  try {
    const only = join(root, "only-report");
    mkdirSync(only);
    copyFileSync(join(report, "index.html"), join(only, "index.html"));
    const run = sweep(CANARY, only);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /removed .*index\.html \(embedded archive member /);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.deepEqual(readdirSync(only), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep removes a trace zip whose members hold the token", () => {
  const { root, results } = realFailureArtifacts(CANARY);
  try {
    const only = join(root, "only-trace");
    mkdirSync(only);
    copyFileSync(join(results, "canary-canary", "trace.zip"), join(only, "trace.zip"));
    const run = sweep(CANARY, only);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /removed .*trace\.zip \(archive member /);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.deepEqual(readdirSync(only), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep leaves a whole real artifact tree token-free, loudly, and keeps clean files", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const run = sweep(CANARY, results, report);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.match(run.stdout, /::error::QA_AUTH_TOKEN was found in \d+ failure artifact file\(s\)/);
    assert.ok(!existsSync(join(report, "index.html")), "index.html left behind");
    assert.ok(!existsSync(join(results, "canary-canary", "trace.zip")), "trace.zip left behind");
    // What survives holds no token the sweep can read.
    const rerun = sweep(CANARY, results, report);
    assert.equal(rerun.status, 0, rerun.stderr);
    // `.last-run.json` never held it, so it stays.
    assert.ok(existsSync(join(results, ".last-run.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sweep for a different token passes and changes nothing", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const before = readdirSync(report, { recursive: true }).sort();
    assert.equal(sweep("a-different-staging-token-7c41", results, report).status, 0);
    assert.deepEqual(readdirSync(report, { recursive: true }).sort(), before);
    assert.ok(existsSync(join(results, "canary-canary", "trace.zip")));
    // A missing directory is not an error: a failed run may not have produced it.
    assert.equal(sweep(CANARY, join(root, "absent")).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished sweep marks the tree swept, a sweep that cannot remove a file does not", {
  skip: process.getuid?.() === 0 ? "root can remove files from a read-only directory" : false,
}, () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    const hit = sweepWithOutput(CANARY, results, report);
    assert.equal(hit.run.status, 1, hit.run.stderr);
    assert.equal(hit.output, "swept=true\n");
    assert.equal(sweepWithOutput(CANARY, results, report).output, "swept=true\n");

    const stuck = join(root, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "leak.md"), CANARY);
    chmodSync(stuck, 0o555);
    try {
      const refused = sweepWithOutput(CANARY, stuck);
      assert.equal(refused.run.status, 2, refused.run.stderr);
      assert.equal(refused.output, "", "an unswept tree must not be marked swept");
      assert.ok(!refused.run.stdout.includes(CANARY) && !refused.run.stderr.includes(CANARY));
    } finally {
      chmodSync(stuck, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty or unset token never sweeps (an empty pattern matches every file)", () => {
  const { root, results, report } = realFailureArtifacts(CANARY);
  try {
    for (const token of ["", undefined]) {
      assert.equal(sweep(token, results, report).status, 0);
    }
    assert.ok(existsSync(join(report, "index.html")));
    assert.ok(existsSync(join(results, "canary-canary", "trace.zip")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep runs on failure, before the upload, with the token in its own env", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const steps = workflow.split(/\n {6}- /).slice(1);
  const scrub = steps.findIndex((step) => step.includes("ci/scrub-qa-token.py"));
  const upload = steps.findIndex((step) => step.includes("actions/upload-artifact"));
  assert.ok(scrub >= 0 && upload >= 0 && scrub < upload, "sweep must precede the upload");
  assert.match(steps[scrub], /\n\s+id: scrub\n/);
  assert.match(steps[scrub], /\n\s+if: failure\(\)\n/);
  assert.match(steps[scrub], /python3 ci\/scrub-qa-token\.py test-results playwright-report\n/);
  assert.match(steps[scrub], /env:\n\s+QA_AUTH_TOKEN: \$\{\{ secrets\.QA_AUTH_TOKEN \}\}/);
  // A sweep that crashed or could not delete a file leaves no `swept` output,
  // and then nothing is uploaded.
  assert.match(steps[upload], /\n\s+if: failure\(\) && steps\.scrub\.outputs\.swept == 'true'\n/);
  // The upload still covers exactly the two swept directories.
  assert.match(steps[upload], /test-results\/\n\s+playwright-report\//);
});
