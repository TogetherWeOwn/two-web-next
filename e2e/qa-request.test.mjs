import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const SCRUB = new URL("../ci/scrub-qa-token.sh", import.meta.url).pathname;

function sweep(token, ...dirs) {
  return spawnSync("bash", [SCRUB, ...dirs], {
    env: { PATH: process.env.PATH, ...(token === undefined ? {} : { QA_AUTH_TOKEN: token }) },
    encoding: "utf8",
  });
}

function artifactTree() {
  const root = mkdtempSync(join(tmpdir(), "scrub-qa-token-"));
  const results = join(root, "test-results");
  const report = join(root, "playwright-report");
  mkdirSync(join(results, "auth-chromium"), { recursive: true });
  mkdirSync(join(report, "data"), { recursive: true });
  writeFileSync(join(results, "auth-chromium", "error-context.md"), "assertion: expected 404\n");
  writeFileSync(join(results, "auth-chromium", "leak.md"), `X-TWO-QA-Auth: ${CANARY}\n`);
  writeFileSync(join(report, "index.html"), `<pre>${CANARY}</pre>`);
  writeFileSync(
    join(report, "data", "binary.bin"),
    Buffer.from([0, 1, 2, ...Buffer.from(CANARY), 3]),
  );
  writeFileSync(join(report, "data", "clean.json"), '{"status":"failed"}');
  return { root, results, report };
}

test("the sweep removes every file holding the token, loudly, and keeps the rest", () => {
  const { root, results, report } = artifactTree();
  try {
    const run = sweep(CANARY, results, report);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), "token printed");
    assert.match(run.stdout, /::error::QA_AUTH_TOKEN was found in 3 failure artifact file\(s\)/);
    for (const name of ["leak.md", "index.html", "binary.bin"]) {
      assert.match(run.stderr, new RegExp(`removed .*${name.replace(".", "\\.")}`));
    }
    assert.deepEqual(readdirSync(join(results, "auth-chromium")), ["error-context.md"]);
    assert.deepEqual(readdirSync(report).sort(), ["data"]);
    assert.deepEqual(readdirSync(join(report, "data")), ["clean.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sweep with nothing to remove passes and changes nothing", () => {
  const { root, results, report } = artifactTree();
  try {
    assert.equal(sweep("some-other-token", results, report).status, 0);
    assert.equal(readFileSync(join(report, "index.html"), "utf8"), `<pre>${CANARY}</pre>`);
    // A missing directory is not an error: a failed run may not have produced it.
    assert.equal(sweep("some-other-token", join(root, "absent")).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty or unset token never sweeps (an empty pattern matches every file)", () => {
  const { root, results, report } = artifactTree();
  try {
    for (const token of ["", undefined]) {
      assert.equal(sweep(token, results, report).status, 0);
    }
    assert.equal(readFileSync(join(report, "index.html"), "utf8"), `<pre>${CANARY}</pre>`);
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
  const scrub = steps.findIndex((step) => step.includes("ci/scrub-qa-token.sh"));
  const upload = steps.findIndex((step) => step.includes("actions/upload-artifact"));
  assert.ok(scrub >= 0 && upload >= 0 && scrub < upload, "sweep must precede the upload");
  assert.match(steps[scrub], /\n\s+if: failure\(\)\n/);
  assert.match(steps[scrub], /ci\/scrub-qa-token\.sh test-results playwright-report\n/);
  assert.match(steps[scrub], /env:\n\s+QA_AUTH_TOKEN: \$\{\{ secrets\.QA_AUTH_TOKEN \}\}/);
  // The upload still covers exactly the two swept directories.
  assert.match(steps[upload], /test-results\/\n\s+playwright-report\//);
});
