import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SERVING = "c".repeat(40);
const DRILL = "d".repeat(40);
const LIVE = "11111111-1111-4111-8111-111111111111";
const REPO = "fixture/repo";

const up = (revision) => [{ match: "next.togetherweown.com/up", body: { revision } }];
const contents = (entry) => [
  { match: "/contents/ci/rollback-target.mjs", ...(entry ?? { status: 200, body: {} }) },
];

function spawnRef(env, stub) {
  return spawnSync(
    process.execPath,
    ["--import", "./ci/test-fetch-stub.mjs", "ci/drill-scripts-ref.mjs"],
    {
      env: {
        ...process.env,
        LIVE,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: "fixture-token",
        GITHUB_SHA: DRILL,
        FETCH_STUB_JSON: JSON.stringify(stub),
        ...env,
      },
      encoding: "utf8",
    },
  );
}

const liveUp = (overrides = {}) => ({
  version_id: LIVE,
  commit: SERVING,
  ...overrides,
});

test("a serving commit with the scripts resolves to itself", () => {
  const result = spawnRef({}, [...contents(), ...up(liveUp())]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, SERVING);
});

test("a serving commit that predates the scripts falls back to the drill revision", () => {
  const result = spawnRef({}, [...contents({ status: 404 }), ...up(liveUp())]);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, DRILL);
  assert.match(result.stderr, /::notice::/);
  assert.match(result.stderr, new RegExp(`staging serves ${SERVING}`));
  assert.match(result.stderr, new RegExp(`drill revision \\(${DRILL}\\)`));
});

test("removing the fallback fails: a 404 without it is not a silent pass", () => {
  // Pins the contract the plan step relies on: only exit 3 means fallback.
  const result = spawnRef({}, [...contents({ status: 404 }), ...up(liveUp())]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, DRILL);
});

test("a GitHub error is a hard failure, never a fallback", () => {
  for (const status of [403, 500]) {
    const result = spawnRef({}, [...contents({ status }), ...up(liveUp())]);
    assert.equal(result.status, 1, `HTTP ${status}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
  }
});

test("an unreadable script check is a hard failure, never a fallback", () => {
  const result = spawnRef({}, [...contents({ fail: true }), ...up(liveUp())]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /::error::rollback script check failed/);
});

test("an unreadable or untrusted /up is a hard failure with no ref", () => {
  const down = spawnRef({}, [...contents(), { match: "next.togetherweown.com/up", fail: true }]);
  assert.equal(down.status, 1);
  assert.equal(down.stdout, "");
  assert.match(down.stderr, /::error::staging \/up unreadable/);

  const wrongVersion = spawnRef({}, [...contents(), ...up(liveUp({ version_id: "nope" }))]);
  assert.equal(wrongVersion.status, 1);
  assert.equal(wrongVersion.stdout, "");
  assert.match(wrongVersion.stderr, /does not name the live version/);

  const badCommit = spawnRef({}, [...contents(), ...up(liveUp({ commit: "main" }))]);
  assert.equal(badCommit.status, 1);
  assert.equal(badCommit.stdout, "");
});

test("missing inputs are a usage error", () => {
  const result = spawnRef({ LIVE: "" }, [...contents(), ...up(liveUp())]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("the drill plan resolves the ref through the helper and fails on anything but the fallback", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/staging-rollback-drill.yml", import.meta.url),
    "utf8",
  );
  const plan = workflow.slice(
    workflow.indexOf("Record the live and previous"),
    workflow.indexOf("\n  rollback:\n"),
  );
  assert.match(plan, /LIVE="\$live" node ci\/drill-scripts-ref\.mjs/);
  assert.match(plan, /rc=\$\?/);
  assert.match(plan, /-eq 3/);
  assert.match(plan, /-ne 0/);
  assert.ok(!plan.includes("api.github.com/repos"), "no inline Contents probe beside the helper");
});
