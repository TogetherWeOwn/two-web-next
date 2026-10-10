import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolvePromotionSha } from "./resolve-promotion-sha.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TIP = "f".repeat(40);

// runs: newest first, as the API returns them; jobs: run id -> staging-journeys conclusion.
function stub(runs, jobs) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/actions/workflows/e2e-staging.yml/runs")) {
      assert.equal(searchParams.get("branch"), "main");
      assert.equal(searchParams.get("event"), "workflow_run");
      assert.equal(
        searchParams.get("status"),
        null,
        "never hide failed runs behind a success filter",
      );
      const page = Number(searchParams.get("page"));
      return { ok: true, json: async () => ({ workflow_runs: page === 1 ? runs : [] }) };
    }
    const id = pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (id) {
      const conclusion = jobs[id];
      return {
        ok: true,
        json: async () => ({ jobs: conclusion ? [{ name: "staging-journeys", conclusion }] : [] }),
      };
    }
    assert.fail(`unexpected ${pathname}`);
  };
}
const run = (id, deployed, conclusion = "success", status = "completed") => ({
  id,
  // API head_sha is main's tip for workflow_run runs; only the run-name names the deployed commit.
  head_sha: TIP,
  display_title: `e2e-staging deploy ${deployed}`,
  status,
  conclusion,
});
const resolve = (runs, jobs) =>
  resolvePromotionSha({ repository: "o/r", token: "t", fetchImpl: stub(runs, jobs) });

test("promotes the deployed commit from the run-name, not the run's head_sha", async () => {
  assert.equal(await resolve([run(2, A)], { 2: "success" }), A);
});

test("skips a commit whose journeys were skipped and takes the newest verified one", async () => {
  assert.equal(await resolve([run(3, A), run(2, B)], { 3: "skipped", 2: "success" }), B);
});

test("a newer failed run of a commit is not outvoted by an older pass of the same commit", async () => {
  assert.equal(
    await resolve([run(3, A, "failure"), run(2, A), run(1, B)], { 2: "success", 1: "success" }),
    B,
  );
});

test("an in-progress run neither promotes nor blocks its commit's older verdict", async () => {
  assert.equal(await resolve([run(3, A, null, "in_progress"), run(2, A)], { 2: "success" }), A);
});

test("runs without a deployed SHA in their name (pre run-name) are ignored", async () => {
  const old = { ...run(5, A), display_title: "e2e-staging" };
  assert.equal(await resolve([old], { 5: "success" }), null);
});

test("deploy.yml and e2e-staging.yml run-names carry the deployed SHA", () => {
  const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const e2e = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    deploy,
    /^run-name: deploy \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}$/m,
  );
  assert.match(
    e2e,
    /^run-name: e2e-staging \$\{\{ github\.event\.workflow_run\.display_title \|\| github\.sha \}\}$/m,
  );
});

test("deploy-production resolves through this script and gates the resolved DEPLOY_SHA", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /run: node ci\/resolve-promotion-sha\.mjs\n/);
  assert.ok(!workflow.includes("e2e-staging.yml/runs"), "no inline resolver left");
});
