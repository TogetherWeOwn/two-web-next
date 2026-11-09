// Execution entrypoint for reviewed collector code; never dispatched automatically.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_CHECK_IDS, KIT_GROUP_IDS } from "./bundle-inventory.mjs";
import { validateEvidence as validateProfileEvidence } from "./check-worker-startup.mjs";
import { captureCanonicalBuild, finalizeCanonicalCapture } from "./kit-canonical-capture.mjs";
import {
  CANONICAL_PROFILE_FILES,
  bindCanonicalSources,
  canonicalCellIdentity,
  inspectCanonicalSource,
  installCanonicalCandidate,
  observeCanonicalRunner,
  runCanonicalCandidateBudget,
  runCanonicalCandidateBuild,
  runCanonicalCandidateProfile,
  verifyCanonicalInstalledInputs,
} from "./kit-canonical-source.mjs";
import { verifyCanonicalArchiveMembers, verifyCanonicalBuild } from "./kit-upload-rehearsal.mjs";
import { verifyWranglerTool } from "./kit-wrangler-tool.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BINDING_BYTES = 16 * 1024 * 1024;
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;

function toolRecord(record, installation) {
  const prefix = installation === "web" ? "web/" : "";
  assert.equal(record.schema, "two.kit-wrangler-tool.v1");
  assert.equal(record.evidence, "installed-wrangler-package-only");
  assert.equal(record.name, "wrangler");
  assert.equal(record.version, "4.156.1");
  assert.equal(record.entry, `${prefix}node_modules/wrangler/bin/wrangler.js`);
  assert.equal(record.runtime, `${prefix}node_modules/wrangler/wrangler-dist/cli.js`);
  return record;
}

