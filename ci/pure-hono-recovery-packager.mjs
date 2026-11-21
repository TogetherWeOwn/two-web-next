import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import {
  RECOVERY_SCHEMA,
  RECOVERY_TARGET,
  matchesSuccessfulMainRecoveryRun,
  validRecoveryIdentity,
} from "./pure-hono-recovery-evidence.mjs";
import {
  RECOVERY_MANIFEST,
  RECOVERY_MEMBER_LIMITS,
  RECOVERY_REQUIRED_FILES,
  recordRecoveryPath,
  validRecoveryZipPath,
} from "./pure-hono-recovery-members.mjs";

const { maxArchiveBytes, maxTotalBytes, maxEntries, maxManifestBytes, maxRatio } =
  RECOVERY_MEMBER_LIMITS;
const LOCAL = 30;
const CENTRAL = 46;
const END = 22;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refusal = (reason) => new Error(`pure Hono recovery packaging refused: ${reason}`);

function encoding(bytes, remaining) {
  // Only try DEFLATE if it can improve on STORE and fit in the remaining budget.
  const maxOutputLength = Math.min(remaining, bytes.length - 1);
  if (maxOutputLength > 0) {
    try {
      const deflated = deflateRawSync(bytes, { level: 6, maxOutputLength });
      if (bytes.length / deflated.length <= maxRatio) return { data: deflated, method: 8 };
    } catch (error) {
      if (error?.code !== "ERR_BUFFER_TOO_LARGE") throw refusal("compression failed");
    }
  }
  if (bytes.length > remaining) throw refusal("archive size");
  return { data: bytes, method: 0 };
}

// One disk, classic ZIP, fixed Unix regular-file mode and DOS epoch. No optional fields.
function encodeZip(entries) {
  let remaining = maxArchiveBytes - END;
  for (const { path } of entries) remaining -= LOCAL + CENTRAL + 2 * path.length;
  if (remaining < 0) throw refusal("archive size");

  const locals = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const { path, bytes } of entries) {
    const { data, method } = encoding(bytes, remaining);
    remaining -= data.length;
    const local = Buffer.alloc(LOCAL + path.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, 00:00:00
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.write(path, LOCAL, "ascii");
    const central = Buffer.alloc(CENTRAL + path.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix creator, ZIP 2.0
    local.copy(central, 6, 4, LOCAL); // common metadata: version through extra length
    central.writeUInt32LE(0o100644 * 65536, 38);
    central.writeUInt32LE(offset, 42);
    local.copy(central, CENTRAL, LOCAL); // identical name bytes
    locals.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
    directorySize += central.length;
  }

  const end = Buffer.alloc(END);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

// Inputs are already supplied by the caller. This packages assertions; it does not
// authenticate the run, choose a source, inspect config, or qualify recovery.
export function packPureHonoRecovery({
  worker,
  effectiveConfig,
  assets,
  sourceSha,
  originalVersionId,
  run,
}) {
  const { runId, runAttempt, workflow } = run ?? {};
  const identity = { sourceSha, runId, runAttempt, originalVersionId };
  const expected = { ...identity, workflow };
  if (
    !validRecoveryIdentity(expected) ||
    !Number.isSafeInteger(Number(runId)) ||
    !Number.isSafeInteger(Number(runAttempt)) ||
    !matchesSuccessfulMainRecoveryRun(run, expected)
  )
    throw refusal("successful main producer identity");

  if (
    !Buffer.isBuffer(worker) ||
    !worker.length ||
    !Buffer.isBuffer(effectiveConfig) ||
    !effectiveConfig.length
  )
    throw refusal("worker or config missing");
  if (!Array.isArray(assets) || !assets.length) throw refusal("assets missing");
  if (assets.length + RECOVERY_REQUIRED_FILES.length + 1 > maxEntries)
    throw refusal("member count");

  const [workerPath, configPath] = RECOVERY_REQUIRED_FILES;
  const entries = [
    { path: workerPath, bytes: worker },
    { path: configPath, bytes: effectiveConfig },
  ];
  const names = new Set();
  const aliases = new Map();
  let expanded = worker.length + effectiveConfig.length;
  for (const asset of assets) {
    const { path, bytes } = asset ?? {};
    if (!validRecoveryZipPath(path) || !path.startsWith("assets/")) throw refusal("asset path");
    if (!Buffer.isBuffer(bytes)) throw refusal("asset bytes");
    if (names.has(path) || !recordRecoveryPath(aliases, path))
      throw refusal("duplicate or aliased path");
    names.add(path);
    expanded += bytes.length;
    entries.push({ path, bytes });
  }
  if (expanded > maxTotalBytes) throw refusal("expanded size");

  entries.sort((a, b) => (a.path < b.path ? -1 : 1)); // ASCII code-unit order, not locale order
  // Snapshot once, so the manifest hashes and ZIP encoding use the same bytes.
  const files = entries.map((entry) => {
    entry.bytes = Buffer.from(entry.bytes);
    return { path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes) };
  });
  const manifest = Buffer.from(
    JSON.stringify({ schema: RECOVERY_SCHEMA, target: RECOVERY_TARGET, ...identity, files }),
  );
  if (manifest.length > maxManifestBytes) throw refusal("manifest size");
  if (expanded + manifest.length > maxTotalBytes) throw refusal("expanded size");
  const archive = encodeZip([...entries, { path: RECOVERY_MANIFEST, bytes: manifest }]);
  return { archive, archiveSha256: sha256(archive) };
}
