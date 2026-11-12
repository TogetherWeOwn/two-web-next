import { classifyStatus, validateRaw } from "./asset-output-boundary.mjs";

// Callers supply trusted, complete snapshots; this function does not acquire or
// authenticate them, inspect a checkout, or produce a patch.
const MAX_RECORDS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MODES = new Set(["100644", "100755", "120000", "160000"]);
const HASH = "0".repeat(40);

function snapshot(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new Error("invalid snapshot record count");
  }
  const result = new Map();
  let total = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("malformed snapshot record");
    }
    const { path, mode, bytes } = record;
    if (
      typeof path !== "string" ||
      !path ||
      !path.isWellFormed() ||
      Buffer.byteLength(path) > MAX_PATH_BYTES ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !MODES.has(mode) ||
      !Buffer.isBuffer(bytes) ||
      result.has(path)
    ) {
      throw new Error("malformed or duplicate snapshot record");
    }
    total += Buffer.byteLength(path) + bytes.length;
    if (total > MAX_BYTES) throw new Error("snapshot exceeds byte limit");
    result.set(path, record);
  }
  return result;
}

export function compareAssetSnapshots({ before, after, allowed }) {
  classifyStatus([], allowed);
  const oldFiles = snapshot(before);
  const newFiles = snapshot(after);
  const changes = [];
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (
      oldFile &&
      newFile &&
      oldFile.mode === newFile.mode &&
      oldFile.bytes.equals(newFile.bytes)
    ) {
      continue;
    }
    const status = !oldFile ? "A" : !newFile ? "D" : "M";
    const raw = `:${oldFile?.mode ?? "000000"} ${newFile?.mode ?? "000000"} ${HASH} ${HASH} ${status}\0${path}\0`;
    const problems = validateRaw(raw, allowed);
    if (problems.length) throw new Error(`unsafe snapshot change: ${problems.join(", ")}`);
    changes.push({ path, status });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