function runnerRecord(record) {
  const node = record.runner.nodeExecutable;
  assert.deepEqual(Object.keys(node).sort(), [
    "authenticated",
    "bytes",
    "evidence",
    "sha256",
    "version",
  ]);
  assert.equal(node.evidence, "observed-process-executable-only");
  assert.ok(Number.isSafeInteger(node.bytes) && node.bytes > 0 && node.bytes <= 256 * 1024 * 1024);
  assert.match(node.sha256, /^[0-9a-f]{64}$/);
  assert.match(node.version, /^v[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.equal(node.authenticated, false);
  return record;
}

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

// Consume bounded, data-only members from the separated execution output.
// Digest expectations and ZIP/transport authentication remain caller-owned;
// source identities here do not independently reconstitute either Git tree.
export function verifyCanonicalExecutionMembers(members, expected, authority) {
  try {
    const identity = canonicalCellIdentity(expected);
    assert.match(expected.runId, /^[1-9][0-9]*$/);
    assert.match(expected.runAttempt, /^[1-9][0-9]*$/);
    assert.ok(Array.isArray(members) && members.length > 5 && members.length <= 20010);
    const documents = new Map([
      ["source-binding.json", ["bindingSha256", MAX_BINDING_BYTES]],
      ["execution.json", ["executionSha256", 32 * 1024 * 1024]],
      ["budget.json", ["budgetSha256", 20 * 1024 * 1024]],
      ["capture/status.json", ["journalSha256", 16384]],
    ]);
    const parsed = new Map();
    const frozen = [];
    const profiles = new Map();
    const paths = new Set();
    let total = 0;
    for (const member of members) {
      assert.ok(typeof member.path === "string" && !paths.has(member.path));
      paths.add(member.path);
      assert.ok(member.type === "file" && Buffer.isBuffer(member.data));
      total += member.data.length;
      assert.ok(total <= 128 * 1024 * 1024);
      const document = documents.get(member.path);
      if (document) {
        const [digest, bound] = document;
        assert.match(expected[digest], /^[0-9a-f]{64}$/);
        assert.ok(member.data.length > 0 && member.data.length <= bound);
        assert.equal(sha256(member.data), expected[digest]);
        parsed.set(
          member.path,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(member.data)),
        );
      } else if (member.path.startsWith("startup/")) {
        const path = member.path.slice("startup/".length);
        assert.ok(CANONICAL_PROFILE_FILES.includes(path));
        const bound =
          path === "worker.bundle"
            ? 32 * 1024 * 1024
            : path.endsWith(".cpuprofile")
              ? 8 * 1024 * 1024
              : 1024 * 1024;
        assert.ok(member.data.length <= bound);
        assert.ok(member.data.length > 0 || path === "empty.env");
        profiles.set(path, member.data);
      } else {
        assert.ok(member.path.startsWith("capture/bytes/"));
        frozen.push({ ...member, path: member.path.slice("capture/bytes/".length) });
      }
    }
    assert.equal(parsed.size, documents.size);
    const verified = verifyCanonicalArchiveMembers(frozen, authority, expected.receiptSha256);
    const receiptBytes = frozen.find((member) => member.path === "receipt.json").data;
    const binding = parsed.get("source-binding.json");
    const execution = parsed.get("execution.json");
    const measured = parsed.get("budget.json");
    const journal = parsed.get("capture/status.json");
    assert.equal(binding.schema, "two.kit-canonical-source.v1");
    assert.equal(binding.evidence, "unqualified-source-identity-only");
    assert.equal(binding.trackedFilesOnly, true);
    assert.equal(binding.cell, identity.cell);
    assert.equal(binding.collector.commit, identity.collectorSha);
    const { installBoundary, ...source } = binding.candidate;
    assert.equal(source.commit, identity.candidateSha);
    assert.equal(source.tree, identity.candidateTree);
    assert.deepEqual(binding.sourcePatch, { base: identity.candidateSha, files: [] });
    assert.deepEqual(installBoundary, {
      evidence: "observed-pristine-pre-install-source-only",
      ignoredEntries: 0,
      untrackedEntries: 0,
    });
    assert.deepEqual(journal, {
      schema: "two.kit-canonical-separated-capture.v1",
      evidence: "unqualified-source-separated-diagnostic",
      sourceBindingSha256: expected.bindingSha256,
      sourceSha: identity.candidateSha,
      workflowSha: identity.collectorSha,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      producerOutcome: "success",
      captureBoundary: "build-process-return",
      capture: "complete",
      qualified: false,
      receipt: {
        path: "bytes/receipt.json",
        bytes: receiptBytes.length,
        sha256: expected.receiptSha256,
      },
    });
    assert.equal(execution.schema, "two.kit-canonical-execution.v1");
    assert.equal(execution.evidence, "unqualified-source-separated-build-return");
    assert.deepEqual(execution.identity, identity);
    assert.equal(execution.runId, expected.runId);
    assert.equal(execution.runAttempt, expected.runAttempt);
    assert.equal(execution.sourceBindingSha256, expected.bindingSha256);
    assert.deepEqual(execution.capture, journal);
    assert.deepEqual(execution.build.capture, journal);
    assert.deepEqual(execution.build.source, source);
    assert.equal(execution.runner.evidence, "unqualified-candidate-runner-observation");
    assert.deepEqual(execution.runner.source, source);
    assert.equal(execution.runner.executionVerified, false);
    runnerRecord(execution.runner);
    toolRecord(execution.wrangler, "root");
    toolRecord(execution.webWrangler, "web");
    assert.equal(execution.installation.evidence, "unqualified-native-candidate-install-return");
    assert.deepEqual(execution.installation.source, source);
    assert.equal(execution.installation.scriptPolicy, "ignore-scripts");
    assert.equal(execution.installation.dependenciesVerified, false);
    assert.equal(execution.installation.executionVerified, false);
    assert.deepEqual(execution.build.installBoundary, execution.installation.installBoundary);
    assert.deepEqual(measured.source, source);
    assert.equal(measured.code, 0);
    verifyCanonicalBudgetReport(measured.report, verified.receipt);
    assert.deepEqual(execution.budget, {
      code: 0,
      sha256: expected.budgetSha256,
      frozenTotalsSha256: sha256(JSON.stringify(verified.receipt.groups)),
    });
    for (const record of [execution, execution.build, measured]) {
      assert.equal(record.executionVerified, false);
    }
    assert.deepEqual([...profiles.keys()].sort(), CANONICAL_PROFILE_FILES);
    const profile = execution.profile;
    assert.equal(profile.evidence, "unqualified-candidate-profile-return");
    assert.deepEqual(profile.source, source);
    assert.equal(profile.executionVerified, false);
    assert.deepEqual(
      profile.files,
      CANONICAL_PROFILE_FILES.map((path) => ({
        path,
        bytes: profiles.get(path).length,
        sha256: sha256(profiles.get(path)),
      })),
    );
    const json = (path) => JSON.parse(profiles.get(path).toString("utf8"));
    assert.deepEqual(json("report.json"), profile.report);
    assert.equal(profile.report.identity.sha, identity.candidateSha);
    assert.deepEqual(profile.report.identity.runner, execution.runner.runner);
    assert.equal(
      profile.report.identity.wranglerSha256,
      sha256(JSON.stringify(execution.wrangler)),
    );
    assert.equal(profile.report.identity.uploadSha256, sha256(profiles.get("worker.bundle")));
    assert.equal(profiles.get("empty.env").length, 0);
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(json(`cold-${i}.json`), profile.report.runs[i - 1]);
    }
    assert.deepEqual(json("checkpoint.json"), {
      version: 1,
      metric: "local_startup_non_idle_sample_ms",
      status: "unavailable",
      identity: profile.report.identity,
      runs: profile.report.runs,
    });
    const profileStatus = validateProfileEvidence(
      profile.report,
      profile.report.identity,
      [1, 2, 3].map((i) => profiles.get(`cold-${i}.cpuprofile`)),
      profile.budget,
    );
    assert.ok(profileStatus === "pass" || profileStatus === "warn");
    assert.equal(execution.dependenciesVerified, false);
    assert.equal(execution.qualified, false);
    return {
      ...verified,
      evidence: "digest-bound-separated-execution-members",
      identity,
      sourceBindingSha256: expected.bindingSha256,
      executionSha256: expected.executionSha256,
      budgetSha256: expected.budgetSha256,
      journalSha256: expected.journalSha256,
      reportTotalsVerified: true,
      sourceTreesVerified: false,
      executionVerified: false,
    };
  } catch {
    throw new Error("canonical separated execution member verification failed");
  }
}

