// Finite dry-run envelope and optional serialized-config checks, not upload verification.
import assert from "node:assert/strict";
import { verifyKitMultipartConfig } from "./kit-multipart-config.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const METADATA_HEADER = 'Content-Disposition: form-data; name="metadata"\r\n\r\n';
const WORKER_HEADER =
  'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n' +
  "Content-Type: application/javascript+module\r\n\r\n";
const BINDING_TYPES = new Set([
  "plain_text",
  "hyperdrive",
  "queue",
  "assets",
  "version_metadata",
  "inherit",
]);

function stripHeader(part, header) {
  const bytes = Buffer.from(header);
  assert.ok(part.subarray(0, bytes.length).equals(bytes), "unexpected multipart part header");
  return part.subarray(bytes.length);
}

export function verifyKitMultipartModules(multipart, expectedWorker, sourceConfig) {
  assert.ok(
    Buffer.isBuffer(multipart) && multipart.length > 0 && multipart.length <= 65 * 1024 * 1024,
    "invalid multipart size",
  );
  assert.ok(
    Buffer.isBuffer(expectedWorker) &&
      expectedWorker.length > 0 &&
      expectedWorker.length <= 64 * 1024 * 1024,
    "invalid expected Worker size",
  );
  const firstLine = multipart.indexOf("\r\n");
  assert.ok(firstLine >= 3 && firstLine <= 72, "invalid multipart boundary");
  const boundary = multipart.subarray(0, firstLine).toString("latin1");
  assert.ok(/^--[A-Za-z0-9-]{1,70}$/.test(boundary), "invalid multipart boundary");
  const separator = Buffer.from(`\r\n${boundary}\r\n`);
  const ending = Buffer.from(`\r\n${boundary}--`);
  const finalCrLf = multipart.subarray(-2).equals(Buffer.from("\r\n")) ? 2 : 0;
  const end = multipart.length - finalCrLf - ending.length;
  assert.ok(
    end > firstLine + 2 && multipart.subarray(end, end + ending.length).equals(ending),
    "invalid multipart ending",
  );
  const parts = multipart.subarray(firstLine + 2, end);
  const split = parts.indexOf(separator);
  assert.ok(
    split > 0 &&
      parts.indexOf(separator, split + separator.length) === -1 &&
      parts.indexOf(ending) === -1,
    "unexpected multipart part membership",
  );
  const metadataBytes = stripHeader(parts.subarray(0, split), METADATA_HEADER);
  const worker = stripHeader(parts.subarray(split + separator.length), WORKER_HEADER);
  assert.ok(worker.equals(expectedWorker), "multipart Worker bytes differ");
  assert.ok(
    metadataBytes.length > 0 && metadataBytes.length <= 256 * 1024,
    "invalid multipart metadata size",
  );
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
  } catch {
    // JSON parser errors can quote metadata values. Never propagate them.
    throw new Error("invalid multipart metadata encoding or JSON");
  }
  assert.ok(
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata),
    "invalid multipart metadata object",
  );
  assert.ok(metadata.main_module === "worker.js", "unexpected multipart main module");
  assert.ok(
    Array.isArray(metadata.bindings) && metadata.bindings.length <= 128,
    "invalid multipart bindings",
  );
  const names = new Set();
  const bindings = metadata.bindings.map((binding) => {
    assert.ok(
      binding !== null &&
        typeof binding === "object" &&
        !Array.isArray(binding) &&
        typeof binding.name === "string" &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(binding.name) &&
        !names.has(binding.name) &&
        BINDING_TYPES.has(binding.type),
      "unexpected multipart binding shape or type",
    );
    names.add(binding.name);
    return { name: binding.name, type: binding.type };
  });
  bindings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schema: "two.kit-multipart-modules.v1",
    evidence: "dry-run-module-envelope-only",
    worker: {
      name: "worker.js",
      mime: "application/javascript+module",
      bytes: worker.length,
      sha256: sha256(worker),
    },
    metadata: { bytes: metadataBytes.length, sha256: sha256(metadataBytes), bindings },
    ...(sourceConfig === undefined
      ? {}
      : { config: verifyKitMultipartConfig(metadata, sourceConfig) }),
  };
}
