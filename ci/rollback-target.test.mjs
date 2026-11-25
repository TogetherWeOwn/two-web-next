import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inventoryPureHonoSourceAssets } from "./pure-hono-recovery-assets.mjs";
import { verifyPureHonoRecoveryAttestation } from "./pure-hono-recovery-attestation.mjs";
import { projectPureHonoVersionedConfig } from "./pure-hono-recovery-config.mjs";
import { validatePureHonoRecoveryEvidence } from "./pure-hono-recovery-evidence.mjs";
import { RECOVERY_MEMBER_LIMITS } from "./pure-hono-recovery-members.mjs";
import { packPureHonoRecovery } from "./pure-hono-recovery-packager.mjs";
import { fetchPureHonoRecoveryRun } from "./pure-hono-recovery-run.mjs";
import { verifyPureHonoRecoveryEvidence } from "./pure-hono-recovery-verifier.mjs";
import {
  ROLLBACK_ENVIRONMENTS,
  assertRollbackDrillGreen,
  checkRollbackTarget,
  destructiveStatements,
  liveVersion,
  previousVersion,
  rollbackAction,
  rollbackCompatibility,
  rollbackEnvironment,
  stagingBusyRuns,
} from "./rollback-target.mjs";
import { decodePureHonoRecoveryZip } from "./route-evidence-artifact-zip.mjs";
import { zip } from "./route-evidence-zip-fixture.mjs";

const recoveryDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recoveryInvocation =
  "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/attempts/2";

function recoveryFixture({
  prepareFiles,
  changeFiles,
  changeManifest,
  encodeManifest = JSON.stringify,
  encodeArchive = (members) => Buffer.from(JSON.stringify(members)),
} = {}) {
  const identity = {
    sourceSha: "a".repeat(40),
    runId: "123",
    runAttempt: "2",
    originalVersionId: "11111111-1111-4111-8111-111111111111",
  };
  const producer = {
    repository: "TogetherWeOwn/two-web-next",
    ref: "refs/heads/main",
    workflow: ".github/workflows/archive-hono-recovery.yml",
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
  };
  const members = [
    { path: "worker.js", bytes: "worker fixture" },
    { path: "effective-config.json", bytes: "{}" },
    { path: "assets/version.json", bytes: "{}" },
  ];
  prepareFiles?.(members);
  const manifest = {
    schema: "two.pure-hono-recovery.v1",
    target: "two-web-next-production",
    ...identity,
    files: members.map(({ path, bytes }) => ({
      path,
      bytes: Buffer.byteLength(bytes),
      sha256: recoveryDigest(bytes),
    })),
  };
  changeFiles?.(members);
  changeManifest?.(manifest);
  const archive = encodeArchive([
    ...members,
    { path: "manifest.json", bytes: encodeManifest(manifest) },
  ]);
  const archiveSha256 = recoveryDigest(archive);
  return {
    archive,
    expected: { ...identity, workflow: producer.workflow, archiveSha256 },
    attestation: { ...producer, subjectSha256: archiveSha256, invocationId: recoveryInvocation },
    run: { ...producer, status: "completed", conclusion: "success" },
    decode: (input) =>
      JSON.parse(input.toString("utf8")).map(({ path, bytes, type = "file" }) => ({
        path,
        type,
        bytes: Buffer.from(bytes),
      })),
  };
}

const assetConfig = `{
  // Wrangler inherits the whole asset field from the root.
  "main": "src/worker.ts",
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": true, },
  "env": { "production": {} },
}`;
function sourceAssetLock(version, integrity) {
  return JSON.stringify({ packages: { "node_modules/wrangler": { version, integrity } } });
}
const assetLock = sourceAssetLock(
  "4.156.1",
  "sha512-aZngeNRosSVly6wgxpaJAtFPtEoyM3hD8mLMMcHNXTnofMq4ZN+RMXOdHETyttNP+//+mfiD1hb5E8YFtiMMRQ==",
);
const currentAssetLock = sourceAssetLock(
  "4.161.0",
  "sha512-yOHZUYEq9AP7vutWmkCADzCKAH9ynfvZdoKJRIGTzkiailf9/L+jhT7WRb+9p6jRDtuBXVFtCzLo7kGAcGw+pA==",
);

function sourceAssetFixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "hono-source-assets-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (args, input) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      input,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  const git = (...args) => run(args);
  git("init", "-q", "--object-format=sha1");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  const write = (path, value) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), value);
  };
  write("wrangler.jsonc", assetConfig);
  write("package-lock.json", assetLock);
  write("public/ok.js", "source");
  const commit = (stage = true) => {
    if (stage) git("add", "-Af");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return {
    git,
    write,
    commit,
    repo,
    read: (sourceSha) => inventoryPureHonoSourceAssets({ repo, sourceSha }),
    index: (rows) => run(["update-index", "--index-info"], `${rows.join("\n")}\n`),
    blobOfSize: (size) => run(["hash-object", "-w", "--stdin"], Buffer.alloc(size)),
  };
}

