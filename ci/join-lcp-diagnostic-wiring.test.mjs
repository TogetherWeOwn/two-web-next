import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/join-lcp-diagnostic.yml", import.meta.url),
  "utf8",
);

test("diagnostic stays on draft PRs with a pinned head and no protected environment", () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, converted_to_draft\]/);
  assert.match(workflow, /if: github\.event\.pull_request\.draft == true/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|workflow_run:|environment:|secrets\./);
});

test("synthetic browser preflight runs before fixture collection", () => {
  assert.match(workflow, /- ci\/join-lcp-browser-preflight\.mjs/);
  assert.match(workflow, /- ci\/join-lcp-browser-preflight\.test\.mjs/);
  const install = workflow.indexOf("npx playwright install --with-deps chromium");
  const preflight = workflow.indexOf("node --test ci/join-lcp-browser-preflight.test.mjs");
  const collect = workflow.indexOf("node ci/join-lcp-diagnostic.mjs");
  assert.ok(install !== -1 && install < preflight && preflight < collect);
});

test("diagnostic retains fixture evidence without replacing the quality gate", () => {
  assert.match(workflow, /node ci\/join-lcp-diagnostic\.mjs/);
  assert.match(workflow, /path: artifacts\/join-lcp-diagnostic\//);
  assert.doesNotMatch(workflow, /ci-ok:|lighthouse:quality|wrangler deploy/);
});
