import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const { jobs } = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const producer = jobs["route-evidence-producer"];
const consumer = jobs["route-evidence-admission"];
const gate = jobs["ci-ok"];
const step = (job, name) => job.steps.find((item) => item.name === name);

function shell(script, env) {
  const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("synthetic evidence uses only isolated pinned jobs and direct upload outputs", () => {
  assert.equal(producer.needs, undefined);
  assert.deepEqual(consumer.needs, ["route-evidence-producer"]);
  assert.ok(gate.needs.includes("route-evidence-admission"));
  assert.equal(producer.if, "${{ github.event_name == 'pull_request' }}");
  assert.doesNotMatch(consumer.if, /needs\.scope|docs_only|draft/);
  assert.match(consumer.if, /!cancelled\(\)/);
  assert.deepEqual(producer.permissions, { contents: "read" });
  assert.deepEqual(consumer.permissions, {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
  });
  for (const job of [producer, consumer]) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    const [guard, checkout, setup] = job.steps;
    assert.match(guard.run, /ROUTE_WORKFLOW_SHA.*!=.*SOURCE_SHA.*!=.*GITHUB_SHA/);
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.deepEqual(checkout.with, {
      ref: "${{ env.ROUTE_WORKFLOW_SHA }}",
      "persist-credentials": false,
    });
    assert.deepEqual(setup.with, { "node-version": 24, "package-manager-cache": false });
  }
  assert.equal(producer.env.ROUTE_WORKFLOW_SHA, consumer.env.ROUTE_WORKFLOW_SHA);
  const upload = step(producer, "Upload report");
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload.with.name, "route-evidence-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(upload.with.overwrite, false);
  assert.equal(upload.with["if-no-files-found"], "error");
  for (const [output, name] of [
    ["id", "ID"],
    ["digest", "DIGEST"],
  ]) {
    assert.equal(
      producer.outputs[`artifact_${output}`],
      `\${{ steps.upload.outputs.artifact-${output} }}`,
    );
    assert.equal(
      step(consumer, "Admit synthetic report").env[`ROUTE_ARTIFACT_${name}`],
      `\${{ needs.route-evidence-producer.outputs.artifact_${output} }}`,
    );
  }
  const unbound = shell(consumer.steps[0].run, { GITHUB_EVENT_NAME: "merge_group" });
  assert.equal(unbound.status, 1);
  assert.match(unbound.stdout, /no reviewed merge-group source binding/);
});