test("Hono source assets pin selected bytes and controls to a commit", (t) => {
  const { git, write, commit, read } = sourceAssetFixture(t);
  const config = `\uFEFF${assetConfig}`;
  const headers = Buffer.from("/ok.js\r\n  X-Fixture: one\r\n");
  const empty = Buffer.alloc(0);
  const assets = [
    { path: "assets/.hidden", bytes: empty },
    { path: "assets/dir/.assetsignore", bytes: Buffer.from("*") },
    { path: "assets/dir/_headers", bytes: Buffer.from("nested") },
    { path: "assets/ok.js", bytes: Buffer.from("source") },
  ];
  write("wrangler.jsonc", config);
  write("package-lock.json", currentAssetLock);
  write("public/_headers", headers);
  write("public/_redirects", empty);
  for (const { path, bytes } of assets) write(path.replace(/^assets\//, "public/"), bytes);
  const sourceSha = commit();
  const first = read(sourceSha);
  write("public/ok.js", "different commit");
  commit();
  write("public/_headers", "dirty");
  write("public/untracked.js", "untracked");
  git(
    "replace",
    git("rev-parse", `${sourceSha}:public/ok.js`),
    git("rev-parse", "HEAD:public/ok.js"),
  );
  assert.deepEqual(read(sourceSha), first);
  const receipt = JSON.parse(first.receipt);
  const row = (path, bytes) => ({ path, bytes: bytes.length, sha256: recoveryDigest(bytes) });
  assert.deepEqual(first.assets, assets);
  assert.deepEqual(first.controls, { _headers: headers, _redirects: empty });
  assert.deepEqual(
    receipt.files,
    assets.map(({ path, bytes }) => row(path, bytes)),
  );
  assert.deepEqual(receipt.controlFiles, {
    _headers: row("public/_headers", headers),
    _redirects: row("public/_redirects", empty),
  });
  assert.deepEqual([receipt.sourceSha, receipt.assetCount, receipt.assetBytes], [sourceSha, 4, 13]);
  assert.deepEqual(receipt.wrangler, {
    version: "4.161.0",
    configSha256: recoveryDigest(config),
    lockSha256: recoveryDigest(currentAssetLock),
  });
  assert.equal(first.receiptSha256, recoveryDigest(first.receipt));
  write("package-lock.json", currentAssetLock.replace("yOHZ", "aOHZ"));
  assert.throws(() => read(commit()), /Wrangler pin/);
});

test("Hono source assets refuse unsafe selection inputs", (t) => {
  const cases = [
    ["wrangler.json", "{}", "unsupported source member"],
    [".wrangler/deploy/config.json", "{}", "unsupported source member"],
    ["public/.assetsignore", "!/_headers\n", "unsupported asset selection input"],
    ["public/.ASSETSIGNORE", "", "unsupported asset selection input"],
    ["public/_HEADERS", "value", "unsupported asset selection input"],
    ["public/_headers/fixture", "value", "unsupported asset selection input"],
    ["public/_worker.js-extra", "value", "unsupported asset selection input"],
    ["public/internal-canary.js\n", "value", "asset path"],
    ["public/OK.js", "value", "aliased asset path"],
    ["public/_headers", Buffer.from([0xff]), "selection input encoding"],
    ["public/_headers", Buffer.alloc(64 * 1024 + 1), "file size"],
    ["public/large.bin", Buffer.alloc(25 * 1024 * 1024 + 1), "file size"],
  ];
  for (const [path, bytes, reason] of cases) {
    const { write, commit, read } = sourceAssetFixture(t);
    write(path, bytes);
    const source = commit();
    const message = `pure Hono recovery assets refused: ${reason}`;
    assert.throws(() => read(source), { message }, path);
  }
  const { repo, git, write, commit, read } = sourceAssetFixture(t);
  const source = commit();
  const result = read(source);
  assert.deepEqual(result.controls, { _headers: null, _redirects: null });
  assert.equal(JSON.parse(result.receipt).wrangler.version, "4.156.1");
  for (const invalid of ["HEAD", `${source}\n`, git("rev-parse", "HEAD:public/ok.js")])
    assert.throws(() => read(invalid), /source SHA|not a commit/);
  write("package-lock.json", assetLock.replace("4.156.1", "4.999.0"));
  assert.throws(() => read(commit()), /Wrangler pin/);
  write("package-lock.json", assetLock);
  for (const override of ['{ // override\r "assets": {}\n }', "{,}"]) {
    write("wrangler.jsonc", assetConfig.replace('"production": {}', `"production": ${override}`));
    assert.throws(() => read(commit()), /Wrangler asset config|source selection parsing/);
  }
  write("wrangler.jsonc", assetConfig);
  symlinkSync("../package-lock.json", join(repo, "public", "link"));
  assert.throws(() => read(commit()), /non-regular source member/);
});

test("Hono source assets enforce aggregate bounds", (t) => {
  const { git, write, commit, index, read, blobOfSize } = sourceAssetFixture(t);
  write("public/_headers", Buffer.alloc(64 * 1024, " "));
  const source = commit();
  const blob = git("rev-parse", "HEAD:public/ok.js");
  const rows = (oid, length) => Array.from({ length }, (_, i) => `100644 ${oid}\tpublic/${i}`);
  const { maxEntries, maxTotalBytes } = RECOVERY_MEMBER_LIMITS;
  index(rows(blob, maxEntries - 4));
  assert.equal(read(commit(false)).assets.length, maxEntries - 3);
  index([`100644 ${blob}\tpublic/extra`]);
  assert.throws(() => read(commit(false)), /asset count/);
  git("read-tree", source);
  const perFileLimit = 25 * 1024 * 1024;
  const remainder = maxTotalBytes - 5 * perFileLimit - Buffer.byteLength("source");
  index([...rows(blobOfSize(perFileLimit), 5), `100644 ${blobOfSize(remainder)}\tpublic/last`]);
  assert.equal(JSON.parse(read(commit(false)).receipt).assetBytes, maxTotalBytes);
  index([`100644 ${blobOfSize(remainder + 1)}\tpublic/last`]);
  assert.throws(() => read(commit(false)), /asset bytes/);
});

const signerWorkflow = "TrustedOrg/build/.github/workflows/sign.yml";
const signerDigest = "b".repeat(40);
const verifierIssuer = "https://token.actions.githubusercontent.com";
const provenanceV1 = "https://slsa.dev/provenance/v1";
const attestationRefusal = "pure Hono recovery attestation refused: ";
const unavailable = `${attestationRefusal}pinned verifier or its JSON output unavailable`;
const ghSuccess = (stdout) => ({ status: 0, signal: null, stdout: Buffer.from(stdout) });

function checkedAttestationFixture(input = recoveryFixture()) {
  const expected = { ...input.expected, signerWorkflow, signerDigest };
  const certificate = {
    issuer: verifierIssuer,
    sourceRepositoryURI: "https://github.com/TogetherWeOwn/two-web-next",
    sourceRepositoryRef: "refs/heads/main",
    sourceRepositoryDigest: expected.sourceSha,
    buildConfigURI: `https://github.com/TogetherWeOwn/two-web-next/${expected.workflow}@refs/heads/main`,
    buildSignerDigest: signerDigest,
    subjectAlternativeName: `https://github.com/${signerWorkflow}@${signerDigest}`,
    runInvocationURI: recoveryInvocation,
  };
  const metadata = { invocationId: recoveryInvocation };
  const statement = {
    predicateType: provenanceV1,
    subject: [{ name: "original-name.zip", digest: { sha256: expected.archiveSha256 } }],
    predicate: { runDetails: { metadata } },
  };
  const checked = {
    attestation: {},
    verificationResult: { signature: { certificate }, statement },
  };
  return { input, expected, checked, certificate, metadata, statement };
}

function syntheticGh(verify, version = "2.103.3") {
  return (command, args, options) =>
    args[0] === "--version"
      ? ghSuccess(`gh version ${version} (2026-10-26)\n`)
      : verify(command, args, options);
}

function verifyFixture({ input, expected, checked }) {
  return verifyPureHonoRecoveryAttestation(
    input.archive,
    expected,
    syntheticGh(() => ghSuccess(JSON.stringify([checked]))),
  );
}

test("pure Hono attestation verifies exact bytes with pinned policy and feeds the validator", () => {
  const { input, expected, checked } = checkedAttestationFixture();
  let directory;
  const attestation = verifyPureHonoRecoveryAttestation(
    input.archive,
    expected,
    syntheticGh((command, args, options) => {
      const path = args[2];
      directory = dirname(path);
      assert.equal(command, "gh");
      assert.deepEqual(
        args,
        [
          ["attestation", "verify", path],
          ["--hostname", "github.com"],
          ["--repo", "TogetherWeOwn/two-web-next"],
          ["--signer-workflow", signerWorkflow],
          ["--signer-digest", signerDigest],
          ["--source-ref", "refs/heads/main"],
          ["--source-digest", "a".repeat(40)],
          ["--cert-oidc-issuer", verifierIssuer],
          ["--predicate-type", provenanceV1],
          ["--digest-alg", "sha256"],
          ["--format", "json"],
        ].flat(),
      );
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readFileSync(path), input.archive);
      return ghSuccess(JSON.stringify([checked]));
    }),
  );
  assert.equal(existsSync(directory), false);
  assert.deepEqual(attestation, input.attestation);
  assert.deepEqual(validatePureHonoRecoveryEvidence({ ...input, attestation }), {
    archiveSha256: expected.archiveSha256,
    fileCount: 3,
  });
});

test("pure Hono attestation refuses invalid pins or archives before spawning", () => {
  const { input, expected } = checkedAttestationFixture();
  let calls = 0;
  const spawn = () => calls++;
  for (const invalid of [
    { archiveSha256: "a" },
    { signerDigest: undefined },
    { sourceSha: "--help" },
    { workflow: "../untrusted.yml" },
    { signerWorkflow: `other.invalid/${signerWorkflow}` },
  ]) {
    assert.throws(
      () => verifyPureHonoRecoveryAttestation(input.archive, { ...expected, ...invalid }, spawn),
      {
        message: `${attestationRefusal}invalid pins`,
      },
    );
  }
  for (const archive of [
    new Uint8Array(1),
    Buffer.alloc(0),
    Buffer.alloc(RECOVERY_MEMBER_LIMITS.maxArchiveBytes + 1),
  ]) {
    assert.throws(() => verifyPureHonoRecoveryAttestation(archive, expected, spawn), {
      message: `${attestationRefusal}archive size`,
    });
  }
  assert.throws(
    () => verifyPureHonoRecoveryAttestation(Buffer.from("other bytes"), expected, spawn),
    {
      message: `${attestationRefusal}pinned archive digest`,
    },
  );
  assert.equal(calls, 0);
});

for (const [label, change, reason] of [
  [
    "a wrong subject digest",
    ({ statement }) => (statement.subject[0].digest.sha256 = "0".repeat(64)),
    "identity or subject digest",
  ],
  [
    "a wrong caller workflow",
    ({ certificate }) => (certificate.buildConfigURI = `https://github.com/${signerWorkflow}`),
    "identity or subject digest",
  ],
  [
    "a wrong source digest",
    ({ certificate }) => (certificate.sourceRepositoryDigest = signerDigest),
    "identity or subject digest",
  ],
  [
    "a wrong signer digest",
    ({ certificate }) => (certificate.buildSignerDigest = "a".repeat(40)),
    "identity or subject digest",
  ],
  ["a missing signed invocation", ({ metadata }) => delete metadata.invocationId, "invocation"],
  [
    "a mismatched signed invocation",
    ({ metadata }) => (metadata.invocationId = recoveryInvocation.replace(/2$/, "1")),
    "invocation",
  ],
  [
    "a missing certificate invocation",
    ({ certificate }) => delete certificate.runInvocationURI,
    "invocation",
  ],
  [
    "a malformed invocation in both places",
    ({ certificate, metadata }) => {
      certificate.runInvocationURI = metadata.invocationId = `${recoveryInvocation}?extra`;
    },
    "invocation",
  ],
]) {
  test(`pure Hono attestation refuses ${label}`, () => {
    const fixture = checkedAttestationFixture();
    change(fixture);
    assert.throws(() => verifyFixture(fixture), {
      message: `${attestationRefusal}verified ${reason}`,
    });
  });
}

test("pure Hono attestation preserves a signed invocation for the independent attempt check", () => {
  const fixture = checkedAttestationFixture();
  const otherInvocation = recoveryInvocation.replace(/2$/, "1");
  fixture.metadata.invocationId = fixture.certificate.runInvocationURI = otherInvocation;
  const attestation = verifyFixture(fixture);
  assert.equal(attestation.invocationId, otherInvocation);
  assert.equal(attestation.runAttempt, "1");
  assert.throws(
    () => validatePureHonoRecoveryEvidence({ ...fixture.input, attestation }),
    /verified attestation identity/,
  );
});

test("pure Hono attestation sanitizes verifier failures and always removes the private copy", () => {
  const { input, expected, checked } = checkedAttestationFixture();
  for (const [verify, reason] of [
    [
      () => ghSuccess(JSON.stringify([checked, checked])),
      `${attestationRefusal}verified result count`,
    ],
    [
      () => ghSuccess(JSON.stringify({ verificationResult: checked.verificationResult })),
      `${attestationRefusal}verified result count`,
    ],
    [() => ghSuccess("untrusted JSON detail"), unavailable],
    [() => ghSuccess([0xff]), unavailable],
    [() => ghSuccess(Buffer.alloc(2 * 1024 * 1024 + 1)), unavailable],
    [() => ({ ...ghSuccess("untrusted stdout"), status: 1 }), unavailable],
    [
      () => ({ ...ghSuccess(""), signal: "SIGKILL", error: new Error("untrusted timeout detail") }),
      unavailable,
    ],
    [
      () => {
        throw new Error("untrusted spawn detail");
      },
      unavailable,
    ],
  ]) {
    const paths = [];
    assert.throws(
      () =>
        verifyPureHonoRecoveryAttestation(
          input.archive,
          expected,
          syntheticGh((_command, args) => {
            paths.push(args[2]);
            return verify();
          }),
        ),
      { message: reason },
    );
    assert.equal(paths.length, 1);
    assert.equal(existsSync(dirname(paths[0])), false);
  }
  const calls = [];
  assert.throws(
    () =>
      verifyPureHonoRecoveryAttestation(input.archive, expected, (command, args) => {
        calls.push([command, args]);
        return ghSuccess("gh version 2.103.2 (2026-10-25)\n");
      }),
    { message: unavailable },
  );
  assert.deepEqual(calls, [["gh", ["--version"]]]);
});

function recoveryRunAttempt(event = "push") {
  const repo = { id: 100, full_name: "TogetherWeOwn/two-web-next", fork: false };
  return {
    id: 123,
    run_attempt: 2,
    repository: { ...repo },
    head_repository: { ...repo },
    path: ".github/workflows/archive-hono-recovery.yml@main",
    head_sha: "a".repeat(40),
    head_branch: "main",
    event,
    status: "completed",
    conclusion: "success",
    url: "https://example.invalid/ignored",
  };
}

const runsUrl = "https://api.github.com/repos/TogetherWeOwn/two-web-next/actions/runs";
const attemptUrl = `${runsUrl}/123/attempts/2`;
const metadataRefusal = "pure Hono recovery run refused: inconsistent GitHub attempt metadata";

function composedRecoveryFixture({
  run = recoveryRunAttempt(),
  encodeArchive = (members) =>
    zip(
      members.map(({ path, bytes }) => ({
        name: path,
        data: bytes,
        madeBy: 0x0314,
        version: 20,
        attrs: (0o100644 << 16) >>> 0,
      })),
    ),
  ...archiveOptions
} = {}) {
  const fixture = checkedAttestationFixture(recoveryFixture({ ...archiveOptions, encodeArchive }));
  const calls = [];
  const { archive } = fixture.input;
  const originalBytes = Buffer.from(archive);
  const options = {
    archive,
    expected: { ...fixture.expected, event: "push" },
    token: "fixture-token",
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(run);
    },
    spawn: syntheticGh((_command, args) => {
      calls.push("attest");
      assert.deepEqual(readFileSync(args[2]), originalBytes);
      return ghSuccess(JSON.stringify(fixture.checked ? [fixture.checked] : []));
    }),
  };
  return { fixture, options, calls };
}

