// Decode a deliberately narrow ZIP profile into memory only. No filesystem,
// interpreter, module loader or archive-supplied tool/config is involved.
import { crc32, inflateRawSync } from "node:zlib";
import { candidateSha256, safeBundlePath } from "./candidate-staging-admission.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;

function requireEvidence(condition, code) {
  if (!condition) throw new Error(`Candidate archive refused: ${code}`);
}

function extras(bytes) {
  let offset = 0;
  const ids = new Set();
  while (offset < bytes.length) {
    requireEvidence(offset + 4 <= bytes.length, "extra-header");
    const id = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    // Timestamp and UID/GID metadata do not affect names or file contents.
    // In particular ZIP64, Unicode alternate names and encryption refuse.
    requireEvidence([0x5455, 0x7875].includes(id) && !ids.has(id), "extra-type");
    ids.add(id);
    offset += 4 + length;
    requireEvidence(offset <= bytes.length, "extra-length");
  }
}

function decodeArchive(archive, expectedSha256, allowedPath, requiredPath) {
  requireEvidence(
    Buffer.isBuffer(archive) &&
      archive.length >= 22 &&
      archive.length <= MAX_BYTES &&
      typeof expectedSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(expectedSha256) &&
      candidateSha256(archive) === expectedSha256,
    "archive-digest-or-size",
  );
  // No comments, multipart archives, ZIP64, prefixes or suffixes. A producer
  // must emit this profile; unsupported ZIP features fail instead of guessing.
  const end = archive.length - 22;
  requireEvidence(archive.readUInt32LE(end) === 0x06054b50, "end-record");
  const count = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  requireEvidence(
    archive.readUInt16LE(end + 4) === 0 &&
      archive.readUInt16LE(end + 6) === 0 &&
      archive.readUInt16LE(end + 8) === count &&
      archive.readUInt16LE(end + 20) === 0 &&
      count > 0 &&
      count <= MAX_FILES &&
      centralOffset + centralSize === end,
    "archive-layout",
  );
  const entries = [];
  const paths = new Set();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    requireEvidence(
      offset + 46 <= end && archive.readUInt32LE(offset) === 0x02014b50,
      "central-header",
    );
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameSize = archive.readUInt16LE(offset + 28);
    const extraSize = archive.readUInt16LE(offset + 30);
    const commentSize = archive.readUInt16LE(offset + 32);
    const attributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    requireEvidence(
      archive.readUInt16LE(offset + 6) <= 20 &&
        (flags & ~0x0808) === 0 &&
        [0, 8].includes(method) &&
        archive.readUInt16LE(offset + 34) === 0 &&
        commentSize === 0 &&
        nameSize > 0 &&
        nameSize <= 240 &&
        next <= end &&
        compressedSize <= MAX_BYTES &&
        size <= MAX_BYTES &&
        (attributes & 0x10) === 0 &&
        [0, 0x8000].includes((attributes >>> 16) & 0xf000),
      "central-entry",
    );
    const name = archive.subarray(offset + 46, offset + 46 + nameSize);
    // ASCII-only paths avoid UTF-8, legacy codepage and Unicode alias ambiguity.
    requireEvidence(
      name.every((byte) => byte < 128),
      "entry-name-encoding",
    );
    const path = name.toString("ascii");
    requireEvidence(allowedPath(path) && !paths.has(path.toLowerCase()), "entry-path");
    paths.add(path.toLowerCase());
    total += size;
    requireEvidence(total <= MAX_BYTES, "expanded-size");
    extras(archive.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
    entries.push({
      path,
      name,
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      time: archive.readUInt16LE(offset + 12),
      date: archive.readUInt16LE(offset + 14),
    });
    offset = next;
  }
  requireEvidence(offset === end && paths.has(requiredPath), "central-completeness");
  entries.sort((left, right) => left.localOffset - right.localOffset);
  const files = [];
  let cursor = 0;
  for (const entry of entries) {
    const local = entry.localOffset;
    requireEvidence(
      local === cursor && local + 30 <= centralOffset && archive.readUInt32LE(local) === 0x04034b50,
      "local-layout",
    );
    const nameSize = archive.readUInt16LE(local + 26);
    const extraSize = archive.readUInt16LE(local + 28);
    const dataOffset = local + 30 + nameSize + extraSize;
    requireEvidence(
      archive.readUInt16LE(local + 4) <= 20 &&
        archive.readUInt16LE(local + 6) === entry.flags &&
        archive.readUInt16LE(local + 8) === entry.method &&
        archive.readUInt16LE(local + 10) === entry.time &&
        archive.readUInt16LE(local + 12) === entry.date &&
        nameSize === entry.name.length &&
        dataOffset + entry.compressedSize <= centralOffset &&
        archive.subarray(local + 30, local + 30 + nameSize).equals(entry.name),
      "local-entry",
    );
    extras(archive.subarray(local + 30 + nameSize, dataOffset));
    const descriptor = (entry.flags & 8) !== 0;
    const expected = descriptor ? [0, 0, 0] : [entry.crc, entry.compressedSize, entry.size];
    requireEvidence(
      archive.readUInt32LE(local + 14) === expected[0] &&
        archive.readUInt32LE(local + 18) === expected[1] &&
        archive.readUInt32LE(local + 22) === expected[2],
      "local-sizes",
    );
    cursor = dataOffset + entry.compressedSize;
    if (descriptor) {
      requireEvidence(
        cursor + 16 <= centralOffset && archive.readUInt32LE(cursor) === 0x08074b50,
        "descriptor-header",
      );
      requireEvidence(
        archive.readUInt32LE(cursor + 4) === entry.crc &&
          archive.readUInt32LE(cursor + 8) === entry.compressedSize &&
          archive.readUInt32LE(cursor + 12) === entry.size,
        "descriptor-sizes",
      );
      cursor += 16;
    }
    const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
    let bytes;
    if (entry.method === 0) {
      requireEvidence(entry.compressedSize === entry.size, "stored-size");
      bytes = Buffer.from(compressed);
    } else {
      try {
        const result = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, entry.size),
          info: true,
        });
        requireEvidence(result.engine.bytesWritten === compressed.length, "deflate-trailing-bytes");
        bytes = result.buffer;
      } catch {
        throw new Error("Candidate archive refused: deflate-data");
      }
    }
    requireEvidence(bytes.length === entry.size && crc32(bytes) === entry.crc, "entry-integrity");
    files.push({ path: entry.path, type: "file", bytes });
  }
  requireEvidence(cursor === centralOffset, "local-completeness");
  return files;
}

export function decodeCandidateArchive(archive, expectedSha256) {
  return decodeArchive(archive, expectedSha256, safeBundlePath, "worker/worker.mjs");
}

// Fixed retention profiles, not caller-defined paths or a filesystem extractor.
export function decodeBaselineArchive(archive, expectedSha256, channel) {
  requireEvidence(["payload", "producer"].includes(channel), "baseline-channel");
  const required = channel === "payload" ? "baseline.json" : "producer.json";
  return decodeArchive(
    archive,
    expectedSha256,
    (path) => path === required || (channel === "payload" && /^file-[0-9]{4}$/.test(path)),
    required,
  );
}
