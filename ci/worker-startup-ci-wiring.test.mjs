import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const steps = workflow.jobs.check.steps;
const diagnostic = steps.find((s) => s.run === "node ci/check-worker-startup.mjs");
const artifact = steps.find((s) => s.with?.name === "worker-startup-local");

test("local startup measurement is hard-wired after selftests and before Kit runtime consumers", () => {
  assert(diagnostic);
  assert.equal(diagnostic["continue-on-error"], undefined);
  const selftests = steps.find((s) =>
    s.run?.startsWith("node --test ci/check-worker-startup.test.mjs"),
  );
  assert(selftests.run.includes("ci/check-worker-startup.test.mjs"));
  assert(selftests.run.includes("ci/worker-startup-ci-wiring.test.mjs"));
  assert(steps.indexOf(selftests) < steps.indexOf(diagnostic));
  assert(
    steps.indexOf(diagnostic) < steps.findIndex((s) => s.run === "node ci/check-kit-perf.mjs"),
  );
  assert(diagnostic.if.includes("needs.scope.outputs.worker == 'true'"));
  assert(diagnostic.if.includes("needs.scope.outputs.draft != 'true'"));
});

test("all profiles and numeric evidence upload even on failure, not the serialized bindings", () => {
  assert(artifact);
  assert.equal(artifact.if, `always() && ${diagnostic.if}`);
  assert.equal(artifact.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.equal(artifact.with["retention-days"], 14);
  assert.deepEqual(artifact.with.path.trim().split("\n"), [
    "artifacts/worker-startup-local/*.cpuprofile",
    "artifacts/worker-startup-local/*.json",
    "artifacts/worker-startup-local/summary.md",
  ]);
  assert(steps.indexOf(artifact) > steps.indexOf(diagnostic));
});

test("startup diagnostic is separate from the unchanged readiness and whole-Worker byte gates", () => {
  const readiness = JSON.parse(
    readFileSync(new URL("./budgets/kit/startup.json", import.meta.url), "utf8"),
  );
  assert.equal(readiness.startup.maxMs, 60000);
  assert(
    Object.values(workflow.jobs).some((job) =>
      job.steps?.some((s) => s.run === "node ci/check-worker-bundle.mjs"),
    ),
  );
  assert(steps.some((s) => s.run === "node ci/kit-worker-e2e.mjs"));
});