test("pure Hono composition verifies the exact attempt and real ZIP and snapshots its inputs", async () => {
  const { options, calls } = composedRecoveryFixture();
  const result = { archiveSha256: options.expected.archiveSha256, fileCount: 3 };
  const pending = verifyPureHonoRecoveryEvidence(options);
  assert.deepEqual(calls, [attemptUrl]);
  options.archive.fill(0);
  for (const key of Object.keys(options.expected)) delete options.expected[key];
  options.archive = options.expected = options.spawn = undefined;
  assert.deepEqual(await pending, result);
  assert.deepEqual(calls, [attemptUrl, "attest"]);
});

test("pure Hono composition refuses missing or inconsistent provenance before ZIP decoding", async () => {
  // If decoding is reached with these bytes, it fails with an archive members error instead.
  const encodeArchive = () => Buffer.from("not a ZIP");
  const wrongRun = composedRecoveryFixture({
    encodeArchive,
    run: { ...recoveryRunAttempt(), run_attempt: 1 },
  });
  await assert.rejects(verifyPureHonoRecoveryEvidence(wrongRun.options), {
    message: metadataRefusal,
  });
  assert.deepEqual(wrongRun.calls, [attemptUrl]);

  const missingRun = composedRecoveryFixture({ encodeArchive, run: null });
  await assert.rejects(verifyPureHonoRecoveryEvidence(missingRun.options), {
    message: metadataRefusal,
  });
  assert.deepEqual(missingRun.calls, [attemptUrl]);

  const missingAttestation = composedRecoveryFixture({ encodeArchive });
  delete missingAttestation.fixture.checked;
  await assert.rejects(
    verifyPureHonoRecoveryEvidence(missingAttestation.options),
    /verified result count$/,
  );
  assert.deepEqual(missingAttestation.calls, [attemptUrl, "attest"]);

  const wrongInvocation = composedRecoveryFixture({ encodeArchive });
  const { certificate, metadata } = wrongInvocation.fixture;
  certificate.runInvocationURI = metadata.invocationId = recoveryInvocation.replace(/2$/, "1");
  await assert.rejects(
    verifyPureHonoRecoveryEvidence(wrongInvocation.options),
    /verified attestation identity/,
  );
  assert.deepEqual(wrongInvocation.calls, [attemptUrl, "attest"]);
});

test("pure Hono composition refuses drift from the pinned archive digest", async () => {
  const { options, calls } = composedRecoveryFixture();
  options.archive[0] ^= 1;
  await assert.rejects(verifyPureHonoRecoveryEvidence(options), /pinned archive digest$/);
  assert.deepEqual(calls, [attemptUrl]);
});

test("pure Hono composition refuses unsafe ZIP members and a mismatched manifest", async () => {
  for (const [mutation, reason] of [
    [{ changeFiles: (files) => files.push(files[2]) }, /archive members/],
    [{ changeManifest: (manifest) => (manifest.originalVersionId = V2) }, /manifest identity/],
  ]) {
    const { options, calls } = composedRecoveryFixture(mutation);
    await assert.rejects(verifyPureHonoRecoveryEvidence(options), reason);
    assert.deepEqual(calls, [attemptUrl, "attest"]);
  }
});

test("pure Hono composition checks the inclusive archive size bound before I/O", async () => {
  const { options, calls } = composedRecoveryFixture({ run: null });
  options.spawn = () => {
    calls.push("spawn");
    assert.fail("unexpected verifier process, including a version probe");
  };
  const limit = RECOVERY_MEMBER_LIMITS.maxArchiveBytes;
  const oversized = Buffer.alloc(limit + 1);
  for (const archive of [Buffer.alloc(0), oversized]) {
    await assert.rejects(verifyPureHonoRecoveryEvidence({ ...options, archive }), /archive size$/);
  }
  assert.deepEqual(calls, []);

  // At the limit, proceed to the exact attempt lookup, but not past missing provenance.
  await assert.rejects(
    verifyPureHonoRecoveryEvidence({ ...options, archive: oversized.subarray(0, limit) }),
    { message: metadataRefusal },
  );
  assert.deepEqual(calls, [attemptUrl]);
});

test("pure Hono composition does not default to live I/O", async () => {
  for (const missing of ["fetchImpl", "spawn"]) {
    const { options, calls } = composedRecoveryFixture();
    delete options[missing];
    await assert.rejects(verifyPureHonoRecoveryEvidence(options), /missing verifier I\/O$/);
    assert.deepEqual(calls, []);
  }
});

for (const event of ["push", "workflow_dispatch"]) {
  test(`pure Hono run adapter authenticates one exact ${event} attempt for the validator`, async () => {
    const input = recoveryFixture();
    const calls = [];
    const run = await fetchPureHonoRecoveryRun(
      { ...input.expected, event },
      "fixture-token",
      async (url, options) => {
        calls.push([url, options.method ?? "GET", options.redirect, options.headers.Authorization]);
        return Response.json(recoveryRunAttempt(event));
      },
    );
    assert.deepEqual(calls, [[attemptUrl, "GET", "error", "Bearer fixture-token"]]);
    assert.deepEqual(run, input.run);
    assert.deepEqual(validatePureHonoRecoveryEvidence({ ...input, run }), {
      archiveSha256: input.expected.archiveSha256,
      fileCount: 3,
    });
  });
}

test("pure Hono run adapter accepts GitHub's unqualified workflow path on main", async () => {
  const { expected, run } = recoveryFixture();
  for (const event of ["push", "workflow_dispatch"]) {
    const metadata = { ...recoveryRunAttempt(event), path: expected.workflow };
    const fetchAttempt = async () => Response.json(metadata);
    assert.deepEqual(
      await fetchPureHonoRecoveryRun({ ...expected, event }, "fixture-token", fetchAttempt),
      run,
    );
    metadata.head_branch = "release";
    await assert.rejects(
      fetchPureHonoRecoveryRun({ ...expected, event }, "fixture-token", fetchAttempt),
      { message: metadataRefusal },
    );
  }
});

test("pure Hono run adapter accepts the positive safe integer ID boundaries", async () => {
  const expected = { ...recoveryFixture().expected, event: "push" };
  for (const [id, attempt] of [
    [1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, 1],
  ]) {
    const runId = String(id);
    const runAttempt = String(attempt);
    const calls = [];
    const run = await fetchPureHonoRecoveryRun(
      { ...expected, runId, runAttempt },
      "fixture-token",
      async (url) => {
        calls.push(url);
        return Response.json({ ...recoveryRunAttempt(), id, run_attempt: attempt });
      },
    );
    assert.deepEqual(calls, [`${runsUrl}/${runId}/attempts/${runAttempt}`]);
    assert.deepEqual({ runId: run.runId, runAttempt: run.runAttempt }, { runId, runAttempt });
  }
});

