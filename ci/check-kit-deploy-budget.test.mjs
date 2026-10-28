import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureDeployBundle } from "./check-kit-deploy-budget.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "kit-deploy-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  mkdirSync(join(root, "ci/budgets/deploy"), { recursive: true });
  const base = {
    worker: { maxRawBytes: 1_020 },
    measuredMain: {
      sha: "a".repeat(40),
      rawBytesUpperBound: 1_000,
      evidence: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/job/456",
    },
  };
  const save = () =>
    writeFileSync(join(root, "ci/budgets/deploy/worker.json"), JSON.stringify(base));
  save();
  writeFileSync(join(artifactDir, "_worker.js"), "x".repeat(1_000));
  return {
    root,
    artifactDir,
    base,
    save,
    measure: () => measureDeployBundle(root, artifactDir),
  };
}

test("final deploy raw bytes: exact ceiling passes, ceiling + 1 fails", (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.artifactDir, "_worker.js"), "x".repeat(1_020));
  assert.equal(fx.measure().code, 0);
  writeFileSync(join(fx.artifactDir, "_worker.js"), "x".repeat(1_021));
  assert.equal(fx.measure().code, 1);
});

test("all final modules count, source maps and Wrangler's README do not", (t) => {
  const fx = fixture(t);
  mkdirSync(join(fx.artifactDir, "modules"));
  writeFileSync(join(fx.artifactDir, "modules/data.wasm"), "x".repeat(21));
  writeFileSync(join(fx.artifactDir, "_worker.js.map"), "x".repeat(10_000));
  writeFileSync(join(fx.artifactDir, "README.md"), "generated documentation");
  const result = fx.measure();
  assert.equal(result.rawBytes, 1_021);
  assert.equal(result.code, 1);
});

test("missing entry, missing directory or invalid plan cannot enforce", (t) => {
  const fx = fixture(t);
  rmSync(join(fx.artifactDir, "_worker.js"));
  assert.equal(fx.measure().code, 2);
  rmSync(fx.artifactDir, { recursive: true });
  assert.equal(fx.measure().code, 2);
  fx.base.worker.maxRawBytes = 1_021;
  fx.save();
  assert.equal(fx.measure().code, 2, "base must be measured main plus 2%, not a silent raise");
});

test("final-artifact ceiling consumes the same additive ledger", (t) => {
  const fx = fixture(t);
  const unit = "deploy-worker-raw";
  mkdirSync(join(fx.root, `ci/budgets/decisions/${unit}`), { recursive: true });
  writeFileSync(
    join(fx.root, `ci/budgets/decisions/${unit}/2026-10-28-feature.md`),
    `---\n${JSON.stringify({
      unit,
      delta_bytes: 5,
      before_bytes: 1_000,
      after_bytes: 1_023,
      cause: "Measured new feature; no duplicate imports.",
      pr: 42,
    })}\n---\n`,
  );
  writeFileSync(join(fx.artifactDir, "_worker.js"), "x".repeat(1_023));
  const result = fx.measure();
  assert.equal(result.maxRawBytes, 1_025);
  assert.equal(result.code, 0);
});
