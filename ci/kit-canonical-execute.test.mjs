import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { readCanonicalExecutionArtifact } from "./kit-canonical-artifact.mjs";
import {
  executeCanonicalBuild,
  verifyCanonicalBudgetReport,
  verifyCanonicalExecutionArtifactBytes,
  verifyCanonicalExecutionMembers,
} from "./kit-canonical-execute.mjs";
import { summarizeProfile } from "./check-worker-startup.mjs";
import { CANONICAL_PROFILE_FILES, canonicalCellIdentity } from "./kit-canonical-source.mjs";
import { createCanonicalReceipt } from "./kit-upload-rehearsal.mjs";
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

function toolFixture(installation = "root") {
  const prefix = installation === "web" ? "web/" : "";
  return {
    schema: "two.kit-wrangler-tool.v1",
    evidence: "installed-wrangler-package-only",
    name: "wrangler",
    version: "4.156.1",
    entry: `${prefix}node_modules/wrangler/bin/wrangler.js`,
    runtime: `${prefix}node_modules/wrangler/wrangler-dist/cli.js`,
    files: [{ path: "fixture", bytes: 1, sha256: "a".repeat(64) }],
  };
}

function runnerFixture(source) {
  return {
    evidence: "unqualified-candidate-runner-observation",
    source,
    inputs: [],
    runner: { image: "fixture-image", limits: { effectiveCpuCount: 2 } },
    executionVerified: false,
  };
}

function profileFixture(source, identity) {
  const profile = {
    nodes: [{ id: 1, callFrame: { functionName: "fixture" } }],
    samples: [1, 1],
    timeDeltas: [500, 500],
    startTime: 0,
    endTime: 1000,
  };
  const raw = Buffer.from(JSON.stringify(profile));
  const upload = Buffer.from("inert upload fixture");
  const bound = { ...identity, uploadSha256: sha256(upload) };
  const runs = [1, 2, 3].map((invocation) => ({
    invocation,
    completed: true,
    uploadSha256: bound.uploadSha256,
    profile: `cold-${invocation}.cpuprofile`,
    profileSha256: sha256(raw),
    measurement: summarizeProfile(profile),
  }));
  const report = {
    version: 1,
    metric: "local_startup_non_idle_sample_ms",
    authoritativeStartup: "unavailable",
    productionMargin: "unmet",
    identity: bound,
    runs,
    maximumMs: 1,
    status: "pass",
  };
  const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
  const contents = new Map([
    ["worker.bundle", upload],
    ["empty.env", Buffer.alloc(0)],
    ["report.json", json(report)],
    [
      "checkpoint.json",
      json({
        version: 1,
        metric: report.metric,
        status: "unavailable",
        identity: bound,
        runs,
      }),
    ],
    ...[1, 2, 3].flatMap((i) => [
      [`cold-${i}.cpuprofile`, raw],
      [`cold-${i}.json`, json(runs[i - 1])],
    ]),
  ]);
  return {
    members: CANONICAL_PROFILE_FILES.map((path) => ({
      path: `startup/${path}`,
      type: "file",
      data: contents.get(path),
    })),
    result: {
      evidence: "unqualified-candidate-profile-return",
      source,
      inputs: [],
      budget: {
        version: 1,
        metric: report.metric,
        runs: 3,
        warnMs: 400,
        failMs: 700,
        tools: { wrangler: "4.156.1", miniflare: "fixture", workerd: "fixture" },
      },
      report,
      files: CANONICAL_PROFILE_FILES.map((path) => ({
        path,
        bytes: contents.get(path).length,
        sha256: sha256(contents.get(path)),
      })),
      executionVerified: false,
    },
  };
}