test("pure Hono run adapter refuses invalid expectations without a request", async () => {
  const expected = { ...recoveryFixture().expected, event: "push" };
  let calls = 0;
  for (const invalid of [
    { runId: "0123" },
    { runId: "123\n" },
    { runId: "9007199254740992" },
    { runAttempt: 2 },
    { runAttempt: "0" },
    { runAttempt: "2/../1" },
    { sourceSha: "a".repeat(39) },
    { workflow: "https://example.invalid/archive.yml" },
    { event: undefined },
    { event: "pull_request_target" },
  ]) {
    await assert.rejects(
      fetchPureHonoRecoveryRun({ ...expected, ...invalid }, "fixture-token", async () => {
        calls++;
        return Response.json(recoveryRunAttempt());
      }),
      { message: "pure Hono recovery run refused: invalid expected producer" },
    );
  }
  assert.equal(calls, 0);
});

for (const [label, metadata] of [
  ["wrong run", { id: 124 }],
  ["wrong attempt", { run_attempt: 1 }],
  ["missing attempt", { run_attempt: undefined }],
  ["string attempt", { run_attempt: "2" }],
  ["wrong source SHA", { head_sha: "b".repeat(40) }],
  ["wrong writer workflow", { path: ".github/workflows/ci.yml@main" }],
  ["wrong workflow ref", { path: ".github/workflows/archive-hono-recovery.yml@release" }],
  ["wrong unqualified writer workflow", { path: ".github/workflows/ci.yml" }],
  ["foreign run repository", { repository: { id: 100, full_name: "Elsewhere/repo", fork: false } }],
  [
    "foreign head repository",
    { head_repository: { id: 100, full_name: "Elsewhere/repo", fork: false } },
  ],
  [
    "forked head repository",
    { head_repository: { ...recoveryRunAttempt().head_repository, fork: true } },
  ],
  [
    "different repository ID",
    { head_repository: { ...recoveryRunAttempt().head_repository, id: 101 } },
  ],
  ["wrong branch", { head_branch: "release" }],
  ["different main-safe event", { event: "workflow_dispatch" }],
  ["unfinished run", { status: "in_progress" }],
  ["failed run", { conclusion: "failure" }],
  ["malformed repository", { head_repository: null }],
]) {
  test(`pure Hono run adapter refuses ${label}`, async () => {
    const expected = { ...recoveryFixture().expected, event: "push" };
    await assert.rejects(
      fetchPureHonoRecoveryRun(expected, "fixture-token", async () =>
        Response.json({ ...recoveryRunAttempt(), ...metadata }),
      ),
      { message: metadataRefusal },
    );
  });
}

test("pure Hono run adapter sanitizes transport refusals without retry or fallback", async () => {
  const expected = { ...recoveryFixture().expected, event: "push" };
  for (const fail of [
    () => {
      throw new Error("untrusted transport detail");
    },
    () => new Response("untrusted response detail", { status: 404 }),
    () => new Response("malformed JSON detail"),
    () => Response.redirect("https://example.invalid/ignored"),
  ]) {
    const calls = [];
    await assert.rejects(
      fetchPureHonoRecoveryRun(expected, "fixture-token", async (url) => {
        calls.push(url);
        return fail();
      }),
      { message: "pure Hono recovery run refused: GitHub metadata unavailable" },
    );
    assert.deepEqual(calls, [attemptUrl]);
  }
});

const recoveryAsset = (path, bytes = Buffer.alloc(0)) => ({ path, bytes });

function packagerInput() {
  const { expected, run } = recoveryFixture();
  return {
    worker: Buffer.from("export default {};\n"),
    effectiveConfig: Buffer.from('{ "name": "synthetic" }\n'),
    assets: [recoveryAsset("assets/version.json", Buffer.from("{}"))],
    sourceSha: expected.sourceSha,
    originalVersionId: expected.originalVersionId,
    run,
  };
}

function versionedConfigFixture() {
  return {
    scope: "versioned",
    scriptName: "two-web-next-production",
    versionId: "11111111-1111-4111-8111-111111111111",
    compatibilityDate: "2024-02-29",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ASSETS: { kind: "assets" },
      CF_VERSION_METADATA: { kind: "version_metadata" },
      DB: { kind: "hyperdrive", id: "7489f6ad630042148cdef83602f27b8a" },
      BOT_DB: { kind: "hyperdrive", id: "14c00d84d1d446c1b117861f3b49473f" },
      INTERNAL_ACTION_QUEUE: {
        kind: "queue",
        queueName: "two-web-next-production-internal-action",
      },
      SYNC_EVENT_QUEUE: { kind: "queue", queueName: "two-web-next-production-sync-event" },
      APP_URL: { kind: "plain_text", text: "https://togetherweown.com" },
      DISCORD_CLIENT_ID: { kind: "plain_text", text: "1539711683898118154" },
      DISCORD_GUILD_ID: { kind: "plain_text", text: "326474832151838730" },
      DISCORD_INVITE_URL: { kind: "plain_text", text: "https://discord.gg/4GwEDNRTtx" },
      DISCORD_MODERATOR_ROLE_IDS: {
        kind: "plain_text",
        text: "1546777855801954408,1546777856984481792",
      },
      FEATURED_IMAGE_HOSTS: { kind: "plain_text", text: "" },
      DISCORD_BOT_TOKEN: { kind: "secret_text" },
      DISCORD_CLIENT_SECRET: { kind: "secret_text" },
      SESSION_SECRET: { kind: "secret_text" },
    },
  };
}

test("pure Hono versioned config preserves reviewed fields in deterministic partial bytes", () => {
  const { scope, ...versioned } = versionedConfigFixture();
  const result = projectPureHonoVersionedConfig({ scope, ...versioned });
  const expected = { schema: "two.pure-hono-versioned-config.partial.v1", ...versioned };
  assert.deepEqual(result, {
    partialVersionedConfig: Buffer.from(`${JSON.stringify(expected)}\n`, "utf8"),
  });
  const reverseFields = (value) => Object.fromEntries(Object.entries(value).reverse());
  const shuffled = reverseFields({
    scope,
    ...versioned,
    bindings: Object.fromEntries(
      Object.entries(versioned.bindings)
        .reverse()
        .map(([name, value]) => [name, reverseFields(value)]),
    ),
  });
  assert.deepEqual(projectPureHonoVersionedConfig(shuffled), result);
  assert.throws(() => packPureHonoRecovery({ ...packagerInput(), effectiveConfig: result }), {
    message: "pure Hono recovery packaging refused: worker or config missing",
  });
});

test("pure Hono versioned config refuses unsafe observations without echoing data", () => {
  const sentinel = "DO-NOT-SERIALIZE-fixture-credential-or-unreviewed-text";
  const fixture = versionedConfigFixture();
  const { bindings } = fixture;
  const cases = [
    [null, "versioned observation shape"],
    [{ ...fixture, scope: "non-versioned" }, "versioned observation shape"],
    [{ ...fixture, compatibilityDate: undefined }, "runtime compatibility"],
    [{ ...fixture, [sentinel]: [] }, "versioned observation shape"],
    [{ ...fixture, [Symbol(sentinel)]: [] }, "versioned observation shape"],
    [Object.defineProperty({ ...fixture }, sentinel, { value: [] }), "versioned observation shape"],
    [{ ...fixture, routes: [] }, "versioned observation shape"],
    [{ ...fixture, scriptName: sentinel }, "version identity"],
    [{ ...fixture, versionId: `${fixture.versionId}\n` }, "version identity"],
    [{ ...fixture, versionId: "00000000-0000-0000-0000-000000000000" }, "version identity"],
    [{ ...fixture, compatibilityDate: "2025-02-29" }, "runtime compatibility"],
    [{ ...fixture, compatibilityFlags: ["nodejs_compat", sentinel] }, "runtime compatibility"],
    [{ ...fixture, compatibilityFlags: Array(1) }, "runtime compatibility"],
    [{ ...fixture, bindings: { ...bindings, [sentinel]: {} } }, "binding inventory"],
  ];
  for (const name of Object.keys(bindings)) {
    const incomplete = { ...bindings };
    delete incomplete[name];
    cases.push([{ ...fixture, bindings: incomplete }, "binding inventory"]);
  }
  for (const [name, replacement, error] of [
    ["DISCORD_BOT_TOKEN", { kind: "secret_text", value: sentinel }, "binding shape"],
    ["SESSION_SECRET", { kind: "plain_text", text: sentinel }, "binding shape"],
    [
      "FEATURED_IMAGE_HOSTS",
      { kind: "plain_text", text: "looks-public.example" },
      "unreviewed public value",
    ],
    ["DISCORD_INVITE_URL", { kind: "plain_text", text: sentinel }, "unreviewed public value"],
    ["INTERNAL_ACTION_QUEUE", { kind: "queue", queueName: sentinel }, "queue identity"],
    ["ASSETS", { kind: "assets", headers: sentinel }, "binding shape"],
    ["DB", { kind: "hyperdrive", id: "0".repeat(32) }, "Hyperdrive identity"],
    ["DB", bindings.BOT_DB, "Hyperdrive identity"],
    ["BOT_DB", { kind: "hyperdrive", id: "a".repeat(32) }, "Hyperdrive identity"],
  ]) {
    cases.push([{ ...fixture, bindings: { ...bindings, [name]: replacement } }, error]);
  }
  cases.push([
    Object.defineProperty(versionedConfigFixture(), "versionId", {
      get() {
        throw new Error(sentinel);
      },
    }),
    "versioned observation shape",
  ]);
  for (const [input, error] of cases) {
    assert.throws(
      () => projectPureHonoVersionedConfig(input),
      (failure) => {
        assert.equal(failure.message, `pure Hono versioned config refused: ${error}`);
        assert.ok(!String(failure.stack).includes(sentinel));
        assert.equal(failure.cause, undefined);
        return true;
      },
    );
  }
});

