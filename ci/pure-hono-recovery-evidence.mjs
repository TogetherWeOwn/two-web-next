import { createHash } from "node:crypto";
import {
  RECOVERY_MANIFEST,
  RECOVERY_MEMBER_LIMITS,
  RECOVERY_REQUIRED_FILES,
  recordRecoveryPath,
  validRecoveryMemberPath,
} from "./pure-hono-recovery-members.mjs";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const MAIN_REF = "refs/heads/main";
const TARGET = "two-web-next-production";
const SCHEMA = "two.pure-hono-recovery.v1";
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/;
const IDENTITY = ["sourceSha", "runId", "runAttempt", "originalVersionId"];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const same = (actual, expected, keys) => keys.every((key) => actual?.[key] === expected[key]);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(`pure Hono recovery evidence refused: ${reason}`);
}

function validateProvenance(expected, attestation, run, archiveSha256) {
  requireEvidence(
    matches(SHA, expected?.sourceSha) &&
      matches(POSITIVE_ID, expected?.runId) &&
      matches(POSITIVE_ID, expected?.runAttempt) &&
      matches(UUID, expected?.originalVersionId) &&
      matches(/^\.github\/workflows\/[a-z0-9_-]+\.ya?ml$/, expected?.workflow),
    "expected identity",
  );
  const producer = { ...expected, repository: REPOSITORY, ref: MAIN_REF };
  const producerKeys = ["repository", "ref", "workflow", "runId", "runAttempt", "sourceSha"];
  requireEvidence(
    same(run, producer, producerKeys) && run.status === "completed" && run.conclusion === "success",
    "successful main run",
  );
  requireEvidence(
    same(attestation, producer, producerKeys) && attestation.subjectSha256 === archiveSha256,
    "verified attestation identity or subject digest",
  );
}

function inspectMembers(members) {
  requireEvidence(
    Array.isArray(members) && members.length <= RECOVERY_MEMBER_LIMITS.maxEntries,
    "member count",
  );
  const files = new Map();
  const paths = new Map();
  let expanded = 0;
  for (const { path, bytes, type } of members) {
    requireEvidence(validRecoveryMemberPath(path), "member path");
    requireEvidence(
      type === "file" && Buffer.isBuffer(bytes) && !files.has(path),
      "member type or duplicate",
    );
    expanded += bytes.length;
    requireEvidence(expanded <= RECOVERY_MEMBER_LIMITS.maxTotalBytes, "expanded size");
    requireEvidence(recordRecoveryPath(paths, path), "alias");
    files.set(path, bytes);
  }
  return files;
}

// All three adapters are caller-owned trust boundaries: authenticated run lookup
// (normalize GitHub's head_sha to run.sourceSha), Sigstore verification with
// pinned signer policy, and bounded data-only decoding
// of these exact archive bytes. The decoder must account for every archive entry
// without extracting it. Never build either provenance input from members.
// This checks evidence consistency only; it cannot qualify custody or recovery.
export function validatePureHonoRecoveryEvidence({ archive, expected, attestation, run, decode }) {
  requireEvidence(
    Buffer.isBuffer(archive) &&
      archive.length > 0 &&
      archive.length <= RECOVERY_MEMBER_LIMITS.maxArchiveBytes,
    "archive size",
  );
  const archiveSha256 = digest(archive);
  requireEvidence(archiveSha256 === expected?.archiveSha256, "pinned archive digest");
  validateProvenance(expected, attestation, run, archiveSha256);

  let files;
  let manifest;
  try {
    files = inspectMembers(decode(Buffer.from(archive)));
    const raw = files.get(RECOVERY_MANIFEST);
    requireEvidence(
      raw?.length > 0 && raw.length <= RECOVERY_MEMBER_LIMITS.maxManifestBytes,
      "manifest size",
    );
    manifest = JSON.parse(raw.toString("utf8"));
    // One exact wire encoding rejects duplicate JSON keys and lossy UTF-8 decoding.
    requireEvidence(raw.equals(Buffer.from(JSON.stringify(manifest))), "manifest encoding");
  } catch {
    throw new Error("pure Hono recovery evidence refused: archive members or manifest encoding");
  }
  files.delete(RECOVERY_MANIFEST);
  requireEvidence(
    exactKeys(manifest, ["schema", "target", ...IDENTITY, "files"]) &&
      manifest.schema === SCHEMA &&
      manifest.target === TARGET &&
      same(manifest, expected, IDENTITY),
    "manifest identity",
  );
  const seen = new Set();
  requireEvidence(
    Array.isArray(manifest.files) && manifest.files.length === files.size,
    "file set",
  );
  for (const row of manifest.files) {
    requireEvidence(exactKeys(row, ["path", "bytes", "sha256"]), "file record");
    const bytes = files.get(row.path);
    requireEvidence(bytes && !seen.has(row.path), "file set");
    requireEvidence(bytes.length === row.bytes && digest(bytes) === row.sha256, "file digest");
    seen.add(row.path);
  }
  requireEvidence(
    RECOVERY_REQUIRED_FILES.every((path) => files.get(path)?.length > 0),
    "worker or config missing",
  );
  requireEvidence(
    [...seen].some((path) => path.startsWith("assets/")),
    "assets missing",
  );
  return { archiveSha256, fileCount: files.size };
}
