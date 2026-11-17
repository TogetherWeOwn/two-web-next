import { crc32, inflateRawSync } from "node:zlib";

// Inert, in-memory reader for an untrusted artifact ZIP. It never writes to the
// filesystem, never executes or imports content, and returns entry bytes as data
// only. It is not artifact download, digest verification or evidence admission;
// the caller must verify the immutable artifact ID and digest first.
export const ROUTE_EVIDENCE_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024,
  maxEntries: 32,
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxRatio: 100,
});

const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// Returns Map<name, Buffer>. Throws one generic error so no archive-controlled
// text reaches logs. Only flat, allowlisted names, stored or deflate entries.
export function extractRouteEvidenceZip(archive, limits = ROUTE_EVIDENCE_ZIP_LIMITS) {
  try {
    return parse(archive, limits);
  } catch {
    throw new Error("route evidence refused: unsafe artifact archive");
  }
}

function parse(buf, limits) {
  const need = (ok) => {
    if (!ok) throw new Error("refused");
  };
  need(Buffer.isBuffer(buf) || buf instanceof Uint8Array);
  buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  need(buf.length >= 22 && buf.length <= limits.maxArchiveBytes);
  const eocd = buf.length - 22;
  need(buf.readUInt32LE(eocd) === SIG_EOCD);
  need(buf.readUInt16LE(eocd + 20) === 0); // no archive comment, so EOCD is last
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  need(buf.readUInt16LE(eocd + 4) === 0 && buf.readUInt16LE(eocd + 6) === 0);
  need(buf.readUInt16LE(eocd + 8) === count);
  // Zip64 sentinels and multi-disk archives are refused, not interpreted.
  need(count !== 0xffff && cdSize !== 0xffffffff && cdOffset !== 0xffffffff);
  need(count > 0 && count <= limits.maxEntries);
  need(cdOffset + cdSize === eocd);

  const seen = new Set();
  const ranges = [];
  const files = new Map();
  let total = 0;
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    need(pos + 46 <= eocd && buf.readUInt32LE(pos) === SIG_CD);
    const madeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const disk = buf.readUInt16LE(pos + 34);
    const attrs = buf.readUInt32LE(pos + 38);
    const local = buf.readUInt32LE(pos + 42);
    need(pos + 46 + nameLen + extraLen + commentLen <= eocd);
    const raw = buf.subarray(pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    // Refuse encryption, strong encryption, patched data and compressed patches.
    need((flags & 0x2061) === 0);
    need(method === 0 || method === 8);
    need(disk === 0 && csize !== 0xffffffff && usize !== 0xffffffff);
    // Refuse symlinks, devices, directories and other non-regular entries.
    if (madeBy >> 8 === 3) need(((attrs >>> 16) & 0o170000) === 0o100000);
    need((attrs & 0x10) === 0);
    need(!raw.includes(0x2f) && !raw.includes(0x5c)); // no separators at all
    const name = raw.toString("latin1");
    need(ENTRY_NAME.test(name) && !name.startsWith("."));
    need(!seen.has(name.toLowerCase()));
    seen.add(name.toLowerCase());
    need(usize <= limits.maxEntryBytes);
    total += usize;
    need(total <= limits.maxTotalBytes);
    need(csize === 0 ? usize === 0 : usize / csize <= limits.maxRatio);
    need(method !== 0 || csize === usize);

    // The local header must agree with the central directory.
    need(local + 30 <= cdOffset && buf.readUInt32LE(local) === SIG_LOCAL);
    need(buf.readUInt16LE(local + 6) === flags);
    need(buf.readUInt16LE(local + 8) === method);
    if ((flags & 8) === 0) {
      need(buf.readUInt32LE(local + 14) === crc);
      need(buf.readUInt32LE(local + 18) === csize && buf.readUInt32LE(local + 22) === usize);
    }
    const lNameLen = buf.readUInt16LE(local + 26);
    const start = local + 30 + lNameLen + buf.readUInt16LE(local + 28);
    need(lNameLen === nameLen && buf.subarray(local + 30, local + 30 + nameLen).equals(raw));
    need(start + csize <= cdOffset);
    let end = start + csize;
    if (flags & 8) {
      // A descriptor may carry the optional signature, but must match the directory.
      if (end + 4 <= cdOffset && buf.readUInt32LE(end) === 0x08074b50) end += 4;
      need(end + 12 <= cdOffset);
      need(
        buf.readUInt32LE(end) === crc &&
          buf.readUInt32LE(end + 4) === csize &&
          buf.readUInt32LE(end + 8) === usize,
      );
      end += 12;
    }
    ranges.push([local, end]);

    const stored = buf.subarray(start, start + csize);
    let data;
    if (method === 0) {
      data = Buffer.from(stored);
    } else {
      const result = inflateRawSync(stored, { maxOutputLength: Math.max(1, usize), info: true });
      need(result.engine.bytesWritten === stored.length);
      data = result.buffer;
    }
    need(data.length === usize && crc32(data) === crc);
    files.set(name, data);
  }
  need(pos === eocd);
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) need(ranges[i - 1][1] <= ranges[i][0]);
  return files;
}