test("pure Hono packager deterministically round-trips the exact supplied bytes", () => {
  const input = packagerInput();
  const binary = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251));
  input.assets.push(
    recoveryAsset("assets/a.bin", binary),
    recoveryAsset("assets/z.bin", Buffer.alloc(4096)),
  );
  const packed = packPureHonoRecovery(input);
  assert.deepEqual(packPureHonoRecovery({ ...input, assets: input.assets.toReversed() }), packed);
  const { archive, archiveSha256 } = packed;
  assert.equal(archiveSha256, recoveryDigest(archive));
  assert.equal(archive.readUInt16LE(8), 8, "first asset uses DEFLATE");
  const { expected, attestation, run } = recoveryFixture();
  assert.deepEqual(
    validatePureHonoRecoveryEvidence({
      archive,
      expected: { ...expected, archiveSha256 },
      attestation: { ...attestation, subjectSha256: archiveSha256 },
      run,
      decode: decodePureHonoRecoveryZip,
    }),
    { archiveSha256, fileCount: 5 },
  );
  const members = decodePureHonoRecoveryZip(archive);
  const expectedFiles = [
    input.assets[1],
    input.assets[0],
    input.assets[2],
    { path: "effective-config.json", bytes: input.effectiveConfig },
    { path: "worker.js", bytes: input.worker },
  ];
  assert.deepEqual(
    members.slice(0, -1),
    expectedFiles.map((file) => ({ ...file, type: "file" })),
  );
  const manifest = members.at(-1);
  assert.equal(manifest.path, "manifest.json");
  assert.deepEqual(
    JSON.parse(manifest.bytes.toString()).files,
    expectedFiles.map(({ path, bytes }) => ({
      path,
      bytes: bytes.length,
      sha256: recoveryDigest(bytes),
    })),
  );
});

test("pure Hono packager refuses invalid producer identity and missing payloads", () => {
  const input = packagerInput();
  for (const change of [
    { run: undefined },
    { run: { ...input.run, conclusion: "failure" } },
    { run: { ...input.run, status: "in_progress" } },
    { run: { ...input.run, ref: "refs/heads/release" } },
    { run: { ...input.run, repository: "Other/two-web-next" } },
    { run: { ...input.run, workflow: ".github/workflows/../ci.yml" } },
    { run: { ...input.run, runId: "0123" } },
    { run: { ...input.run, runAttempt: "9007199254740992" } },
    { sourceSha: "b".repeat(40) },
    { originalVersionId: "invalid" },
  ])
    assert.throws(
      () => packPureHonoRecovery({ ...input, ...change }),
      /successful main producer identity/,
    );
  assert.throws(
    () => packPureHonoRecovery({ ...input, worker: Buffer.alloc(0) }),
    /worker or config missing/,
  );
  assert.throws(
    () => packPureHonoRecovery({ ...input, effectiveConfig: undefined }),
    /worker or config missing/,
  );
  assert.throws(() => packPureHonoRecovery({ ...input, assets: [] }), /assets missing/);
  assert.throws(
    () => packPureHonoRecovery({ ...input, assets: [{ path: "assets/a" }] }),
    /asset bytes/,
  );
});

test("pure Hono packager refuses unsafe, reserved, duplicate and aliased asset paths", () => {
  const input = packagerInput();
  const packPaths = (...paths) =>
    packPureHonoRecovery({ ...input, assets: paths.map((path) => recoveryAsset(path)) });
  for (const path of [
    "manifest.json",
    "worker.js",
    "effective-config.json",
    "assets/../a",
    "assets/AUX.txt",
    "assets/lpt0/file",
    "assets/a.",
    "assets/é",
    `assets/${"x/".repeat(31)}y`,
    `assets/${"a".repeat(506)}`,
  ])
    assert.throws(() => packPaths(path), /asset path/);
  for (const pair of [
    ["assets/a", "assets/a"],
    ["assets/a", "assets/A"],
    ["assets/Dir/x", "assets/dir/y"],
    ["assets/a", "assets/a/b"],
    ["assets/a/b", "assets/a"],
  ])
    assert.throws(() => packPaths(...pair), /duplicate or aliased path/);
});

test("pure Hono packager accounts for the manifest and ZIP overhead in size limits", () => {
  const input = packagerInput();
  const { maxEntries, maxTotalBytes, maxArchiveBytes } = RECOVERY_MEMBER_LIMITS;
  assert.throws(
    () => packPureHonoRecovery({ ...input, assets: Array(maxEntries - 2) }),
    /member count/,
  );
  const fixedBytes = input.worker.length + input.effectiveConfig.length;
  const block = Buffer.alloc(1024 * 1024);
  const tooExpanded = Array.from({ length: maxTotalBytes / block.length }, (_, i) =>
    recoveryAsset(`assets/${i}`, block),
  );
  assert.throws(() => packPureHonoRecovery({ ...input, assets: tooExpanded }), /expanded size/);
  // The payload now fits exactly; only the generated manifest exceeds the expanded cap.
  tooExpanded.at(-1).bytes = block.subarray(0, block.length - fixedBytes);
  assert.throws(() => packPureHonoRecovery({ ...input, assets: tooExpanded }), /expanded size/);
  const tooManyLongNames = Array.from({ length: 2000 }, (_, i) =>
    recoveryAsset(`assets/${i}-${"a".repeat(490)}`),
  );
  assert.throws(
    () => packPureHonoRecovery({ ...input, assets: tooManyLongNames }),
    /manifest size/,
  );
  // The zeros must STORE (DEFLATE exceeds the ratio cap). Leave 1280 bytes beyond the
  // payload: enough with a short name, but less than the headers with a 512-byte name.
  const bytes = Buffer.alloc(maxArchiveBytes - fixedBytes - 1280);
  const packWithName = (path) =>
    packPureHonoRecovery({ ...input, assets: [recoveryAsset(path, bytes)] });
  assert.ok(packWithName("assets/archive.bin").archive.length <= maxArchiveBytes);
  assert.throws(() => packWithName(`assets/${"a".repeat(505)}`), /archive size/);
});

test("pure Hono archive binds a successful main run and hashes every declared member", () => {
  const input = recoveryFixture();
  assert.deepEqual(validatePureHonoRecoveryEvidence(input), {
    archiveSha256: input.expected.archiveSha256,
    fileCount: 3,
  });
});

for (const [label, change, reason] of [
  ["different archive bytes", (x) => x.archive.fill(0), /pinned archive digest/],
  ["no verified attestation", (x) => delete x.attestation, /verified attestation/],
  [
    "different signed subject",
    (x) => (x.attestation.subjectSha256 = "0".repeat(64)),
    /attestation/,
  ],
  ["different signed source", (x) => (x.attestation.sourceSha = "b".repeat(40)), /attestation/],
  ["different signer", (x) => (x.attestation.workflow = ".github/workflows/ci.yml"), /attestation/],
  ["forked signer", (x) => (x.attestation.repository = "Other/two-web-next"), /attestation/],
  ["missing signed invocation", (x) => delete x.attestation.invocationId, /attestation invocation/],
  [
    "signed invocation for a different attempt",
    (x) => (x.attestation.invocationId = recoveryInvocation.replace(/2$/, "1")),
    /attestation invocation/,
  ],
  [
    "signed invocation for a different run",
    (x) => (x.attestation.invocationId = recoveryInvocation.replace("/123/", "/124/")),
    /attestation invocation/,
  ],
  [
    "signed invocation from another repository",
    (x) => (x.attestation.invocationId = recoveryInvocation.replace("TogetherWeOwn", "Other")),
    /attestation invocation/,
  ],
  ["different run source", (x) => (x.run.sourceSha = "b".repeat(40)), /successful main run/],
  ["missing run source", (x) => delete x.run.sourceSha, /successful main run/],
  ["stale run attempt", (x) => (x.run.runAttempt = "1"), /successful main run/],
  ["failed run", (x) => (x.run.conclusion = "failure"), /successful main run/],
  ["non-main run", (x) => (x.run.ref = "refs/heads/dev"), /successful main run/],
]) {
  test(`pure Hono archive refuses ${label} before decoding`, () => {
    const input = recoveryFixture();
    change(input);
    const decode = input.decode;
    let decoded = false;
    input.decode = (archive) => {
      decoded = true;
      return decode(archive);
    };
    assert.throws(() => validatePureHonoRecoveryEvidence(input), reason);
    assert.equal(decoded, false);
  });
}

