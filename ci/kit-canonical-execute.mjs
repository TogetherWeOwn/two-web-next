// Execution entrypoint for reviewed collector code; never dispatched automatically.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_CHECK_IDS, KIT_GROUP_IDS } from "./bundle-inventory.mjs";
import { captureCanonicalBuild, finalizeCanonicalCapture } from "./kit-canonical-capture.mjs";
import {
  bindCanonicalSources,
  canonicalCellIdentity,
  inspectCanonicalSource,
  runCanonicalCandidateBudget,
  runCanonicalCandidateBuild,
} from "./kit-canonical-source.mjs";
import { verifyCanonicalBuild } from "./kit-upload-rehearsal.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BINDING_BYTES = 16 * 1024 * 1024;
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;

function separate(a, b) {
  const path = relative(a, b);
  assert.ok(path === ".." || path.startsWith(`..${sep}`), "execution paths overlap");
}

function paths(collector, candidate, output) {
  for (const path of [collector, candidate]) {
    assert.equal(realpathSync(path), path, "execution source alias");
    assert.ok(lstatSync(path).isDirectory(), "execution source missing");
  }
  separate(collector, candidate);
  separate(candidate, collector);
  for (const root of [collector, candidate]) {
    separate(root, output);
    separate(output, root);
  }
  assert.equal(realpathSync(dirname(output)), dirname(output), "execution output parent alias");
}

// Compare the candidate's aggregate report with independent per-file raw/gzip
// sums from the already frozen bytes. The candidate still owns its ceilings;
// agreement here is neither independent budget-policy nor execution acceptance.
export function verifyCanonicalBudgetReport(report, frozen) {
  assert.equal(report?.version, 1, "candidate report version mismatch");
  assert.equal(report.check, "kit-perf", "candidate report checker mismatch");
  assert.equal(report.ok, true, "candidate report is not successful");
  assert.equal(report.exitCode, 0, "candidate report exit mismatch");
  assert.equal(report.error, undefined, "candidate report contains an error");
  for (const groups of [report.groups, frozen.groups]) {
    assert.ok(Array.isArray(groups), "canonical budget groups missing");
    assert.deepEqual(
      groups.map((group) => group.id),
      KIT_GROUP_IDS,
      "canonical budget group identity mismatch",
    );
  }
  for (const [index, group] of report.groups.entries()) {
    const actual = frozen.groups[index];
    for (const value of [actual.files, actual.bytes, actual.gzipBytes]) {
      assert.ok(Number.isSafeInteger(value) && value > 0, "invalid frozen budget total");
    }
    assert.ok(
      group.status === "pass" || (group.id === "kit.server.js" && group.status === "warn"),
      "candidate budget group is not successful",
    );
    assert.ok(Array.isArray(group.checks) && group.checks.length === 1, "budget check count");
    const check = group.checks[0];
    assert.equal(check.id, KIT_CHECK_IDS[index], "candidate budget check identity mismatch");
    assert.equal(check.status, group.status, "candidate budget check status mismatch");
    assert.equal(check.rawBytes, actual.bytes, "candidate budget raw total mismatch");
    assert.equal(check.gzipBytes, actual.gzipBytes, "candidate budget gzip total mismatch");
    if (group.id === "kit.worker") {
      assert.equal(actual.files, 1, "canonical Worker count mismatch");
      if (check.files !== undefined) {
        assert.equal(check.files, 1, "candidate budget file count mismatch");
      }
    } else {
      assert.equal(check.files, actual.files, "candidate budget file count mismatch");
    }
  }
  return { evidence: "unqualified-frozen-budget-totals", groups: frozen.groups };
}

