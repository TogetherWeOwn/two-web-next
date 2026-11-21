import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifyPureHonoRecoveryAttestation } from "./pure-hono-recovery-attestation.mjs";
import { validatePureHonoRecoveryEvidence } from "./pure-hono-recovery-evidence.mjs";
import { RECOVERY_MEMBER_LIMITS } from "./pure-hono-recovery-members.mjs";
import { fetchPureHonoRecoveryRun } from "./pure-hono-recovery-run.mjs";
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

const recoveryDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recoveryInvocation =
  "https://github.com/TogetherWeOwn/two-web-next/actions/runs/123/attempts/2";

function recoveryFixture({
  prepareFiles,
  changeFiles,
  changeManifest,
  encodeManifest = JSON.stringify,
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
  const archive = Buffer.from(
    JSON.stringify([...members, { path: "manifest.json", bytes: encodeManifest(manifest) }]),
  );
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

const signerWorkflow = "TrustedOrg/build/.github/workflows/sign.yml";
const signerDigest = "b".repeat(40);
const verifierIssuer = "https://token.actions.githubusercontent.com";
const provenanceV1 = "https://slsa.dev/provenance/v1";
const attestationRefusal = "pure Hono recovery attestation refused: ";
const unavailable = `${attestationRefusal}pinned verifier or its JSON output unavailable`;
const ghSuccess = (stdout) => ({ status: 0, signal: null, stdout: Buffer.from(stdout) });

function checkedAttestationFixture() {
  const input = recoveryFixture();
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
  ["unqualified workflow path", { path: ".github/workflows/archive-hono-recovery.yml" }],
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