for (const [label, mutation, reason] of [
  ["changed asset bytes", { changeFiles: (files) => (files[2].bytes = "[]") }, /file digest/],
  ["wrong declared byte length", { changeManifest: (m) => m.files[2].bytes++ }, /file digest/],
  ["missing asset", { changeFiles: (files) => files.pop() }, /file set/],
  [
    "undeclared asset",
    { changeFiles: (files) => files.push({ path: "assets/extra", bytes: "" }) },
    /file set/,
  ],
  ["duplicate member", { changeFiles: (files) => files.push(files[2]) }, /archive members/],
  ["linked asset", { changeFiles: (files) => (files[2].type = "symlink") }, /archive members/],
  [
    "path traversal",
    { changeFiles: (files) => (files[2].path = "assets/../worker.js") },
    /archive members/,
  ],
  [
    "directory alias",
    { changeFiles: (files) => files.push({ path: "assets/Version.json/x", bytes: "" }) },
    /archive members/,
  ],
  ["duplicate declaration", { changeManifest: (m) => (m.files[2] = m.files[1]) }, /file set/],
  [
    "wrong original UUID",
    { changeManifest: (m) => (m.originalVersionId = V2) },
    /manifest identity/,
  ],
  [
    "duplicate JSON key",
    { encodeManifest: (m) => `{"target":"other",${JSON.stringify(m).slice(1)}` },
    /manifest encoding/,
  ],
  [
    "empty asset set",
    { changeFiles: (files) => files.pop(), changeManifest: (m) => m.files.pop() },
    /assets missing/,
  ],
]) {
  test(`pure Hono archive refuses ${label}`, () => {
    assert.throws(() => validatePureHonoRecoveryEvidence(recoveryFixture(mutation)), reason);
  });
}

const MIB = 1024 ** 2;

test("pure Hono archive enforces the archive byte limits before decoding", () => {
  const fixture = recoveryFixture();
  const max = Buffer.alloc(64 * MIB + 1);
  for (const size of [0, max.length - 1, max.length]) {
    const archive = max.subarray(0, size);
    const sha256 = recoveryDigest(archive);
    let decoded = false;
    const input = {
      ...fixture,
      archive,
      expected: { ...fixture.expected, archiveSha256: sha256 },
      attestation: { ...fixture.attestation, subjectSha256: sha256 },
      decode: () => {
        decoded = true;
        return fixture.decode(fixture.archive);
      },
    };
    if (size === max.length - 1) {
      assert.equal(validatePureHonoRecoveryEvidence(input).fileCount, 3);
    } else {
      assert.throws(() => validatePureHonoRecoveryEvidence(input), /archive size$/);
      assert.equal(decoded, false);
    }
  }
});

test("pure Hono archive enforces the expanded byte limit including the manifest", () => {
  const chunk = Buffer.alloc(MIB);
  for (const extra of [0, 1]) {
    const input = recoveryFixture();
    const members = input.decode(input.archive);
    const initialSize = members.reduce((sum, { bytes }) => sum + bytes.length, 0);
    // Reuse a buffer across synthetic members instead of allocating 128 MiB.
    for (let left = 128 * MIB + extra - initialSize; left > 0; left -= MIB) {
      members.push({ path: `assets/pad-${left}`, bytes: chunk.subarray(0, left), type: "file" });
    }
    input.decode = () => members;
    // At the limit the later inventory check rejects the undeclared padding.
    assert.throws(
      () => validatePureHonoRecoveryEvidence(input),
      extra ? /archive members/ : /file set$/,
    );
  }
});

test("pure Hono archive enforces the member count including the manifest", () => {
  for (const count of [4096, 4097]) {
    const input = recoveryFixture({
      prepareFiles: (files) => {
        while (files.length < count) files.push({ path: `assets/${files.length}`, bytes: "" });
      },
    });
    if (count === 4096) assert.equal(validatePureHonoRecoveryEvidence(input).fileCount, count);
    else assert.throws(() => validatePureHonoRecoveryEvidence(input), /archive members/);
  }
});

test("pure Hono archive enforces the manifest byte limits", () => {
  for (const size of [0, MIB, MIB + 1]) {
    const input = recoveryFixture({
      encodeManifest: () => (size ? JSON.stringify("x".repeat(size - 2)) : ""),
    });
    // A canonical JSON string of exactly 1 MiB clears the size check, not the schema.
    assert.throws(
      () => validatePureHonoRecoveryEvidence(input),
      size === MIB ? /manifest identity$/ : /archive members/,
    );
  }
});

test("pure Hono archive enforces the member path length limit", () => {
  for (const extra of [0, 1]) {
    const input = recoveryFixture({
      prepareFiles: (files) => (files[2].path = `assets/${"a".repeat(505 + extra)}`),
    });
    if (extra) assert.throws(() => validatePureHonoRecoveryEvidence(input), /archive members/);
    else assert.equal(validatePureHonoRecoveryEvidence(input).fileCount, 3);
  }
});

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";
const V4 = "44444444-4444-4444-8444-444444444444";
const TARGET = "a".repeat(40);
const PREVIOUS = "b".repeat(40);

const full = (id, created_on) => ({ created_on, versions: [{ version_id: id, percentage: 100 }] });
const split = (a, b, created_on) => ({
  created_on,
  versions: [
    { version_id: a, percentage: 50 },
    { version_id: b, percentage: 50 },
  ],
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("each environment maps to its own Worker and origin; anything else refuses", () => {
  assert.deepEqual(rollbackEnvironment("production"), {
    name: "production",
    worker: "two-web-next-production",
    origin: "https://togetherweown.com",
    indexable: true,
  });
  assert.deepEqual(rollbackEnvironment("staging"), {
    name: "staging",
    worker: "two-web-next",
    origin: "https://next.togetherweown.com",
    indexable: false,
  });
  for (const name of [undefined, "", "Production", "preview", "toString", "__proto__"]) {
    assert.throws(() => rollbackEnvironment(name), /Rollback environment must be one of/);
  }
  assert.deepEqual(Object.keys(ROLLBACK_ENVIRONMENTS), ["production", "staging"]);
});

test("live version is the newest deployment by created_on, single-version 100% only", () => {
  // wrangler prints oldest first; order never decides.
  const list = [full(V1, "2026-11-01T01:00:00Z"), full(V2, "2026-11-01T02:00:00Z")];
  assert.equal(liveVersion(list), V2);
  assert.equal(liveVersion([...list].reverse()), V2);
  assert.throws(
    () => liveVersion([...list, split(V2, V3, "2026-11-01T03:00:00Z")]),
    /not a single-version 100% deployment/,
  );
  assert.throws(() => liveVersion([]), /non-empty deployments list/);
  assert.throws(() => liveVersion([full("not-a-uuid", "2026-11-01T01:00:00Z")]));
});

test("previous version skips split rollouts and redeploys of the live version", () => {
  const list = [
    full(V1, "2026-11-01T01:00:00Z"),
    split(V1, V2, "2026-11-01T02:00:00Z"),
    full(V2, "2026-11-01T03:00:00Z"),
    split(V2, V3, "2026-11-01T04:00:00Z"),
    full(V3, "2026-11-01T05:00:00Z"),
    full(V3, "2026-11-01T06:00:00Z"),
  ];
  assert.equal(previousVersion(list), V2);
  assert.throws(
    () => previousVersion([full(V1, "2026-11-01T01:00:00Z"), full(V1, "2026-11-01T02:00:00Z")]),
    /No earlier single-version 100% deployment/,
  );
});

test("rollback guard: rollback while expected is live, skip when target serves, refuse otherwise", () => {
  const live = (id) => [full(V4, "2026-11-01T00:00:00Z"), full(id, "2026-11-01T01:00:00Z")];
  assert.equal(rollbackAction(live(V2), { expected: V2, target: V1 }), "rollback");
  assert.equal(rollbackAction(live(V1), { expected: V2, target: V1 }), "skip");
  assert.throws(
    () => rollbackAction(live(V3), { expected: V2, target: V1 }),
    /neither the expected .* nor the target/,
  );
  assert.throws(() => rollbackAction(live(V2), { expected: "", target: V1 }), /lowercase UUID/);
  assert.throws(() => rollbackAction(live(V2), { expected: V2, target: "x;id" }), /lowercase UUID/);
});

test("destructive statements refuse; comments, triggers and additive DDL do not", () => {
  assert.deepEqual(destructiveStatements('CREATE TABLE "a" ("id" text);'), []);
  assert.deepEqual(destructiveStatements('ALTER TABLE "a" ADD COLUMN "b" text;'), []);
  assert.deepEqual(
    destructiveStatements(
      '-- UPDATE and TRUNCATE are refused\nCREATE TRIGGER "t" BEFORE TRUNCATE ON "a" FOR EACH STATEMENT EXECUTE FUNCTION f();',
    ),
    [],
  );
  assert.deepEqual(destructiveStatements("/* DROP TABLE a; */ SELECT 1;"), []);
  for (const sql of [
    'DROP TABLE "agent_events";',
    'ALTER TABLE "a" DROP COLUMN "b";',
    'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
    'ALTER TABLE "a" RENAME TO "z";',
    'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;',
    'ALTER TABLE "a" ALTER COLUMN b TYPE integer;',
    'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
    "TRUNCATE a;",
    'CREATE TABLE "x" ("id" text);\n--> statement-breakpoint\nDROP VIEW "web_v1"."events";',
  ]) {
    assert.equal(destructiveStatements(sql).length, 1, sql);
  }
  // A reviewed note (at least 10 characters of reason) clears the migration.
  assert.deepEqual(
    destructiveStatements(
      '-- rollback-safe: agent_events moved in 1018; no deployed code reads it\nDROP TABLE "agent_events";',
    ),
    [],
  );
  assert.equal(destructiveStatements('-- rollback-safe: ok\nDROP TABLE "a";').length, 1);
  assert.equal(destructiveStatements('--rollback-safe\nDROP TABLE "a";').length, 1);
});

test("the checked-in migrations classify as expected", () => {
  // 1019 drops the old agent_events table; 1018 only mentions TRUNCATE in
  // comments and BEFORE TRUNCATE triggers.
  assert.equal(destructiveStatements(read("../drizzle/1019_shared-agent-events.sql")).length, 1);
  assert.deepEqual(destructiveStatements(read("../drizzle/1018_audit-immutability.sql")), []);
});

function journal(tags) {
  return Buffer.from(
    JSON.stringify({ entries: tags.map((tag, i) => ({ tag, when: 1000 + i })) }),
  ).toString("base64");
}

function stubRepo({ target, previous, sql, up, drill, seen = {} }) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/up") {
      seen.up = (seen.up ?? 0) + 1;
      return { ok: true, json: async () => up };
    }
    if (parsed.pathname.endsWith("/contents/drizzle/meta/_journal.json")) {
      const ref = parsed.searchParams.get("ref");
      const tags = ref === TARGET ? target : ref === PREVIOUS ? previous : assert.fail(ref);
      return { ok: true, json: async () => ({ encoding: "base64", content: journal(tags) }) };
    }
    const tag = parsed.pathname.match(/\/contents\/drizzle\/([^/]+)\.sql$/)?.[1];
    if (tag) {
      assert.equal(parsed.searchParams.get("ref"), TARGET);
      seen.sql = [...(seen.sql ?? []), decodeURIComponent(tag)];
      if (!(tag in sql)) return { ok: false, status: 404 };
      return { ok: true, text: async () => sql[tag] };
    }
    if (parsed.pathname.endsWith("/workflows/staging-rollback-drill.yml/runs")) {
      assert.equal(parsed.searchParams.get("branch"), "main");
      if (drill === 404) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ workflow_runs: drill }) };
    }
    assert.fail(`unexpected path ${parsed.pathname}`);
  };
}

