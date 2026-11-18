import { createHash } from "node:crypto";
import {
  extractRouteEvidenceZip,
  ROUTE_EVIDENCE_ZIP_LIMITS,
} from "./route-evidence-artifact-zip.mjs";

// The caller must authenticate the artifact ID and digest independently before
// passing a successful GitHub download response. A matching digest alone does
// not bind the archive to a producer, run, or attempt.
export async function readRouteEvidenceArtifact(response, expectedDigest) {
  const refuse = () => {
    throw new Error("route evidence refused: invalid artifact download");
  };
  if (
    !response?.ok ||
    !response.body ||
    typeof response.body[Symbol.asyncIterator] !== "function" ||
    typeof expectedDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)
  )
    refuse();

  // A byte limit alone does not bound per-chunk object overhead: a hostile
  // stream could otherwise deliver millions of one-byte chunks.
  const archive = Buffer.allocUnsafe(ROUTE_EVIDENCE_ZIP_LIMITS.maxArchiveBytes);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      // Empty chunks make no progress toward the byte cap and could be endless.
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) refuse();
      if (chunk.byteLength > archive.length - size) refuse();
      archive.set(chunk, size);
      hash.update(chunk);
      size += chunk.byteLength;
    }
  } catch {
    refuse();
  }
  if (size === 0 || `sha256:${hash.digest("hex")}` !== expectedDigest) refuse();
  return extractRouteEvidenceZip(archive.subarray(0, size));
}
