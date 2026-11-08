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
import { KIT_CHECK_IDS, KIT_GROUP_IDS } from "./bundle-inventory.mjs";
import { executeCanonicalBuild, verifyCanonicalBudgetReport } from "./kit-canonical-execute.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "canonical-execute-")));
after(() => rmSync(base, { recursive: true, force: true }));
const B = "1fe09ab868a6fea4a7873e4a096523b78747b232";
const TREE = "454843aa9ac7b9f911020108ba539a4353ee977d";
const D = "d".repeat(40);
let counter = 0;
function reportFixture() {
  const frozen = {
    groups: KIT_GROUP_IDS.map((id, index) => ({
      id,
      files: index + 1,
      bytes: (index + 1) * 100,
      gzipBytes: (index + 1) * 50,
    })),
  };
  const report = {
    version: 1,
    check: "kit-perf",
    ok: true,
    exitCode: 0,
    groups: frozen.groups.map((group, index) => ({
      id: group.id,
      status: "pass",
      checks: [
        {
          id: KIT_CHECK_IDS[index],
          status: "pass",
          rawBytes: group.bytes,
          gzipBytes: group.gzipBytes,
          ...(index === 0 ? {} : { files: group.files }),
        },
      ],
    })),
  };
  return { frozen, report };
}

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
  const { report, frozen } = reportFixture();
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
    budget: async (path, sha) => {
      calls.push("budget");
      assert.equal(path, candidate);
      assert.equal(sha, B);
      return { source, code: 0, report, executionVerified: false };
    },
    verifyBytes: (path, inventory) => {
      calls.push("verifyBytes");
      assert.equal(path, join(args.destination, "capture/bytes"));
      assert.equal(inventory, authority);
      return frozen;
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
  return { args, binding, save, calls, authority, collaborators, report, frozen };
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
    "budget",
    "verifyBytes",
    "finalize",
    `inspect:${D}`,
  ]);
  assert.equal(result.budget.code, 0);
  assert.equal(result.budget.frozenTotalsSha256, sha256(JSON.stringify(f.frozen.groups)));
  assert.equal(result.budget.sha256, sha256(readFileSync(join(f.args.destination, "budget.json"))));
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

for (const code of [1, 2]) {
  test(`execution retains failed candidate budget ${code} and still finalizes`, async () => {
    const f = fixture();
    const budget = f.collaborators.budget;
    f.collaborators.budget = async (...args) => ({ ...(await budget(...args)), code });
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /budget failed/);
    assert.equal(f.calls.filter((call) => call === "budget").length, 1);
    assert.equal(f.calls.includes("finalize"), true);
    assert.equal(JSON.parse(readFileSync(join(f.args.destination, "budget.json"))).code, code);
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

test("execution preserves checker error when frozen-byte verification also fails", async () => {
  const f = fixture();
  const failure = new Error("candidate checker failure fixture");
  f.collaborators.budget = async () => {
    throw failure;
  };
  f.collaborators.finalize = async () => {
    throw new Error("finalizer failure fixture");
  };
  await assert.rejects(
    executeCanonicalBuild(f.args, f.collaborators),
    (error) => error === failure,
  );
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

test("execution never accepts successful budgets after failed finalization", async () => {
  const f = fixture();
  f.collaborators.finalize = async () => {
    throw new Error("frozen bytes changed");
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /frozen bytes changed/);
  assert.equal(f.calls.includes("budget"), true);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

test("execution refuses budget source substitution before writing a report", async () => {
  const f = fixture();
  f.collaborators.budget = async () => ({ source: f.binding.collector, code: 0 });
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /budget source changed/);
  assert.equal(f.calls.includes("finalize"), true);
  assert.equal(existsSync(join(f.args.destination, "budget.json")), false);
});

test("frozen report comparison preserves server warnings and implicit single Worker count", () => {
  const { report, frozen } = reportFixture();
  report.groups[1].status = "warn";
  report.groups[1].checks[0].status = "warn";
  assert.deepEqual(verifyCanonicalBudgetReport(report, frozen), {
    evidence: "unqualified-frozen-budget-totals",
    groups: frozen.groups,
  });
  report.groups[0].checks[0].files = 1;
  assert.deepEqual(verifyCanonicalBudgetReport(report, frozen).groups, frozen.groups);
});

for (const index of [0, 1, 2, 3]) {
  for (const field of ["rawBytes", "gzipBytes", "files"]) {
    test(`frozen report comparison refuses ${KIT_GROUP_IDS[index]} ${field} drift`, () => {
      const { report, frozen } = reportFixture();
      const check = report.groups[index].checks[0];
      check[field] = (check[field] ?? 1) + 1;
      assert.throws(() => verifyCanonicalBudgetReport(report, frozen), /mismatch/);
    });
  }
}

for (const [name, mutate] of Object.entries({
  version: (r) => {
    r.version = 2;
  },
  checker: (r) => {
    r.check = "worker-budget";
  },
  ok: (r) => {
    r.ok = false;
  },
  exit: (r) => {
    r.exitCode = 1;
  },
  error: (r) => {
    r.error = { code: "CANNOT_ENFORCE" };
  },
  missing: (r) => {
    r.groups.pop();
  },
  duplicate: (r) => {
    r.groups[3] = structuredClone(r.groups[2]);
  },
  extra: (r) => {
    r.groups.push(structuredClone(r.groups[0]));
  },
  reordered: (r) => {
    r.groups.reverse();
  },
  checkId: (r) => {
    r.groups[0].checks[0].id = "kit.server.js";
  },
  extraCheck: (r) => {
    r.groups[0].checks.push(structuredClone(r.groups[0].checks[0]));
  },
  missingCount: (r) => {
    delete r.groups[1].checks[0].files;
  },
  failedGroup: (r) => {
    r.groups[0].status = "fail";
  },
  failedCheck: (r) => {
    r.groups[0].checks[0].status = "fail";
  },
  clientWarning: (r) => {
    r.groups[2].status = "warn";
    r.groups[2].checks[0].status = "warn";
  },
})) {
  test(`frozen report comparison refuses report ${name}`, () => {
    const { report, frozen } = reportFixture();
    mutate(report);
    assert.throws(() => verifyCanonicalBudgetReport(report, frozen));
  });
}

for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`frozen report comparison refuses invalid total ${value}`, () => {
    const { report, frozen } = reportFixture();
    frozen.groups[0].bytes = value;
    report.groups[0].checks[0].rawBytes = value;
    assert.throws(() => verifyCanonicalBudgetReport(report, frozen), /invalid frozen budget total/);
  });
}

for (const secondFailure of [false, true]) {
  test(`numeric mismatch stays primary with finalizer failure ${secondFailure}`, async () => {
    const f = fixture();
    f.report.groups[2].checks[0].rawBytes++;
    if (secondFailure) {
      f.collaborators.finalize = async () => {
        f.calls.push("finalize");
        throw new Error("secondary finalizer failure fixture");
      };
    }
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /raw total mismatch/);
    assert.equal(f.calls.filter((call) => call === "budget").length, 1);
    assert.equal(f.calls.includes("verifyBytes"), true);
    assert.equal(f.calls.includes("finalize"), true);
    assert.equal(existsSync(join(f.args.destination, "budget.json")), true);
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

test("execution finalizes but refuses success when frozen bytes no longer verify", async () => {
  const f = fixture();
  f.collaborators.verifyBytes = () => {
    throw new Error("frozen-byte failure fixture");
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /frozen-byte failure/);
  assert.equal(f.calls.includes("finalize"), true);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
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
