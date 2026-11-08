// Shared authenticated transport. Callers validate producer metadata and contents;
// this module never extracts, executes or persists downloaded bytes.
import assert from "node:assert/strict";
import { sha256 } from "./worker-bundle-evidence.mjs";

const API = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

async function boundedBody(response, limit) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    assert.match(declared, /^[0-9]+$/);
    assert.ok(Number(declared) <= limit);
  }
  assert.ok(response.body, "missing response body");
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= limit, "response too large");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    // A bounded read must also stop the underlying transfer on a size breach.
    if (!response.body.locked) await response.body.cancel();
    throw error;
  }
  // Fetch decompresses bodies but preserves the transport's content-length.
  const encoding = response.headers.get("content-encoding");
  if (declared !== null && (!encoding || encoding === "identity"))
    assert.equal(bytes, Number(declared));
  return Buffer.concat(chunks, bytes);
}

function signedArchiveUrl(location) {
  const url = new URL(location);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.port, "");
  assert.equal(url.hash, "");
  assert.ok(
    /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.hostname === "results-receiver.actions.githubusercontent.com",
    "unsupported archive host",
  );
  return url.href;
}

export async function readGitHubArtifactArchive(
  identity,
  { artifactId, token, verifyMetadata, fetchImpl = fetch },
) {
  try {
    assert.match(artifactId, /^[1-9][0-9]{0,19}$/);
    assert.match(identity?.runId, /^[1-9][0-9]{0,19}$/);
    assert.match(identity?.runAttempt, /^[1-9][0-9]{0,19}$/);
    assert.match(identity?.sourceSha, /^[0-9a-f]{40}$/);
    assert.equal(typeof verifyMetadata, "function");
    assert.ok(typeof token === "string" && token.length > 0 && token.length <= 16 * 1024);
    assert.ok(!/[\r\n]/.test(token));
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    async function metadata(path) {
      const response = await fetchImpl(`${API}${path}`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      return JSON.parse((await boundedBody(response, MAX_METADATA_BYTES)).toString("utf8"));
    }
    const run = await metadata(`/actions/runs/${identity.runId}`);
    const artifact = await metadata(`/actions/artifacts/${artifactId}`);
    assert.equal(String(artifact?.id), artifactId);
    const provenance = await verifyMetadata(identity, run, artifact);
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0);
    assert.ok(artifact.size_in_bytes <= MAX_ARCHIVE_BYTES);
    assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/);
    const redirect = await fetchImpl(`${API}/actions/artifacts/${artifactId}/zip`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(redirect.status, 302);
    const location = signedArchiveUrl(redirect.headers.get("location"));
    // Signed storage is a different origin: no bearer token or further redirect.
    const response = await fetchImpl(location, {
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.status, 200);
    const archive = await boundedBody(response, MAX_ARCHIVE_BYTES);
    assert.equal(archive.length, artifact.size_in_bytes);
    const archiveSha256 = sha256(archive);
    assert.equal(`sha256:${archiveSha256}`, artifact.digest);
    return { archive, provenance, archiveSha256, archiveBytes: archive.length };
  } catch {
    throw new Error("GitHub artifact archive read failed");
  }
}
