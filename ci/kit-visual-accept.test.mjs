import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptBaselines, HONO_SCREENSHOT_DIR, KIT_SCREENSHOT_DIR } from "./kit-visual-accept.mjs";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-visual-accept-"));
}

function writeBytes(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("Kit baselines land in the Kit directory, never the Hono one", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "past-desktop-actual.png"),
    "kit-past-bytes",
  );
  const written = [];
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: (dir, opts) => {
      written.push(`mkdir:${dir}`);
      return mkdirSync(dir, opts);
    },
    copy: (src, dest) => {
      written.push(`copy:${dest}`);
      return writeBytes(dest, readFileSync(src, "utf8"));
    },
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["past-desktop.png"]);
  assert.ok(
    written.some((line) => line.includes(KIT_SCREENSHOT_DIR)),
    written.join("\n"),
  );
  assert.ok(!written.some((line) => line.includes(HONO_SCREENSHOT_DIR)), written.join("\n"));
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "kit-past-bytes",
  );
});

test("empty artifact refuses with nothing written", () => {
  const workspace = scratch();
  const artifact = scratch();
  let writes = 0;
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: () => {
      writes += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});

test("colliding sources refuse with nothing written", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "a", "past-desktop-actual.png"),
    "bytes-one",
  );
  writeBytes(
    join(artifact, "test-results-kit-parity", "b", "past-desktop-actual.png"),
    "bytes-two",
  );
  let writes = 0;
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: () => {
      writes += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /refusing/);
  assert.equal(writes, 0);
});

test("reviewed Kit actual supersedes the committed copy in the artifact", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "e2e", "visual", "__screenshots-kit__", "member-board-default-desktop.png"),
    "stale-committed-bytes",
  );
  writeBytes(
    join(artifact, "test-results-kit-parity", "member-board-default-desktop-actual.png"),
    "reviewed-actual-bytes",
  );
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["member-board-default-desktop.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "member-board-default-desktop.png"), "utf8"),
    "reviewed-actual-bytes",
  );
});

test("reviewed actual and committed-only baselines are both accepted", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "x", "a-actual.png"),
    "changed-actual-bytes",
  );
  writeBytes(
    join(artifact, "e2e", "visual", "__screenshots-kit__", "a.png"),
    "stale-committed-bytes",
  );
  writeBytes(
    join(artifact, "e2e", "visual", "__screenshots-kit__", "b.png"),
    "committed-only-bytes",
  );
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["a.png", "b.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "a.png"), "utf8"),
    "changed-actual-bytes",
  );
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "b.png"), "utf8"),
    "committed-only-bytes",
  );
});

test("Kit visual actuals in the shared artifact are admitted", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-visual", "past", "past-desktop-actual.png"),
    "kit-visual-bytes",
  );

  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: mkdirSync,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["past-desktop.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "kit-visual-bytes",
  );
});

test("Hono suite actuals in the shared artifact are ignored", () => {
  const workspace = scratch();
  const artifact = scratch();
  // Shared e2e-failure artifact layout: the Hono actual must not land in the
  // Kit baselines, even when it flattens to the same destination name.
  writeBytes(
    join(artifact, "test-results-visual", "past", "past-desktop-actual.png"),
    "hono-bytes",
  );
  writeBytes(
    join(artifact, "test-results-kit-parity", "past", "past-desktop-actual.png"),
    "kit-bytes",
  );
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: mkdirSync,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["past-desktop.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "kit-bytes",
  );
});

