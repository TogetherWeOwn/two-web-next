import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_MEMBER_LIMITS } from "./pure-hono-recovery-members.mjs";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const REPOSITORY_URI = `https://github.com/${REPOSITORY}`;
const MAIN_REF = "refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";
const PREDICATE = "https://slsa.dev/provenance/v1";
const GH_VERSION = "2.103.3";
const MAX_OUTPUT = 2 * 1024 * 1024;
const WORKFLOW = /^\.github\/workflows\/[a-z0-9_-]+\.ya?ml$/;
const SIGNER =
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATTEMPT_PATH = /^\/([1-9][0-9]{0,19})\/attempts\/([1-9][0-9]{0,19})$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const refusal = (reason) => new Error(`pure Hono recovery attestation refused: ${reason}`);

function runGh(spawn, args) {
  const result = spawn("gh", args, {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  if (
    result?.error ||
    result?.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > MAX_OUTPUT
  )
    throw refusal("verifier process failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

// gh v2.103.3 emits an array of policy-passing verificationResult objects wrapped
// with their bundles (cli/cli pkg/cmd/attestation/verify). In sigstore-go v1.3.0,
// certificate.Summary embeds Extensions, so the authenticated fields are flat.
function normalize(results, { workflow, sourceSha, signerDigest, archiveSha256 }) {
  if (!Array.isArray(results) || results.length !== 1) throw refusal("verified result count");
  const verification = results[0]?.verificationResult;
  const cert = verification?.signature?.certificate;
  const statement = verification?.statement;
  if (
    cert?.issuer !== ISSUER ||
    cert.sourceRepositoryURI !== REPOSITORY_URI ||
    cert.sourceRepositoryRef !== MAIN_REF ||
    cert.sourceRepositoryDigest !== sourceSha ||
    cert.buildConfigURI !== `${REPOSITORY_URI}/${workflow}@${MAIN_REF}` ||
    cert.buildSignerDigest !== signerDigest ||
    statement?.predicateType !== PREDICATE ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.digest?.sha256 !== archiveSha256
  )
    throw refusal("verified identity or subject digest");

  // The statement is signed, but its predicate is supplied by the workflow.
  // Fulcio's GitHub OIDC extension binds the actual run and attempt separately.
  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId;
  const prefix = `${REPOSITORY_URI}/actions/runs`;
  const attempt =
    typeof invocationId === "string" &&
    invocationId === cert.runInvocationURI &&
    invocationId.startsWith(prefix) &&
    ATTEMPT_PATH.exec(invocationId.slice(prefix.length));
  if (!attempt) throw refusal("verified invocation");
  return {
    repository: REPOSITORY,
    ref: cert.sourceRepositoryRef,
    workflow,
    sourceSha: cert.sourceRepositoryDigest,
    runId: attempt[1],
    runAttempt: attempt[2],
    subjectSha256: statement.subject[0].digest.sha256,
    invocationId,
  };
}

// The caller supplies independent pins and a trusted gh installation on PATH.
// workflow/sourceSha identify the producer, not the signer or promotion candidate.
export function verifyPureHonoRecoveryAttestation(archive, expected, spawn = spawnSync) {
  const { archiveSha256, workflow, sourceSha, signerWorkflow, signerDigest } = expected ?? {};
  if (
    !matches(SHA256, archiveSha256) ||
    !matches(WORKFLOW, workflow) ||
    !matches(COMMIT, sourceSha) ||
    !matches(SIGNER, signerWorkflow) ||
    !matches(COMMIT, signerDigest)
  )
    throw refusal("invalid pins");
  if (
    !Buffer.isBuffer(archive) ||
    !archive.length ||
    archive.length > RECOVERY_MEMBER_LIMITS.maxArchiveBytes
  )
    throw refusal("archive size");
  const bytes = Buffer.from(archive);
  if (createHash("sha256").update(bytes).digest("hex") !== archiveSha256)
    throw refusal("pinned archive digest");

  let results;
  try {
    const version = runGh(spawn, ["--version"]);
    if (version.match(/^gh version (\S+) /)?.[1] !== GH_VERSION) throw refusal("CLI version");
    const directory = mkdtempSync(join(tmpdir(), "hono-recovery-attestation-"));
    try {
      const path = join(directory, "archive.zip");
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      const policy = [
        ["--hostname", "github.com"],
        ["--repo", REPOSITORY],
        ["--signer-workflow", signerWorkflow],
        ["--signer-digest", signerDigest],
        ["--source-ref", MAIN_REF],
        ["--source-digest", sourceSha],
        ["--cert-oidc-issuer", ISSUER],
        ["--predicate-type", PREDICATE],
        ["--digest-alg", "sha256"],
        ["--format", "json"],
      ];
      results = JSON.parse(runGh(spawn, ["attestation", "verify", path, ...policy.flat()]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    throw refusal("pinned verifier or its JSON output unavailable");
  }
  return normalize(results, { workflow, sourceSha, signerDigest, archiveSha256 });
}