test("compatibility reads only the migrations the target adds since the rollback commit", async () => {
  const seen = {};
  const result = await rollbackCompatibility({
    repository: "fixture/repo",
    targetSha: TARGET,
    previousSha: PREVIOUS,
    token: "fixture-only",
    fetchImpl: stubRepo({
      target: ["1000_a", "1001_b", "1002_c"],
      previous: ["1000_a"],
      sql: { "1001_b": 'ALTER TABLE "a" ADD COLUMN "b" text;', "1002_c": 'DROP TABLE "z";' },
      seen,
    }),
  });
  assert.deepEqual(result, { added: ["1001_b", "1002_c"], unsafe: ["1002_c"] });
  assert.deepEqual(seen.sql, ["1001_b", "1002_c"]);
});

test("an unreadable migration file fails closed", async () => {
  await assert.rejects(
    rollbackCompatibility({
      repository: "fixture/repo",
      targetSha: TARGET,
      previousSha: PREVIOUS,
      token: "fixture-only",
      fetchImpl: stubRepo({ target: ["1000_a", "1001_b"], previous: ["1000_a"], sql: {} }),
    }),
    /Migration 1001_b lookup failed \(HTTP 404\)/,
  );
});

const upOk = { revision: { version_id: V1, commit: PREVIOUS } };
function target(overrides = {}, sql = { "1001_b": "SELECT 1;" }) {
  const { up = upOk, ...rest } = overrides;
  return checkRollbackTarget({
    origin: "https://togetherweown.com",
    repository: "fixture/repo",
    targetSha: TARGET,
    token: "fixture-only",
    fetchImpl: stubRepo({ target: ["1000_a", "1001_b"], previous: ["1000_a"], sql, up }),
    sleep: async () => {},
    ...rest,
  });
}

test("rollback target is the version /up names, with its commit, when no migration breaks it", async () => {
  assert.deepEqual(await target(), { versionId: V1, commit: PREVIOUS, added: ["1001_b"] });
});

test("no valid rollback target refuses promotion", async () => {
  for (const up of [
    {},
    { revision: { version_id: V1, commit: null } },
    { revision: { version_id: "nope", commit: PREVIOUS } },
    { revision: { version_id: V1, commit: "main" } },
  ]) {
    await assert.rejects(target({ up }), /No valid rollback target: \/up did not report/);
  }
  await assert.rejects(
    target({}, { "1001_b": 'ALTER TABLE "a" DROP COLUMN "b";' }),
    /No valid rollback target: 1001_b would break 11111111-.*rollback-safe/,
  );
  await assert.rejects(target({ targetSha: "main" }), /DEPLOY_SHA must be a full 40-hex commit/);
});

test("rollback target retries an unreadable /up before refusing", async () => {
  let reads = 0;
  const result = await target({
    readRevision: async () => {
      reads += 1;
      if (reads < 3) throw new Error("timeout");
      return { versionId: V1, commit: PREVIOUS };
    },
  });
  assert.equal(result.versionId, V1);
  assert.equal(reads, 3);
});

const drillRun = (id, conclusion) => ({ id, conclusion, status: "completed" });
function drill(runs) {
  return assertRollbackDrillGreen({
    repository: "fixture/repo",
    token: "fixture-only",
    fetchImpl: stubRepo({ drill: runs }),
  });
}

test("a red latest staging rollback drill holds promotion; none yet does not", async () => {
  assert.equal(await drill(404), null);
  assert.equal(await drill([]), null);
  assert.equal(await drill([drillRun(2, "success"), drillRun(1, "failure")]), 2);
  // Cancelled and skipped runs prove nothing either way.
  assert.equal(await drill([drillRun(3, "cancelled"), drillRun(2, "success")]), 2);
  for (const conclusion of ["failure", "timed_out", "action_required"]) {
    await assert.rejects(
      drill([drillRun(1, "success"), drillRun(2, conclusion)]),
      new RegExp(`run 2\\) concluded ${conclusion}`),
    );
  }
});

test("staging lane CLI requires trustworthy run listings", async (t) => {
  const sentinel = "PRIVATE_FIXTURE_BODY";
  const empty = { workflow_runs: [] };
  const occupied = { workflow_runs: [{ id: 1 }, { id: 1 }, { id: Number.MAX_SAFE_INTEGER }] };
  const occupiedMessage =
    "Staging lane busy: e2e-staging.yml run 1, e2e-staging.yml run 1, " +
    `e2e-staging.yml run ${Number.MAX_SAFE_INTEGER}\n`;
  const cases = [
    { name: "empty", body: empty, busy: false },
    { name: "occupied with boundary IDs and duplicates", body: occupied, busy: true },
    { name: "absent listing", body: { details: sentinel } },
    { name: "null listing", body: { workflow_runs: null } },
    { name: "string listing", body: { workflow_runs: sentinel } },
    { name: "object listing", body: { workflow_runs: { details: sentinel } } },
    { name: "null run", body: { workflow_runs: [null] } },
    { name: "missing ID", body: { workflow_runs: [{}] } },
    ...[sentinel, "7", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ({
      name: `invalid ID ${id}`,
      body: { workflow_runs: [{ id }] },
    })),
    { name: "mixed listing", body: { workflow_runs: [{ id: 7 }, { id: sentinel }] } },
  ];

  for (const { name, body, busy } of cases) {
    await t.test(name, (t) => {
      const dir = mkdtempSync(join(tmpdir(), "staging-lane-proof-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const output = join(dir, "out");
      const stubs = [
        { match: "/e2e-staging.yml/runs?status=waiting&per_page=20", body },
        { match: "/runs?status=", body: empty },
      ];
      const result = spawnSync(process.execPath, ["ci/rollback-target.mjs", "--staging-busy"], {
        encoding: "utf8",
        env: {
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_TOKEN: "fixture-only",
          NODE_OPTIONS: `--import=${new URL("./test-fetch-stub.mjs", import.meta.url).href}`,
          FETCH_STUB_JSON: JSON.stringify(stubs),
        },
      });
      assert.ifError(result.error);
      if (busy === undefined) {
        assert.equal(result.status, 1, result.stdout);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "::error::Staging lane lookup returned an invalid run listing\n");
        assert.equal(existsSync(output), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(readFileSync(output, "utf8"), `busy=${busy}\n`);
        assert.equal(result.stdout, busy ? occupiedMessage : "Staging lane idle\n");
      }
    });
  }

  await t.test("malformed JSON", async () => {
    await assert.rejects(
      stagingBusyRuns({
        repository: "fixture/repo",
        token: "fixture-only",
        fetchImpl: async () => new Response(sentinel),
      }),
      { message: "Staging lane lookup returned an invalid run listing" },
    );
  });
});

test("staging lane is busy while deploy or e2e-staging runs are queued or running", async () => {
  const asked = [];
  const busy = await stagingBusyRuns({
    repository: "fixture/repo",
    token: "fixture-only",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const file = parsed.pathname.match(/workflows\/([^/]+)\/runs$/)[1];
      const status = parsed.searchParams.get("status");
      asked.push(`${file}:${status}`);
      const runs = file === "e2e-staging.yml" && status === "in_progress" ? [{ id: 7 }] : [];
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    },
  });
  assert.deepEqual(busy, ["e2e-staging.yml run 7"]);
  assert.deepEqual(asked, [
    "deploy.yml:in_progress",
    "deploy.yml:queued",
    "deploy.yml:waiting",
    "e2e-staging.yml:in_progress",
    "e2e-staging.yml:queued",
    "e2e-staging.yml:waiting",
  ]);
});

function cli(args, { env = {}, input } = {}) {
  const output = join(mkdtempSync(join(tmpdir(), "rollback-target-")), "out");
  const result = spawnSync(process.execPath, ["ci/rollback-target.mjs", ...args], {
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
  });
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    written = "";
  }
  return { ...result, written };
}