test("Hono baseline names stay attributable to the Hono suite", async () => {
  const visualSpec = readFileSync(
    new URL("../e2e/visual/public-pages.visual.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(visualSpec, /__screenshots-kit__/);
  const visualConfig = readFileSync(
    new URL("../playwright.visual.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(visualConfig, /updateSnapshots: "missing"/);
  assert.match(visualConfig, /__screenshots__/);
});

test("changed Kit actual wins over its stale baseline and keeps unchanged baselines", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "past-desktop-actual.png"),
    "updated-kit-bytes",
  );
  writeBytes(join(artifact, KIT_SCREENSHOT_DIR, "past-desktop.png"), "stale-kit-bytes");
  writeBytes(join(artifact, KIT_SCREENSHOT_DIR, "events-desktop.png"), "unchanged-kit-bytes");

  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: mkdirSync,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["events-desktop.png", "past-desktop.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "updated-kit-bytes",
  );
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "events-desktop.png"), "utf8"),
    "unchanged-kit-bytes",
  );
});

function workflowStep(workflow, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflow.match(
    new RegExp(
      `      - name: ${escapedName}\\n([\\s\\S]*?)(?=      - (?:name:|uses:|run:)|    jobs:|$)`,
    ),
  );
  assert.ok(match, `workflow is missing the ${name} step`);
  return match[1];
}

function visualConfig(name) {
  const path = new URL(`../${name}`, import.meta.url);
  assert.ok(existsSync(path), `${name} must exist`);
  return readFileSync(path, "utf8");
}

function outputDir(config) {
  const match = config.match(/outputDir:\s*["']([^"']+)["']/);
  assert.ok(match, "visual config must set a dedicated outputDir");
  return match[1];
}

function snapshotPathTemplate(config) {
  const match = config.match(/snapshotPathTemplate:\s*["']([^"']+)["']/);
  assert.ok(match, "visual config must set a dedicated snapshotPathTemplate");
  return match[1];
}

test("Kit and Hono visual configs keep output and snapshot paths separate", () => {
  const kitConfig = visualConfig("playwright.kit-visual.config.ts");
  const honoConfig = visualConfig("playwright.visual.config.ts");
  const parityConfig = visualConfig("playwright.kit-parity.config.ts");
  const kitOutputDir = outputDir(kitConfig);
  const honoOutputDir = outputDir(honoConfig);
  const parityOutputDir = outputDir(parityConfig);
  const kitSnapshots = snapshotPathTemplate(kitConfig);
  const honoSnapshots = snapshotPathTemplate(honoConfig);

  assert.notEqual(kitOutputDir, honoOutputDir, "Playwright clears outputDir between invocations");
  assert.notEqual(
    kitOutputDir,
    parityOutputDir,
    "Parity journeys clear outputDir and would wipe Kit visual actuals",
  );
  assert.notEqual(kitSnapshots, honoSnapshots, "Kit and Hono baselines must stay separate");
  assert.match(kitSnapshots, /__screenshots-kit__/);
  assert.match(honoSnapshots, /__screenshots__/);
  assert.doesNotMatch(honoSnapshots, /__screenshots-kit__/);
});

test("failure artifact retains outputs from both visual invocations", () => {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const kitConfig = visualConfig("playwright.kit-visual.config.ts");
  const honoConfig = visualConfig("playwright.visual.config.ts");
  const failureStep = workflowStep(workflow, "Failure traces and report");

  assert.ok(failureStep.includes(outputDir(kitConfig)), "failure artifact must retain Kit actuals");
  assert.ok(
    failureStep.includes(outputDir(honoConfig)),
    "failure artifact must retain Hono actuals",
  );
  assert.ok(failureStep.includes(KIT_SCREENSHOT_DIR), "failure artifact must retain Kit baselines");
  assert.ok(
    failureStep.includes(HONO_SCREENSHOT_DIR),
    "failure artifact must retain Hono baselines",
  );
  assert.match(failureStep, /retention-days:\s*7/);
});

test("Hono visuals still run after a Kit visual failure", () => {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const kitStepIndex = workflow.indexOf("- name: Kit visual regression");
  const honoStepIndex = workflow.indexOf("- name: Visual regression");
  assert.ok(kitStepIndex >= 0, "workflow must run Kit visuals");
  assert.ok(honoStepIndex > kitStepIndex, "Hono visuals must run after Kit visuals");
  assert.match(workflowStep(workflow, "Visual regression"), /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
});
