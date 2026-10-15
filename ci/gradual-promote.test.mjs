// Gradual production promotion helpers (TOG-24384): deterministic wrangler
// versions math plus JSON parsing for the rollback target and the promoted
// version id. No network, no Cloudflare credentials: the workflow pipes
// `wrangler ... --json` output into the CLI in gradual-promote.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  GRADUAL_STEPS,
  assertVersionTag,
  latestDeployment,
  rollbackTarget,
  splitDeploySpecs,
  versionIdForTag,
} from "./gradual-promote.mjs";

const PREV = "12345678-1234-1234-1234-123456789abc";
const NEXT = "22345678-1234-1234-1234-123456789abc";
const TAG = "abc123-456-1";

function deployments(versions, created = "2026-10-15T00:00:00Z") {
  return [{ id: "d1", created_on: created, versions }];
}

test("gradual steps are exactly 5, 50 and 100 percent", () => {
  assert.deepEqual(GRADUAL_STEPS, [5, 50, 100]);
});

test("split specs name both versions so traffic totals exactly 100", () => {
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 5, previousVersionId: PREV }), {
    positional: [`${PREV}@95`],
    versionTag: `${TAG}@5%`,
  });
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 50, previousVersionId: PREV }), {
    positional: [`${PREV}@50`],
    versionTag: `${TAG}@50%`,
  });
});

test("the 100 percent step promotes the tag alone", () => {
  assert.deepEqual(splitDeploySpecs({ tag: TAG, percentage: 100, previousVersionId: PREV }), {
    positional: [],
    versionTag: `${TAG}@100%`,
  });
});

test("split specs refuse unknown percentages and bad inputs", () => {
  for (const percentage of [0, 1, 10, 25, 99, 101, Number.NaN]) {
    assert.throws(
      () => splitDeploySpecs({ tag: TAG, percentage, previousVersionId: PREV }),
      /percentage must be one of 5, 50, 100/,
    );
  }
  assert.throws(
    () => splitDeploySpecs({ tag: "", percentage: 5, previousVersionId: PREV }),
    /version tag/,
  );
  assert.throws(
    () => splitDeploySpecs({ tag: `${TAG};id`, percentage: 5, previousVersionId: PREV }),
    /version tag/,
  );
  assert.throws(
    () => splitDeploySpecs({ tag: TAG, percentage: 5, previousVersionId: "not-a-uuid" }),
    /previous version id/,
  );
});

test("version tags refuse shell metacharacters", () => {
  for (const tag of ["", "a b", "a@b", "a;b", "a$(b)", "a`b`", "a$b", "a*b", "-lead"]) {
    assert.throws(() => assertVersionTag(tag), /version tag/);
  }
  assert.doesNotThrow(() => assertVersionTag(TAG));
});

test("rollback target is the live version of a single-version deployment", () => {
  assert.equal(rollbackTarget(deployments([{ version_id: PREV, percentage: 100 }])), PREV);
});

test("rollback target refuses split deployments and non-100 traffic", () => {
  assert.throws(
    () =>
      rollbackTarget(
        deployments([
          { version_id: PREV, percentage: 95 },
          { version_id: NEXT, percentage: 5 },
        ]),
      ),
    /single-version 100% deployment/,
  );
  assert.throws(() => rollbackTarget(deployments([{ version_id: PREV, percentage: 50 }])), /100/);
  assert.throws(() => rollbackTarget([]), /deployment/);
  assert.throws(() => rollbackTarget("nope"), /deployment/);
});

test("latest deployment wins by created_on, not array order", () => {
  const older = {
    id: "d1",
    created_on: "2026-10-14T00:00:00Z",
    versions: [{ version_id: PREV, percentage: 100 }],
  };
  const newer = {
    id: "d2",
    created_on: "2026-10-15T00:00:00Z",
    versions: [{ version_id: NEXT, percentage: 100 }],
  };
  assert.equal(latestDeployment([older, newer]).id, "d2");
  assert.equal(latestDeployment([newer, older]).id, "d2");
  assert.throws(() => latestDeployment([]), /deployment/);
});

test("CLI resolves a deploy spec for the workflow without shell interpolation", () => {
  const good = spawnSync(
    process.execPath,
    ["ci/gradual-promote.mjs", "--deploy-spec", TAG, "5", PREV],
    { encoding: "utf8" },
  );
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(good.stdout.split("\n").slice(0, 2), [`${PREV}@95`, `${TAG}@5%`]);
  const full = spawnSync(
    process.execPath,
    ["ci/gradual-promote.mjs", "--deploy-spec", TAG, "100", PREV],
    { encoding: "utf8" },
  );
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(full.stdout.split("\n").slice(0, 2), ["", `${TAG}@100%`]);
  const hostile = spawnSync(
    process.execPath,
    ["ci/gradual-promote.mjs", "--deploy-spec", `${TAG};printf HARMLESS`, "5", PREV],
    { encoding: "utf8" },
  );
  assert.equal(hostile.status, 1);
  assert.match(hostile.stderr, /version tag/);
  assert.ok(!hostile.stdout.includes("HARMLESS") && !hostile.stderr.includes("HARMLESS"));
});

test("CLI captures the rollback target and resolves tags from piped wrangler JSON", () => {
  const target = spawnSync(
    process.execPath,
    ["ci/gradual-promote.mjs", "--capture-rollback-target"],
    {
      input: JSON.stringify([
        { created_on: "2026-10-15T00:00:00Z", versions: [{ version_id: PREV, percentage: 100 }] },
      ]),
      encoding: "utf8",
    },
  );
  assert.equal(target.status, 0, target.stderr);
  assert.equal(target.stdout.trim(), PREV);
  const refused = spawnSync(
    process.execPath,
    ["ci/gradual-promote.mjs", "--capture-rollback-target"],
    {
      input: JSON.stringify([{ created_on: "2026-10-15T00:00:00Z", versions: [] }]),
      encoding: "utf8",
    },
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

test("tag resolution needs exactly one matching version", () => {
  const versions = [
    {
      id: PREV,
      metadata: { created_on: "2026-10-14T00:00:00Z" },
      annotations: { "workers/tag": "old" },
    },
    {
      id: NEXT,
      metadata: { created_on: "2026-10-15T00:00:00Z" },
      annotations: { "workers/tag": TAG },
    },
  ];
  assert.equal(versionIdForTag(versions, TAG), NEXT);
  assert.throws(() => versionIdForTag(versions, "missing"), /No deployable version found with tag/);
  assert.throws(
    () =>
      versionIdForTag(
        [...versions, { ...versions[1], id: "32345678-1234-1234-1234-123456789abc" }],
        TAG,
      ),
    /matches multiple versions/,
  );
  assert.throws(() => versionIdForTag([], TAG), /No deployable version/);
});