function installationFixture(source) {
  return {
    evidence: "unqualified-native-candidate-install-return",
    source,
    scriptPolicy: "ignore-scripts",
    installBoundary: { evidence: "fixture" },
    dependenciesVerified: false,
    executionVerified: false,
  };
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
    runner: async (path, sha) => {
      calls.push("runner");
      assert.equal(path, candidate);
      assert.equal(sha, B);
      return runnerFixture(source);
    },
    tool: async (path, expected, installation = "root") => {
      calls.push(installation === "web" ? "web-tool" : "tool");
      assert.equal(path, candidate);
      assert.equal(expected, undefined);
      return toolFixture(installation);
    },
    install: async (path, sha) => {
      calls.push("install");
      assert.equal(path, candidate);
      assert.equal(sha, B);
      return installationFixture(source);
    },
    build: async (path, sha, capture) => {
      assert.equal(path, candidate);
      assert.equal(sha, B);
      calls.push("build");
      const result = await capture({ root: candidate, authority, producerOutcome: "success" });
      calls.push("returned");
      return {
        capture: result,
        installBoundary: installationFixture(source).installBoundary,
        executionVerified: false,
      };
    },
    budget: async (path, sha) => {
      calls.push("budget");
      assert.equal(path, candidate);
      assert.equal(sha, B);
      return { source, code: 0, report, executionVerified: false };
    },
    profile: async (path, sha, output, identity) => {
      calls.push("profile");
      assert.equal(path, candidate);
      assert.equal(sha, B);
      assert.equal(output, join(args.destination, "startup"));
      assert.deepEqual(identity, {
        sha: B,
        runner: runnerFixture(source).runner,
        wranglerSha256: sha256(JSON.stringify(toolFixture())),
      });
      return profileFixture(source, identity).result;
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

function memberFixture() {
  const f = fixture();
  const authority = {
    KIT_WORKER_PATH: "web/.svelte-kit/cloudflare/_worker.js",
    KIT_SERVER_DIR: "web/.svelte-kit/output/server",
    KIT_CLIENT_DIR: "web/.svelte-kit/output/client/_app",
    KIT_GROUP_IDS,
  };
  const files = [
    authority.KIT_WORKER_PATH,
    `${authority.KIT_SERVER_DIR}/index.js`,
    `${authority.KIT_CLIENT_DIR}/start.js`,
    `${authority.KIT_CLIENT_DIR}/app.css`,
    "web/.svelte-kit/output/client/robots.txt",
    "web/.svelte-kit/cloudflare/.assetsignore",
  ];
  const members = files.map((path) => {
    mkdirSync(dirname(join(f.args.candidate, path)), { recursive: true });
    const data = Buffer.from(`${path}\r\n`);
    writeFileSync(join(f.args.candidate, path), data);
    return { path: `capture/bytes/${path}`, type: "file", data };
  });
  const frozen = createCanonicalReceipt(f.args.candidate, authority);
  const report = reportFixture().report;
  for (const [index, group] of frozen.groups.entries()) {
    Object.assign(report.groups[index].checks[0], {
      rawBytes: group.bytes,
      gzipBytes: group.gzipBytes,
      files: group.files,
    });
  }
  const expected = { ...f.args.context };
  const records = {};
  function save(path, record, digest) {
    records[path] = record;
    const data = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const index = members.findIndex((member) => member.path === path);
    const member = { path, type: "file", data };
    if (index === -1) members.push(member);
    else members[index] = member;
    expected[digest] = sha256(data);
  }
  save("capture/bytes/receipt.json", frozen, "receiptSha256");
  save("source-binding.json", f.binding, "bindingSha256");
  const journal = {
    schema: "two.kit-canonical-separated-capture.v1",
    evidence: "unqualified-source-separated-diagnostic",
    sourceBindingSha256: expected.bindingSha256,
    sourceSha: B,
    workflowSha: D,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    producerOutcome: "success",
    captureBoundary: "build-process-return",
    capture: "complete",
    qualified: false,
    receipt: {
      path: "bytes/receipt.json",
      bytes: members.find((member) => member.path === "capture/bytes/receipt.json").data.length,
      sha256: expected.receiptSha256,
    },
  };
  save("capture/status.json", journal, "journalSha256");
  const source = { ...f.binding.candidate };
  delete source.installBoundary;
  const profiled = profileFixture(source, {
    sha: B,
    runner: runnerFixture(source).runner,
    wranglerSha256: sha256(JSON.stringify(toolFixture())),
  });
  members.push(...profiled.members);
  save("budget.json", { source, code: 0, report, executionVerified: false }, "budgetSha256");
  save(
    "execution.json",
    {
      schema: "two.kit-canonical-execution.v1",
      evidence: "unqualified-source-separated-build-return",
      identity: canonicalCellIdentity(expected),
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      sourceBindingSha256: expected.bindingSha256,
      runner: runnerFixture(source),
      wrangler: toolFixture(),
      webWrangler: toolFixture("web"),
      installation: installationFixture(source),
      profile: profiled.result,
      build: {
        source,
        capture: journal,
        installBoundary: installationFixture(source).installBoundary,
        executionVerified: false,
      },
      capture: journal,
      budget: {
        code: 0,
        sha256: expected.budgetSha256,
        frozenTotalsSha256: sha256(JSON.stringify(frozen.groups)),
      },
      dependenciesVerified: false,
      executionVerified: false,
      qualified: false,
    },
    "executionSha256",
  );
  return { members, expected, authority, records, save, frozen };
}

const ZIP_BUILDER = `
import base64, io, json, sys, warnings, zipfile
warnings.simplefilter("ignore")
out = io.BytesIO()
with zipfile.ZipFile(out, "w") as archive:
    for entry in json.load(sys.stdin):
        info = zipfile.ZipInfo(entry["name"])
        info.compress_type = entry.get("compression", zipfile.ZIP_DEFLATED)
        info.external_attr = entry.get("mode", 0o100400) << 16
        archive.writestr(info, base64.b64decode(entry["base64"]))
sys.stdout.buffer.write(out.getvalue())
`;

function artifactFixture(mutate = () => {}) {
  const f = memberFixture();
  const entries = f.members.map(({ path, data }) => ({
    name: path,
    base64: data.toString("base64"),
  }));
  mutate(entries);
  const archive = execFileSync("python3", ["-I", "-c", ZIP_BUILDER], {
    input: JSON.stringify(entries),
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    ...f,
    archive,
    expected: { ...f.expected, archiveBytes: archive.length, archiveSha256: sha256(archive) },
  };
}

function authenticatedFixture() {
  const f = artifactFixture();
  const expected = {
    ...f.expected,
    producerBranch: "feat/production-kit-cutover",
    producerEvent: "workflow_dispatch",
    artifactName: `kit-canonical-separated-${B}-${D}-123-1`,
  };
  const run = {
    id: 123,
    run_attempt: 1,
    repository: { id: 42, full_name: "TogetherWeOwn/two-web-next" },
    head_repository: { id: 42, full_name: "TogetherWeOwn/two-web-next" },
    path: ".github/workflows/ci.yml",
    head_sha: D,
    head_branch: expected.producerBranch,
    event: expected.producerEvent,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123",
  };
  const artifact = {
    id: 456,
    name: expected.artifactName,
    expired: false,
    size_in_bytes: expected.archiveBytes,
    digest: `sha256:${expected.archiveSha256}`,
    workflow_run: {
      id: 123,
      repository_id: 42,
      head_repository_id: 42,
      head_branch: expected.producerBranch,
      head_sha: D,
    },
  };
  const calls = [];
  const token = "fixture-token-never-forward";
  const signed = "https://fixture.blob.core.windows.net/archive?sig=private-fixture";
  const api = "https://api.github.com/repos/TogetherWeOwn/two-web-next/actions";
  const options = {
    artifactId: "456",
    token,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === `${api}/runs/123`) return Response.json(run);
      if (url === `${api}/artifacts/456`) return Response.json(artifact);
      if (url === `${api}/artifacts/456/zip`)
        return new Response(null, { status: 302, headers: { location: signed } });
      assert.equal(url, signed);
      return new Response(f.archive);
    },
  };
  return { ...f, expected, run, artifact, calls, options, token };
}

const AUTH_FAILURE = "canonical authenticated separated artifact verification failed";

test("authenticated separated archive pins collector and candidate separately", async () => {
  const f = authenticatedFixture();
  const result = await readCanonicalExecutionArtifact(f.expected, f.authority, f.options);
  assert.deepEqual(result.receipt, f.frozen);
  assert.equal(result.identity.candidateSha, B);
  assert.equal(result.identity.collectorSha, D);
  assert.equal(result.provenance.sourceSha, D);
  assert.equal(result.provenance.artifactId, "456");
  assert.equal(result.authenticatedArchiveVerified, true);
  assert.equal(result.reportTotalsVerified, true);
  assert.equal(result.sourceTreesVerified, false);
  assert.equal(result.executionVerified, false);
  assert.equal(result.sourceSeparated, false);
  assert.equal(result.qualified, false);
  assert.equal(f.calls.length, 4);
  for (const { init } of f.calls.slice(0, 3))
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${f.token}`);
  assert.equal(f.calls[2].init.redirect, "manual");
  assert.equal(new Headers(f.calls[3].init.headers).get("authorization"), null);
  assert.equal(f.calls[3].init.redirect, "error");
  assert.ok(!JSON.stringify(result).includes(f.token));
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});

for (const [name, mutate] of Object.entries({
  "candidate as collector": (f) => {
    f.run.head_sha = B;
  },
  "artifact candidate as collector": (f) => {
    f.artifact.workflow_run.head_sha = B;
  },
  fork: (f) => {
    f.run.head_repository.id = 43;
  },
  workflow: (f) => {
    f.run.path = ".github/workflows/deploy-production.yml";
  },
  branch: (f) => {
    f.run.head_branch = "other";
  },
  event: (f) => {
    f.run.event = "pull_request";
  },
  attempt: (f) => {
    f.run.run_attempt = 2;
  },
  unfinished: (f) => {
    f.run.status = "in_progress";
  },
  failure: (f) => {
    f.run.conclusion = "failure";
  },
  expired: (f) => {
    f.artifact.expired = true;
  },
  "artifact name": (f) => {
    f.artifact.name = "other";
  },
  "archive digest": (f) => {
    f.artifact.digest = `sha256:${"0".repeat(64)}`;
  },
})) {
  test(`authenticated separated archive rejects ${name} before download`, async () => {
    const f = authenticatedFixture();
    mutate(f);
    await assert.rejects(readCanonicalExecutionArtifact(f.expected, f.authority, f.options), {
      message: AUTH_FAILURE,
    });
    assert.equal(f.calls.length, 2);
  });
}

for (const key of [
  "bindingSha256",
  "executionSha256",
  "budgetSha256",
  "journalSha256",
  "receiptSha256",
]) {
  test(`authenticated separated archive refuses independently bound ${key} drift`, async () => {
    const f = authenticatedFixture();
    f.expected[key] = "0".repeat(64);
    await assert.rejects(readCanonicalExecutionArtifact(f.expected, f.authority, f.options), {
      message: AUTH_FAILURE,
    });
    assert.equal(f.calls.length, 4);
  });
}

for (const [name, mutate] of Object.entries({
  "same source": (f) => {
    f.expected.collectorSha = B;
  },
  "invalid digest": (f) => {
    f.expected.bindingSha256 = "invalid";
  },
  "artifact name": (f) => {
    f.expected.artifactName = "other";
  },
  "feature push": (f) => {
    f.expected.producerEvent = "push";
  },
  "empty branch": (f) => {
    f.expected.producerBranch = "";
  },
})) {
  test(`authenticated separated archive rejects expected ${name} before network`, async () => {
    const f = authenticatedFixture();
    mutate(f);
    await assert.rejects(readCanonicalExecutionArtifact(f.expected, f.authority, f.options), {
      message: AUTH_FAILURE,
    });
    assert.equal(f.calls.length, 0);
  });
}

test("authenticated separated archive sanitizes transport failure without retry", async () => {
  const f = authenticatedFixture();
  let calls = 0;
  f.options.fetchImpl = async () => {
    calls += 1;
    throw new Error(`${f.token} private-fixture`);
  };
  await assert.rejects(readCanonicalExecutionArtifact(f.expected, f.authority, f.options), {
    message: AUTH_FAILURE,
  });
  assert.equal(calls, 1);
});

test("authenticated separated archive snapshots expectations during transport", async () => {
  const f = authenticatedFixture();
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args);
    f.expected.journalSha256 = "0".repeat(64);
    return response;
  };
  const result = await readCanonicalExecutionArtifact(f.expected, f.authority, f.options);
  assert.notEqual(result.journalSha256, f.expected.journalSha256);
  assert.equal(result.authenticatedArchiveVerified, true);
  assert.equal(result.qualified, false);
});

const ARTIFACT_FAILURE = "canonical separated artifact byte verification failed";

test("separated ZIP binds the complete output without authenticating or qualifying it", () => {
  const f = artifactFixture();
  const result = verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority);
  assert.deepEqual(result.receipt, f.frozen);
  assert.equal(result.archiveScope, "complete-separated-output");
  assert.equal(result.archiveSha256, sha256(f.archive));
  assert.equal(result.archiveBytes, f.archive.length);
  assert.equal(result.identity.candidateSha, B);
  assert.equal(result.identity.collectorSha, D);
  assert.equal(result.reportTotalsVerified, true);
  assert.equal(result.directoryEvidence, "receipt-declared");
  assert.equal(result.authenticatedArchiveVerified, false);
  assert.equal(result.sourceTreesVerified, false);
  assert.equal(result.executionVerified, false);
  assert.equal(result.qualified, false);
});

for (const field of [
  "archiveSha256",
  "bindingSha256",
  "executionSha256",
  "budgetSha256",
  "journalSha256",
  "receiptSha256",
]) {
  test(`separated ZIP refuses external ${field} drift`, () => {
    const f = artifactFixture();
    f.expected[field] = "0".repeat(64);
    assert.throws(() => verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority), {
      message: ARTIFACT_FAILURE,
    });
  });
}

for (const path of [
  "source-binding.json",
  "execution.json",
  "budget.json",
  "capture/status.json",
  "capture/bytes/receipt.json",
]) {
  test(`separated ZIP refuses missing ${path}`, () => {
    const f = artifactFixture((entries) => {
      entries.splice(
        entries.findIndex((entry) => entry.name === path),
        1,
      );
    });
    assert.throws(() => verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority), {
      message: ARTIFACT_FAILURE,
    });
  });
}

for (const kind of [
  "duplicate",
  "extra",
  "raw-output",
  "traversal",
  "absolute",
  "backslash",
  "control",
  "symlink",
  "directory",
  "compression",
  "empty-document",
  "invalid-document",
  "changed-runtime",
]) {
  test(`separated ZIP refuses ${kind} members`, () => {
    const f = artifactFixture((entries) => {
      if (kind === "duplicate") entries.push(entries[0]);
      if (kind === "extra") entries.push({ name: "extra.txt", base64: "eA==" });
      if (kind === "raw-output") entries[0].name = "web/.svelte-kit/output/server/later.js";
      if (kind === "traversal") entries[0].name = "capture/bytes/../outside.js";
      if (kind === "absolute") entries[0].name = "/capture/bytes/worker.js";
      if (kind === "backslash") entries[0].name = "capture/bytes/a\\\\b";
      if (kind === "control") entries[0].name = "capture/bytes/a\u007fb";
      if (kind === "symlink") entries[0].mode = 0o120777;
      if (kind === "directory") entries[0].name += "/";
      if (kind === "compression") entries[0].compression = 12;
      if (kind === "empty-document" || kind === "invalid-document") {
        entries.find((entry) => entry.name === "execution.json").base64 =
          kind === "empty-document" ? "" : "ew==";
      }
      if (kind === "changed-runtime") entries[0].base64 = "eA==";
    });
    assert.throws(() => verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority), {
      message: ARTIFACT_FAILURE,
    });
  });
}

for (const kind of ["CRC", "encrypted", "member-bound", "archive-size"]) {
  test(`separated ZIP refuses malformed ${kind} without exposing child output`, () => {
    const f = artifactFixture();
    const offset = f.archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(offset > 0);
    if (kind === "CRC") {
      f.archive.writeUInt32LE((f.archive.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16);
    }
    if (kind === "encrypted") {
      f.archive.writeUInt16LE(f.archive.readUInt16LE(offset + 8) | 1, offset + 8);
    }
    if (kind === "member-bound") f.archive.writeUInt32LE(64 * 1024 * 1024 + 1, offset + 24);
    f.expected.archiveSha256 = sha256(f.archive);
    if (kind === "archive-size") f.expected.archiveBytes++;
    assert.throws(() => verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority), {
      message: ARTIFACT_FAILURE,
    });
  });
}

test("separated members bind capture and report without qualification", () => {
  const f = memberFixture();
  const result = verifyCanonicalExecutionMembers(f.members, f.expected, f.authority);
  assert.deepEqual(result.receipt, f.frozen);
  assert.equal(result.identity.candidateSha, B);
  assert.equal(result.identity.collectorSha, D);
  assert.equal(result.directoryEvidence, "receipt-declared");
  assert.equal(result.reportTotalsVerified, true);
  assert.equal(result.authenticatedArchiveVerified, false);
  assert.equal(result.sourceTreesVerified, false);
  assert.equal(result.executionVerified, false);
  assert.equal(result.qualified, false);
});

for (const digest of [
  "bindingSha256",
  "executionSha256",
  "budgetSha256",
  "journalSha256",
  "receiptSha256",
]) {
  test(`separated members refuse external ${digest} drift`, () => {
    const f = memberFixture();
    f.expected[digest] = "0".repeat(64);
    assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
      message: "canonical separated execution member verification failed",
    });
  });
}

for (const kind of [
  "missing",
  "duplicate",
  "extra",
  "alias",
  "body",
  "raw-byte",
  "candidate",
  "collector",
  "attempt",
  "same-source",
  "failed-capture",
  "late-capture",
  "report-total",
  "report-source",
  "execution-total",
  "execution-capture",
  "install-missing",
  "install-source",
  "install-claim",
  "runner-missing",
  "runner-source",
  "runner-claim",
  "runtime-claim",
  "qualified-claim",
]) {
  test(`separated members refuse ${kind} substitution`, () => {
    const f = memberFixture();
    if (kind === "missing") {
      const index = f.members.findIndex((member) => member.path === "budget.json");
      f.members.splice(index, 1);
    }
    if (kind === "duplicate") f.members.push(f.members[0]);
    if (kind === "extra") {
      f.members.push({ path: "late-output.js", type: "file", data: Buffer.from("x") });
    }
    if (kind === "alias") f.members[0].type = "symlink";
    if (kind === "body") f.members[0].data = "not a Buffer";
    if (kind === "raw-byte") f.members[0].data = Buffer.from("changed");
    if (kind === "candidate") f.expected.candidateSha = "0".repeat(40);
    if (kind === "collector") f.expected.collectorSha = "e".repeat(40);
    if (kind === "attempt") f.expected.runAttempt = "2";
    if (["same-source", "failed-capture", "late-capture"].includes(kind)) {
      const journal = f.records["capture/status.json"];
      if (kind === "same-source") journal.schema = "two.kit-canonical-capture.v1";
      if (kind === "failed-capture") journal.producerOutcome = "failure";
      if (kind === "late-capture") journal.captureBoundary = "caller-requested";
      f.save("capture/status.json", journal, "journalSha256");
    }
    if (["report-total", "report-source"].includes(kind)) {
      const measured = f.records["budget.json"];
      if (kind === "report-total") measured.report.groups[0].checks[0].rawBytes++;
      if (kind === "report-source") measured.source.commit = D;
      f.save("budget.json", measured, "budgetSha256");
    }
    if (kind.startsWith("runner-")) {
      const execution = f.records["execution.json"];
      if (kind === "runner-missing") delete execution.runner;
      if (kind === "runner-source") execution.runner.source = {};
      if (kind === "runner-claim") execution.runner.executionVerified = true;
      f.save("execution.json", execution, "executionSha256");
    }
    if (kind.startsWith("install-")) {
      const execution = f.records["execution.json"];
      if (kind === "install-missing") delete execution.installation;
      if (kind === "install-source") execution.installation.source = {};
      if (kind === "install-claim") execution.installation.dependenciesVerified = true;
      f.save("execution.json", execution, "executionSha256");
    }
    if (
      ["execution-total", "execution-capture", "runtime-claim", "qualified-claim"].includes(kind)
    ) {
      const execution = f.records["execution.json"];
      if (kind === "execution-total") execution.budget.frozenTotalsSha256 = "0".repeat(64);
      if (kind === "execution-capture") execution.capture = { capture: "unavailable" };
      if (kind === "runtime-claim") execution.executionVerified = true;
      if (kind === "qualified-claim") execution.qualified = true;
      f.save("execution.json", execution, "executionSha256");
    }
    assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
      message: "canonical separated execution member verification failed",
    });
  });
}

for (const kind of ["failure", "source", "evidence", "qualification"]) {
  test(`execution finalizes frozen bytes after candidate profile ${kind}`, async () => {
    const f = fixture();
    const profile = f.collaborators.profile;
    f.collaborators.profile = async (...args) => {
      const record = await profile(...args);
      if (kind === "failure") throw new Error("profile unavailable");
      if (kind === "source") record.source = f.binding.collector;
      if (kind === "evidence") record.evidence = "qualified";
      if (kind === "qualification") record.executionVerified = true;
      return record;
    };
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators));
    assert.equal(f.calls.filter((call) => call === "profile").length, 1);
    assert.equal(f.calls.filter((call) => call === "finalize").length, 1);
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

test("profile failure remains primary when frozen finalization also fails", async () => {
  const f = fixture();
  f.collaborators.profile = async () => {
    throw new Error("profile unavailable");
  };
  f.collaborators.finalize = async () => {
    throw new Error("secondary finalizer");
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /profile unavailable/);
});

for (const kind of ["missing", "extra", "bytes", "number", "env", "source", "qualification"]) {
  test(`separated members reject profile ${kind}`, () => {
    const f = memberFixture();
    const index = f.members.findIndex((member) => member.path === "startup/cold-1.cpuprofile");
    if (kind === "missing") f.members.splice(index, 1);
    if (kind === "extra") {
      f.members.push({ path: "startup/.extra", type: "file", data: Buffer.from("x") });
    }
    if (kind === "bytes") f.members[index].data = Buffer.from("changed");
    if (kind === "env") {
      f.members.find((m) => m.path === "startup/empty.env").data = Buffer.from("x");
    }
    const execution = f.records["execution.json"];
    if (kind === "number") execution.profile.report.maximumMs = 0;
    if (kind === "source") execution.profile.source = {};
    if (kind === "qualification") execution.profile.executionVerified = true;
    f.save("execution.json", execution, "executionSha256");
    assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
      message: "canonical separated execution member verification failed",
    });
  });
}

test("separated reader recomputes profile numbers after matching digest substitutions", () => {
  const f = memberFixture();
  const execution = f.records["execution.json"];
  execution.profile.report.maximumMs = 0;
  const raw = f.members.find((member) => member.path === "startup/report.json");
  raw.data = Buffer.from(JSON.stringify(execution.profile.report));
  execution.profile.files = CANONICAL_PROFILE_FILES.map((path) => {
    const bytes = f.members.find((member) => member.path === `startup/${path}`).data;
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  f.save("execution.json", execution, "executionSha256");
  assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
    message: "canonical separated execution member verification failed",
  });
});

for (const kind of ["missing", "extra", "env"]) {
  test(`separated ZIP parser rejects startup ${kind}`, () => {
    const f = artifactFixture((entries) => {
      if (kind === "missing") {
        entries.splice(entries.findIndex((e) => e.name === "startup/report.json"), 1);
      }
      if (kind === "extra") entries.push({ name: "startup/.extra", base64: "eA==" });
      if (kind === "env") entries.find((e) => e.name === "startup/empty.env").base64 = "eA==";
    });
    assert.throws(() => verifyCanonicalExecutionArtifactBytes(f.archive, f.expected, f.authority));
  });
}

test("execution awaits capture and retains distinct source identities", async () => {
  const f = fixture();
  const result = await executeCanonicalBuild(f.args, f.collaborators);
  assert.deepEqual(f.calls, [
    `inspect:${D}`,
    `inspect:${B}`,
    "runner",
    `inspect:${D}`,
    "install",
    `inspect:${D}`,
    "tool",
    "web-tool",
    `inspect:${B}`,
    `inspect:${D}`,
    "build",
    "capture",
    "returned",
    `inspect:${D}`,
    "budget",
    "verifyBytes",
    "profile",
    "finalize",
    "runner",
    "tool",
    "web-tool",
    `inspect:${B}`,
    `inspect:${D}`,
  ]);
  assert.deepEqual(result.wrangler, toolFixture());
  assert.deepEqual(result.webWrangler, toolFixture("web"));
  assert.deepEqual(result.runner, runnerFixture(result.installation.source));
  assert.deepEqual(result.installation, installationFixture(result.installation.source));
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

for (const kind of ["failure", "source", "executionVerified"]) {
  test(`execution refuses runner ${kind} before installation`, async () => {
    const f = fixture();
    const runner = f.collaborators.runner;
    f.collaborators.runner = async (...args) => {
      const result = await runner(...args);
      if (kind === "failure") throw new Error("private runner fixture detail");
      if (kind === "source") result.source = {};
      if (kind === "executionVerified") result.executionVerified = true;
      return result;
    };
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), {
      message: "canonical runner unavailable; retain output without retry",
    });
    assert.equal(f.calls.filter((call) => call === "runner").length, 1);
    for (const call of ["install", "build", "capture", "budget", "finalize"]) {
      assert.equal(f.calls.includes(call), false);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.args.destination, "runner-failure.json"))), {
      sourceBindingSha256: f.args.bindingSha256,
      outcome: "failure",
      qualified: false,
    });
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

for (const kind of ["failure", "schema", "evidence", "name", "version"]) {
  test(`execution refuses Wrangler ${kind} before build without retry`, async () => {
    const f = fixture();
    const tool = f.collaborators.tool;
    f.collaborators.tool = async (...args) => {
      const result = await tool(...args);
      if (kind === "failure") throw new Error("private tool fixture detail");
      result[kind] = "invalid";
      return result;
    };
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), {
      message: "canonical tool unavailable; retain output without retry",
    });
    assert.equal(f.calls.filter((call) => call === "tool").length, 1);
    assert.equal(f.calls.includes("install"), true);
    for (const call of ["build", "capture", "budget", "finalize"]) {
      assert.equal(f.calls.includes(call), false);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.args.destination, "tool-failure.json"))), {
      sourceBindingSha256: f.args.bindingSha256,
      outcome: "failure",
      qualified: false,
    });
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

test("execution refuses post-build Wrangler drift after frozen finalization", async () => {
  const f = fixture();
  const tool = f.collaborators.tool;
  let calls = 0;
  f.collaborators.tool = async (...args) => {
    const result = await tool(...args);
    if (args[2] !== "web" && calls++ > 0) result.files[0].sha256 = "b".repeat(64);
    return result;
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /Wrangler changed/);
  assert.equal(calls, 2);
  assert.equal(f.calls.includes("finalize"), true);
  assert.equal(existsSync(join(f.args.destination, "budget.json")), true);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

for (const kind of ["missing", "schema", "evidence", "name", "version"]) {
  test(`separated members refuse Wrangler ${kind} observation`, () => {
    const f = memberFixture();
    const execution = f.records["execution.json"];
    if (kind === "missing") delete execution.wrangler;
    else execution.wrangler[kind] = "invalid";
    f.save("execution.json", execution, "executionSha256");
    assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
      message: "canonical separated execution member verification failed",
    });
  });
}

for (const kind of ["failure", "schema", "evidence", "name", "version", "entry", "runtime"]) {
  test(`execution refuses web Wrangler ${kind} before build without retry`, async () => {
    const f = fixture();
    const tool = f.collaborators.tool;
    f.collaborators.tool = async (...args) => {
      const result = await tool(...args);
      if (args[2] === "web") {
        if (kind === "failure") throw new Error("private web tool fixture detail");
        result[kind] = "invalid";
      }
      return result;
    };
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), {
      message: "canonical tool unavailable; retain output without retry",
    });
    assert.equal(f.calls.filter((call) => call === "web-tool").length, 1);
    assert.equal(f.calls.includes("tool"), true);
    assert.equal(f.calls.includes("build"), false);
    assert.equal(f.calls.includes("capture"), false);
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
    const failure = readFileSync(join(f.args.destination, "tool-failure.json"), "utf8");
    assert.doesNotMatch(failure, /private|fixture detail/);
    assert.deepEqual(JSON.parse(failure), {
      sourceBindingSha256: f.args.bindingSha256,
      outcome: "failure",
      qualified: false,
    });
  });
}

test("execution refuses web-only Wrangler drift after frozen finalization", async () => {
  const f = fixture();
  const tool = f.collaborators.tool;
  let calls = 0;
  f.collaborators.tool = async (...args) => {
    const result = await tool(...args);
    if (args[2] === "web" && calls++ > 0) result.files[0].sha256 = "b".repeat(64);
    return result;
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /web Wrangler changed/);
  assert.equal(calls, 2);
  assert.equal(f.calls.includes("finalize"), true);
  assert.equal(existsSync(join(f.args.destination, "budget.json")), true);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

for (const kind of ["missing", "schema", "evidence", "name", "version", "entry", "runtime"]) {
  test(`separated members refuse web Wrangler ${kind} observation`, () => {
    const f = memberFixture();
    const execution = f.records["execution.json"];
    if (kind === "missing") delete execution.webWrangler;
    else execution.webWrangler[kind] = "invalid";
    f.save("execution.json", execution, "executionSha256");
    assert.throws(() => verifyCanonicalExecutionMembers(f.members, f.expected, f.authority), {
      message: "canonical separated execution member verification failed",
    });
  });
}

test("execution refuses post-build runner drift after frozen finalization", async () => {
  const f = fixture();
  const runner = f.collaborators.runner;
  let calls = 0;
  f.collaborators.runner = async (...args) => {
    const result = await runner(...args);
    if (calls++ > 0) result.runner.limits.effectiveCpuCount = 1;
    return result;
  };
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /runner changed/);
  assert.equal(calls, 2);
  assert.equal(f.calls.includes("finalize"), true);
  assert.equal(existsSync(join(f.args.destination, "budget.json")), true);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

for (const kind of ["failure", "source", "dependenciesVerified", "executionVerified"]) {
  test(`execution refuses install ${kind} before build without retry`, async () => {
    const f = fixture();
    const install = f.collaborators.install;
    f.collaborators.install = async (...args) => {
      const result = await install(...args);
      if (kind === "failure") throw new Error("private install fixture detail");
      if (kind === "source") result.source = {};
      else result[kind] = true;
      return result;
    };
    await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), {
      message: "canonical install failed; retain output without retry",
    });
    assert.equal(f.calls.filter((call) => call === "install").length, 1);
    for (const call of ["build", "capture", "budget", "finalize"]) {
      assert.equal(f.calls.includes(call), false);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.args.destination, "install-failure.json"))), {
      sourceBindingSha256: f.args.bindingSha256,
      outcome: "failure",
      qualified: false,
    });
    assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
  });
}

test("execution refuses changed install inputs at build return", async () => {
  const f = fixture();
  const build = f.collaborators.build;
  f.collaborators.build = async (...args) => ({
    ...(await build(...args)),
    installBoundary: { evidence: "changed fixture" },
  });
  await assert.rejects(executeCanonicalBuild(f.args, f.collaborators), /install inputs changed/);
  assert.equal(f.calls.includes("capture"), true);
  assert.equal(f.calls.includes("budget"), false);
  assert.equal(f.calls.includes("finalize"), false);
  assert.equal(existsSync(join(f.args.destination, "execution.json")), false);
});

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