// Parse the complete separated output, not a prefix of a later build archive.
// Supplied digests bind bytes but do not authenticate their source or execution.
export function verifyCanonicalExecutionArtifactBytes(archive, expected, authority) {
  try {
    assert.ok(
      Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= 128 * 1024 * 1024,
    );
    assert.equal(archive.length, expected.archiveBytes);
    assert.match(expected.archiveSha256, /^[0-9a-f]{64}$/);
    assert.equal(sha256(archive), expected.archiveSha256);
    const parsed = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          fileURLToPath(new URL("./read-pure-hono-archive.py", import.meta.url)),
          "--separated",
        ],
        {
          input: archive,
          timeout: 30_000,
          maxBuffer: 384 * 1024 * 1024,
          env: {},
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
    const members = parsed.members.map(({ path, type, base64 }) => ({
      path,
      type,
      data: Buffer.from(base64, "base64"),
    }));
    const verified = verifyCanonicalExecutionMembers(members, expected, authority);
    return {
      ...verified,
      evidence: "digest-bound-separated-execution-artifact-bytes",
      archiveSha256: expected.archiveSha256,
      archiveBytes: archive.length,
      archiveScope: "complete-separated-output",
    };
  } catch {
    throw new Error("canonical separated artifact byte verification failed");
  }
}