test("CLI resolves the environment, the guard action and refuses unknown flags", () => {
  const staging = cli(["--environment"], { env: { ROLLBACK_ENVIRONMENT: "staging" } });
  assert.equal(staging.status, 0);
  assert.equal(
    staging.written,
    "worker=two-web-next\norigin=https://next.togetherweown.com\nindexable=false\n",
  );
  const bad = cli(["--environment"], { env: { ROLLBACK_ENVIRONMENT: "prod" } });
  assert.equal(bad.status, 1);
  assert.equal(bad.written, "");
  const deployments = JSON.stringify([full(V1, "2026-11-01T01:00:00Z")]);
  const skip = cli(["--action"], {
    env: { EXPECTED_CURRENT_VERSION_ID: V2, ROLLBACK_VERSION_ID: V1 },
    input: deployments,
  });
  assert.equal(skip.status, 0);
  assert.equal(skip.written, "action=skip\n");
  const refuse = cli(["--action"], {
    env: { EXPECTED_CURRENT_VERSION_ID: V2, ROLLBACK_VERSION_ID: V3 },
    input: deployments,
  });
  assert.equal(refuse.status, 1);
  assert.equal(refuse.written, "");
  assert.ok(!refuse.stderr.includes("created_on"), "never echo the wrangler listing");
  assert.equal(cli(["--live-version"], { input: deployments }).stdout, `${V1}\n`);
  assert.equal(cli(["--nope"]).status, 2);
  assert.equal(cli([]).status, 2);
});

test("the staging drill rolls back and forward through rollback-production.yml", () => {
  const workflow = read("../.github/workflows/staging-rollback-drill.yml");
  assert.match(workflow, /\n  schedule:\n    - cron: "41 3 \* \* \*"\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.ok(!/\n  (push|pull_request|workflow_run):/.test(workflow));
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read # \S[^\n]*\n\n/m);
  const legs = [
    ...workflow.matchAll(
      /uses: TogetherWeOwn\/two-web-next\/\.github\/workflows\/rollback-production\.yml@38581ef492f5c972969f5dfada396a9f0e2ee989\n/g,
    ),
  ];
  assert.equal(legs.length, 2, "both legs call the production rollback workflow");
  const rollback = workflow.slice(
    workflow.indexOf("\n  rollback:\n"),
    workflow.indexOf("\n  restore:\n"),
  );
  const restore = workflow.slice(
    workflow.indexOf("\n  restore:\n"),
    workflow.indexOf("\n  verdict:\n"),
  );
  for (const leg of [rollback, restore]) {
    assert.match(leg, /environment: staging\n/);
    assert.match(leg, /ref: \$\{\{ needs\.plan\.outputs\.ref \}\}\n/);
    // Least privilege: the drill passes only the two repo-level staging
    // Cloudflare values under their own names, never a blanket inherit.
    assert.ok(!/secrets: inherit/.test(leg), "no blanket secret inherit on a staging leg");
    assert.match(leg, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    assert.match(leg, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    assert.ok(!/environment: production/.test(leg), "the drill never targets production");
  }
  assert.match(rollback, /version_id: \$\{\{ needs\.plan\.outputs\.previous \}\}/);
  assert.match(rollback, /expected_current_version_id: \$\{\{ needs\.plan\.outputs\.live \}\}/);
  assert.match(restore, /version_id: \$\{\{ needs\.plan\.outputs\.live \}\}/);
  assert.match(restore, /expected_current_version_id: \$\{\{ needs\.plan\.outputs\.previous \}\}/);
  // The restore runs even after a failed rollback leg.
  assert.match(restore, /if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' \}\}/);
  // A skipped leg is not a drill: the verdict needs traffic to move twice.
  const verdict = workflow.slice(workflow.indexOf("\n  verdict:\n"));
  assert.match(verdict, /if: \$\{\{ always\(\) \}\}/);
  assert.match(verdict, /"\$ROLLBACK_ACTION" != rollback/);
  assert.match(verdict, /"\$RESTORE_ACTION" != rollback/);
  // The whole drill owns staging, including the gap between both legs.
  assert.match(workflow, /concurrency:\n  group: .*&& 'deploy-staging'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /--staging-busy/);
  const callee = read("../.github/workflows/rollback-production.yml");
  assert.match(
    callee,
    /github\.workflow == 'staging-rollback-drill' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(callee, /format\('staging-drill-leg-\{0\}', github\.run_id\)/);
  assert.match(callee, /\|\| 'deploy-staging'\) \|\| 'production-worker-mutation'/);
  const selector = callee.match(/^concurrency:\n  group: \$\{\{ (.+) \}\}/m)[1];
  const select = new Function("inputs", "github", "format", `return ${selector}`);
  const format = (template, value) => template.replace("{0}", value);
  const mainDrill = { workflow: "staging-rollback-drill", ref: "refs/heads/main", run_id: 7 };
  assert.equal(select({ environment: "staging" }, mainDrill, format), "staging-drill-call-7");
  assert.equal(
    select({ environment: "staging" }, { ...mainDrill, workflow: "rollback-production" }, format),
    "rollback-staging",
  );
  assert.equal(
    select({ environment: "staging" }, { ...mainDrill, ref: "refs/heads/feature" }, format),
    "rollback-staging",
  );
  assert.equal(select({ environment: "production" }, mainDrill, format), "rollback-production");
  // Only staging (repo-level) credentials, never production ones.
  assert.ok(!/secrets\.PRODUCTION_/.test(workflow));
});

test("rollback-production exposes the guard inputs and reports whether traffic moved", () => {
  const workflow = read("../.github/workflows/rollback-production.yml");
  const call = workflow.slice(
    workflow.indexOf("\n  workflow_call:\n"),
    workflow.indexOf("\npermissions:"),
  );
  for (const input of ["environment", "version_id", "ref", "expected_current_version_id"]) {
    assert.match(call, new RegExp(`\\n      ${input}:\\n`));
  }
  // Least privilege: every caller secret arrives by declared name, including
  // the production Environment secrets the called job's own environment
  // binding receives.
  for (const secret of [
    "PRODUCTION_CLOUDFLARE_API_TOKEN",
    "PRODUCTION_CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "PAPERCLIP_DEPLOY_WEBHOOK_SECRET",
  ]) {
    assert.match(call, new RegExp(`\\n      ${secret}:\\n`));
  }
  assert.match(call, /value: \$\{\{ jobs\.rollback-production\.outputs\.action \}\}/);
  const guardAt = workflow.indexOf("- name: Refuse when an unexpected version is live");
  const secretsAt = workflow.indexOf(
    "run: node ci/check-production-secrets.mjs --rollback-version",
  );
  const rollbackAt = workflow.indexOf("- name: Roll back to the recorded Worker Version");
  assert.ok(guardAt > 0 && guardAt < secretsAt && secretsAt < rollbackAt);
  assert.match(
    workflow.slice(rollbackAt, rollbackAt + 200),
    /if: steps\.guard\.outputs\.action == 'rollback'/,
  );
  assert.match(
    workflow,
    /EXPECTED_CURRENT_VERSION_ID: \$\{\{ inputs\.expected_current_version_id \}\}/,
  );
});

test("promotion records a valid rollback target and honours the drill hold before deploying", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const preflight = workflow.slice(
    workflow.indexOf("\n  preflight:\n"),
    workflow.indexOf("\n  deploy-production:\n"),
  );
  // Both checks run from the tip checkout, before the target re-checkout,
  // so an older target cannot skip them.
  const retarget = preflight.indexOf("ref: ${{ steps.target.outputs.sha }}");
  const drillAt = preflight.indexOf("run: node ci/rollback-target.mjs --check-drill");
  const targetAt = preflight.indexOf("run: node ci/rollback-target.mjs --check-target");
  assert.ok(drillAt > 0 && targetAt > drillAt && retarget > targetAt);
  assert.match(
    preflight,
    /rollback_version_id: \$\{\{ steps\.rollback-target\.outputs\.version_id \}\}/,
  );
  const job = workflow.slice(
    workflow.indexOf("\n  deploy-production:\n"),
    workflow.indexOf("\n  release:\n"),
  );
  const confirmAt = job.indexOf(
    "- name: Confirm the recorded rollback target still exists with its secrets",
  );
  const tailAt = job.indexOf("- name: Deploy production alert Tail Worker first");
  assert.ok(confirmAt > 0 && confirmAt < tailAt);
  // The live-state checks run the workflow-tip scripts, not the target
  // checkout's: a rescue redeploy of a commit older than
  // --rollback-version/--capture-rollback-target must not run scripts that
  // predate those flags. The tip checkout precedes the confirm step.
  const tipAt = job.indexOf("path: workflow-tip");
  assert.ok(tipAt > 0 && tipAt < confirmAt);
  const confirm = job.slice(confirmAt, tailAt);
  assert.match(
    confirm,
    /node workflow-tip\/\.github\/actions\/gradual-promote\/gradual-promote\.mjs --capture-rollback-target/,
  );
  assert.match(confirm, /node workflow-tip\/ci\/check-production-secrets\.mjs --rollback-version/);
  // The gate recheck and the pre-deploy secrets check stay on the target
  // checkout: they assert the target's wrangler.jsonc and its required
  // secret set, the artifact being deployed.
  assert.match(job, /run: node ci\/production-deploy-gate\.mjs\n/);
  assert.match(job, /run: node ci\/check-production-secrets\.mjs\n/);
  assert.match(
    confirm,
    /ROLLBACK_VERSION_ID: \$\{\{ needs\.preflight\.outputs\.rollback_version_id \}\}/,
  );
});
