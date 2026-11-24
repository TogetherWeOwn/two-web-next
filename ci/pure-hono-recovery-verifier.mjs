import { verifyPureHonoRecoveryAttestation } from "./pure-hono-recovery-attestation.mjs";
import { validatePureHonoRecoveryEvidence } from "./pure-hono-recovery-evidence.mjs";
import { RECOVERY_MEMBER_LIMITS } from "./pure-hono-recovery-members.mjs";
import { fetchPureHonoRecoveryRun } from "./pure-hono-recovery-run.mjs";
import { decodePureHonoRecoveryZip } from "./route-evidence-artifact-zip.mjs";

// Supply trusted adapters' I/O explicitly: no ambient fetch or gh process fallback.
// Pins are independent of the archive, including the producer SHA (not a promotion SHA).
export async function verifyPureHonoRecoveryEvidence({
  archive,
  expected,
  token,
  fetchImpl,
  spawn,
}) {
  if (
    !Buffer.isBuffer(archive) ||
    !archive.length ||
    archive.length > RECOVERY_MEMBER_LIMITS.maxArchiveBytes
  )
    throw new Error("pure Hono recovery evidence refused: archive size");
  if (typeof fetchImpl !== "function" || typeof spawn !== "function")
    throw new Error("pure Hono recovery evidence refused: missing verifier I/O");

  const bytes = Buffer.from(archive);
  const {
    archiveSha256,
    workflow,
    sourceSha,
    event,
    runId,
    runAttempt,
    signerWorkflow,
    signerDigest,
    originalVersionId,
  } = expected ?? {};
  const producer = { workflow, sourceSha, event, runId, runAttempt };
  const run = await fetchPureHonoRecoveryRun(producer, token, fetchImpl);
  const attestation = verifyPureHonoRecoveryAttestation(
    bytes,
    { ...producer, archiveSha256, signerWorkflow, signerDigest },
    spawn,
  );
  return validatePureHonoRecoveryEvidence({
    archive: bytes,
    expected: { ...producer, archiveSha256, originalVersionId },
    attestation, // Preserve the verified invocation; validate it against the independent attempt.
    run,
    decode: decodePureHonoRecoveryZip,
  });
}