export async function executeCanonicalBuild(
  { collector, candidate, destination, bindingPath, bindingSha256, context },
  {
    inspect = inspectCanonicalSource,
    build = runCanonicalCandidateBuild,
    budget = runCanonicalCandidateBudget,
    verifyBytes = verifyCanonicalBuild,
    capture = captureCanonicalBuild,
    finalize = finalizeCanonicalCapture,
  } = {},
) {
  context = { ...context };
  const identity = canonicalCellIdentity(context);
  assert.match(context.runId, /^[1-9][0-9]*$/, "explicit run ID required");
  assert.match(context.runAttempt, /^[1-9][0-9]*$/, "explicit run attempt required");
  assert.match(bindingSha256, /^[0-9a-f]{64}$/, "explicit binding digest required");
  collector = resolve(collector);
  candidate = resolve(candidate);
  const output = resolve(destination);
  paths(collector, candidate, output);
  const path = resolve(bindingPath);
  assert.equal(realpathSync(path), path, "source binding alias");
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_BINDING_BYTES, "binding bound");
  const bytes = readFileSync(path);
  assert.equal(bytes.length, stat.size, "source binding changed");
  assert.equal(sha256(bytes), bindingSha256, "source binding digest mismatch");
  const binding = JSON.parse(bytes.toString("utf8"));
  assert.equal(binding.schema, "two.kit-canonical-source.v1", "source binding schema mismatch");
  assert.equal(binding.evidence, "unqualified-source-identity-only", "source binding evidence");
  assert.equal(binding.trackedFilesOnly, true, "source binding scope");
  assert.equal(binding.cell, identity.cell, "source binding cell mismatch");
  assert.deepEqual(binding.sourcePatch, { base: identity.candidateSha, files: [] });
  assert.equal(binding.candidate.tree, identity.candidateTree, "candidate tree mismatch");
  const { installBoundary, ...source } = binding.candidate;
  assert.deepEqual(installBoundary, {
    evidence: "observed-pristine-pre-install-source-only",
    ignoredEntries: 0,
    untrackedEntries: 0,
  });
  assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  assert.deepEqual(inspect(candidate, identity.candidateSha), source);
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(output, "source-binding.json"), bytes, { flag: "wx", mode: 0o600 });
  const capturePath = join(output, "capture");
  const captureContext = {
    sourceSha: identity.candidateSha,
    workflowSha: identity.collectorSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceBindingSha256: bindingSha256,
    captureBoundary: "build-process-return",
  };
  // The candidate interface invokes this once immediately after its build returns,
  // including failure, before checking source drift or starting any profiler.
  let authority;
  const result = await build(candidate, identity.candidateSha, (returned) => {
    assert.equal(returned.root, candidate, "candidate build root changed");
    assert.equal(authority, undefined, "duplicate build return");
    authority = returned.authority;
    return capture(
      candidate,
      capturePath,
      { ...captureContext, producerOutcome: returned.producerOutcome },
      returned.authority,
    );
  });
  assert.ok(authority, "build return not observed");
  assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  let measured;
  let comparison;
  let budgetError;
  try {
    measured = await budget(candidate, identity.candidateSha);
    assert.deepEqual(measured.source, source, "candidate budget source changed");
    assert.ok([0, 1, 2].includes(measured.code), "candidate budget exit invalid");
    writeFileSync(join(output, "budget.json"), encode(measured), { flag: "wx", mode: 0o600 });
    assert.equal(measured.code, 0, "candidate budget failed");
    comparison = verifyCanonicalBudgetReport(
      measured.report,
      verifyBytes(join(capturePath, "bytes"), authority),
    );
  } catch (error) {
    budgetError = error;
  }
  // Even a failed budget must verify the already captured bytes, not recopy the
  // now-observed output. A finalizer failure must not hide the original failure.
  let journal;
  try {
    journal = await finalize(
      candidate,
      capturePath,
      { ...captureContext, producerOutcome: "success" },
      authority,
    );
  } catch (error) {
    if (!budgetError) throw error;
  }
  if (budgetError) throw budgetError;
  assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  const receipt = {
    schema: "two.kit-canonical-execution.v1",
    evidence: "unqualified-source-separated-build-return",
    identity,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceBindingSha256: bindingSha256,
    build: result,
    budget: {
      code: measured.code,
      sha256: sha256(encode(measured)),
      frozenTotalsSha256: sha256(JSON.stringify(comparison.groups)),
    },
    capture: journal,
    dependenciesVerified: false,
    executionVerified: false,
    qualified: false,
  };
  writeFileSync(join(output, "execution.json"), encode(receipt), { flag: "wx", mode: 0o600 });
  return receipt;
}

async function main() {
  const [phase, candidate, candidateSha, collectorSha, destination, ...extra] =
    process.argv.slice(2);
  const context = { cell: "B", candidateSha, collectorSha };
  assert.equal(ROOT, process.cwd(), "invoke from the pinned collector root");
  canonicalCellIdentity(context);
  if (phase === "--bind") {
    assert.equal(extra.length, 0, "unexpected binding arguments");
    const output = resolve(destination);
    paths(ROOT, resolve(candidate), output);
    const binding = bindCanonicalSources(ROOT, candidate, context);
    writeFileSync(output, encode(binding), { flag: "wx", mode: 0o600 });
    console.log(sha256(readFileSync(output)));
    return;
  }
  assert.equal(phase, "--build", "expected --bind or --build");
  assert.equal(extra.length, 4, "expected binding path/digest and run ID/attempt");
  // The pipeline must launch this phase with an explicitly credential-free env.
  // Never pass the caller's token-bearing environment into candidate code.
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CI"]);
  assert.ok(
    Object.keys(process.env).every((key) => allowed.has(key)),
    "unexpected execution env",
  );
  const [bindingPath, bindingSha256, runId, runAttempt] = extra;
  await executeCanonicalBuild({
    collector: ROOT,
    candidate,
    destination,
    bindingPath,
    bindingSha256,
    context: { ...context, runId, runAttempt },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("canonical separated execution failed; retain existing output without retry");
    process.exitCode = 1;
  });
}
