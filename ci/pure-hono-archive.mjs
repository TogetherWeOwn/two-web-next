// Authenticated transport only. A verified zip is not an extracted/verified
// rollback record, native version readback or permanent retention capability.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readGitHubArtifactArchive } from "./github-artifact-archive.mjs";
import { verifyPureHonoProvenance } from "./pure-hono-rollback.mjs";

export async function downloadPureHonoArchive(
  pointer,
  { artifactId, token, destination, fetchImpl = fetch },
) {
  try {
    assert.ok(typeof destination === "string" && destination.length > 0);
    const { archive, ...verified } = await readGitHubArtifactArchive(pointer, {
      artifactId,
      token,
      fetchImpl,
      verifyMetadata: verifyPureHonoProvenance,
    });
    // Callers select a new, empty run-owned directory outside the source tree.
    // Never replace, extract or execute an existing archive.
    writeFileSync(destination, archive, { flag: "wx", mode: 0o600 });
    return verified;
  } catch {
    throw new Error("pure-Hono archive download failed");
  }
}