export async function executeCanonicalBuild(
  { collector, candidate, destination, bindingPath, bindingSha256, context },
  {
    inspect = inspectCanonicalSource,
    installedInputs = verifyCanonicalInstalledInputs,
    runner = observeCanonicalRunner,
    tool = verifyWranglerTool,
    install = installCanonicalCandidate,
    build = runCanonicalCandidateBuild,
    budget = runCanonicalCandidateBudget,
    profile = runCanonicalCandidateProfile,
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
  let observedRunner;
  try {
    observedRunner = runnerRecord(await runner(candidate, identity.candidateSha));
    assert.deepEqual(observedRunner.source, source, "candidate runner source changed");
    assert.equal(observedRunner.executionVerified, false, "unsupported runner qualification");
    assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  } catch {
    writeFileSync(
      join(output, "runner-failure.json"),
      encode({ sourceBindingSha256: bindingSha256, outcome: "failure", qualified: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("canonical runner unavailable; retain output without retry");
  }
  let installation;
  try {
    installation = await install(candidate, identity.candidateSha);
    assert.deepEqual(installation.source, source, "candidate install source changed");
    assert.equal(installation.dependenciesVerified, false, "unsupported install qualification");
    assert.equal(installation.executionVerified, false, "unsupported install qualification");
    assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  } catch {
    writeFileSync(
      join(output, "install-failure.json"),
      encode({ sourceBindingSha256: bindingSha256, outcome: "failure", qualified: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("canonical install failed; retain output without retry");
  }
  let wrangler;
  let webWrangler;
  try {
    // Check both installations: the candidate build resolves its own web CLI,
    // while the profiler uses the root CLI. Transitives remain unverified.
    wrangler = toolRecord(await tool(candidate), "root");
    webWrangler = toolRecord(await tool(candidate, undefined, "web"), "web");
    assert.deepEqual(inspect(candidate, identity.candidateSha), source);
    assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  } catch {
    writeFileSync(
      join(output, "tool-failure.json"),
      encode({ sourceBindingSha256: bindingSha256, outcome: "failure", qualified: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("canonical tool unavailable; retain output without retry");
  }
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
  assert.deepEqual(
    result.installBoundary,
    installation.installBoundary,
    "candidate install inputs changed before build",
  );
  assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  let measured;
  let comparison;
  let profiled;
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
    profiled = await profile(candidate, identity.candidateSha, join(output, "startup"), {
      sha: identity.candidateSha,
      runner: observedRunner.runner,
      wranglerSha256: sha256(JSON.stringify(wrangler)),
    });
    assert.equal(profiled.evidence, "unqualified-candidate-profile-return");
    assert.deepEqual(profiled.source, source, "candidate profile source changed");
    assert.equal(profiled.executionVerified, false, "unsupported profile qualification");
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
  // Budget/profiling runs after the build's input check. Refuse later drift
  // without recopying or discarding the already finalized frozen capture.
  await installedInputs(candidate, installation.installBoundary);
  assert.deepEqual(
    await runner(candidate, identity.candidateSha),
    observedRunner,
    "candidate runner changed during execution",
  );
  assert.deepEqual(await tool(candidate), wrangler, "candidate Wrangler changed during execution");
  assert.deepEqual(
    await tool(candidate, undefined, "web"),
    webWrangler,
    "candidate web Wrangler changed during execution",
  );
  assert.deepEqual(inspect(candidate, identity.candidateSha), source);
  assert.deepEqual(inspect(collector, identity.collectorSha), binding.collector);
  const receipt = {
    schema: "two.kit-canonical-execution.v1",
    evidence: "unqualified-source-separated-build-return",
    identity,
    runId: context.runId,
    runAttempt: context.runAttempt,
    sourceBindingSha256: bindingSha256,
    runner: observedRunner,
    wrangler,
    webWrangler,
    installation,
    build: result,
    profile: profiled,
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
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "CI",
    "STARTUP_RUNNER_IMAGE",
    "GITHUB_ACTIONS",
  ]);
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
