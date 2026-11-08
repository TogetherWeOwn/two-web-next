import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { executeCanonicalBuild } from "./kit-canonical-execute.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "canonical-execute-")));
after(() => rmSync(base, { recursive: true, force: true }));
const B = "1fe09ab868a6fea4a7873e4a096523b78747b232";
const TREE = "454843aa9ac7b9f911020108ba539a4353ee977d";
const D = "d".repeat(40);
let counter = 0;
function fixture() {
  const root = join(base, String(counter++));
  const collector = join(root, "collector");
  const candidate = join(root, "candidate");
  mkdirSync(collector, { recursive: true });
  mkdirSync(candidate);
  const source = { commit: B, tree: TREE, files: [{ path: "candidate-only" }] };
  const collected = { commit: D, files: [{ path: "collector-only" }] };
  const binding = {
    schema: "two.kit-canonical-source.v1",
    evidence: "unqualified-source-identity-only",
    trackedFilesOnly: true,
    cell: "B",
    sourcePatch: { base: B, files: [] },
    collector: collected,
    candidate: {
      ...source,
      installBoundary: {
        evidence: "observed-pristine-pre-install-source-only",
        ignoredEntries: 0,
        untrackedEntries: 0,
      },
    },
  };
  const bindingPath = join(root, "binding.json");
  const args = {
    collector,
    candidate,
    destination: join(root, "output"),
    bindingPath,
    context: { cell: "B", candidateSha: B, collectorSha: D, runId: "123", runAttempt: "1" },
  };
  const save = () => {
    const bytes = JSON.stringify(binding);
    writeFileSync(bindingPath, bytes);
    args.bindingSha256 = sha256(bytes);
  };
  save();
  const calls = [];
  const authority = Object.freeze({ candidate: true });
  const collaborators = {
    inspect: (path, sha) => {
      calls.push(`inspect:${sha}`);
      assert.equal(path, sha === B ? candidate : collector);
      return sha === B ? source : collected;
    },
    build: async (path, sha, capture) => {
      assert.equal(path, candidate);
      assert.equal(sha, B);
      calls.push("build");
      const result = await capture({ root: candidate, authority, producerOutcome: "success" });
      calls.push("returned");
      return { capture: result, executionVerified: false };
    },
    capture: (path, output, context, inventory) => {
      calls.push("capture");
      assert.equal(path, candidate);
      assert.equal(output, join(args.destination, "capture"));
      assert.equal(context.sourceSha, B);
      assert.equal(context.workflowSha, D);
      assert.equal(context.sourceBindingSha256, args.bindingSha256);
      assert.equal(context.captureBoundary, "build-process-return");
      assert.equal(inventory, authority);
      return { qualified: false };
    },
    finalize: async (path, output, context, inventory) => {
      calls.push("finalize");
      assert.equal(path, candidate);
      assert.equal(output, join(args.destination, "capture"));
      assert.equal(context.producerOutcome, "success");
      assert.equal(inventory, authority);
      return { qualified: false };
    },
  };
  return { args, binding, save, calls, authority, collaborators };
}

test("execution awaits capture and retains distinct source identities", async () => {
  const f = fixture();
  const result = await executeCanonicalBuild(f.args, f.collaborators);
  assert.deepEqual(f.calls, [
    `inspect:${D}`,
    `inspect:${B}`,
    "build",
    "capture",
    "returned",
    `inspect:${D}`,
    "finalize",
  ]);
  assert.equal(result.identity.candidateSha, B);
  assert.equal(result.identity.collectorSha, D);
  assert.equal(result.executionVerified, false);
  assert.equal(result.dependenciesVerified, false);
  assert.equal(result.qualified, false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.args.destination, "execution.json"))), result);
  assert.deepEqual(
    readFileSync(join(f.args.destination, "source-binding.json")),
    readFileSync(f.args.bindingPath),
  );
});

for (const kind of ["digest", "tree", "source", "overlay", "patch", "cell"]) {
  test(`execution refuses binding ${kind} drift before build`, async () => {
    const f = fixture();
    if (kind === "tree") f.binding.candidate.tree = "0".repeat(40);
    if (kind === "source") f.binding.candidate.files = [];
    if (kind === "overlay") f.binding.candidate.installBoundary.ignoredEntries = 1;
    if (kind === "patch") f.binding.sourcePatch.files.push("overlay.js");
    if (kind === "cell") f.binding.cell = "P";
    f.save();
    if (kind === "digest") f.args.bindingSha256 = "0".repeat(64);
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators));
    assert.equal(f.calls.includes("build"), false);
    assert.equal(existsSync(f.args.destination), false);
  });
}

test("execution propagates build failure without finalization or retry", async () => {
  const f = fixture();
  const failure = new Error("build failure fixture");
  let attempts = 0;
  f.collaborators.build = async (_root, _sha, capture) => {
    attempts++;
    await capture({ root: f.args.candidate, authority: f.authority, producerOutcome: "failure" });
    throw failure;
  };
  await assert.rejects(
    executeCanonicalBuild(f.args, f.collaborators),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(f.calls.includes("capture"), true);
  assert.equal(f.calls.includes("finalize"), false);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

for (const kind of ["overlap", "alias", "existing"]) {
  test(`execution refuses ${kind} output before candidate execution`, async () => {
    const f = fixture();
    if (kind === "overlap") f.args.destination = join(f.args.candidate, "output");
    if (kind === "alias") {
      const link = join(dirname(f.args.destination), "alias");
      symlinkSync(f.args.candidate, link);
      f.args.destination = join(link, "output");
    }
    if (kind === "existing") mkdirSync(f.args.destination);
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators));
    assert.equal(f.calls.includes("build"), false);
  });
}

test("execution refuses a missing build return rather than finalizing stale bytes", async () => {
  const f = fixture();
  f.collaborators.build = async () => ({});
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /return not observed/);
  assert.equal(f.calls.includes("finalize"), false);
});

test("execution CLI refuses invalid identity without exposing arguments", () => {
  const script = fileURLToPath(new URL("kit-canonical-execute.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--build", "PRIVATE-ARGUMENT"], {
    cwd: join(dirname(script), ".."),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "canonical separated execution failed; retain existing output without retry\n",
  );
});
