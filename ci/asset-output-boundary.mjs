// Validate the output of Git's NUL-delimited porcelain and raw diff commands.
// This module is inert: callers own the Git invocation and patch collection.
function fields(text) {
  if (typeof text !== "string" || (text && !text.endsWith("\0"))) {
    throw new Error("malformed NUL-delimited Git output");
  }
  return text ? text.slice(0, -1).split("\0") : [];
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("public/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !path.includes("\\") &&
    !path.includes("\0")
  );
}

function allowedSet(allowed) {
  if (!Array.isArray(allowed) || allowed.some((path) => !validPath(path))) {
    throw new Error("invalid allowed output list");
  }
  return new Set(allowed);
}

// `git status --porcelain=v1 -z --untracked-files=all`; rename/copy records
// have the destination first and a second NUL-delimited source path.
export function parseStatus(text) {
  const parts = fields(text);
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record.length < 4 || record[2] !== " " || !record.slice(3)) {
      throw new Error("malformed porcelain record");
    }
    const xy = record.slice(0, 2);
    if (!/^(?:[ MADRCU?!]{2})$/.test(xy) || xy === "  ") {
      throw new Error("malformed porcelain status");
    }
    const entry = { xy, path: record.slice(3) };
    if (/[RC]/.test(xy)) {
      entry.from = parts[++i];
      if (!entry.from) throw new Error("missing porcelain rename source");
    }
    entries.push(entry);
  }
  return entries;
}

export function classifyStatus(entries, allowed) {
  const ok = allowedSet(allowed);
  const files = [];
  const unexpected = [];
  const seen = new Set();
  for (const entry of entries) {
    const { xy, path, from } = entry;
    if (ok.has(path) && !seen.has(path) && from === undefined && (xy === " M" || xy === "??")) {
      files.push(path);
    } else {
      unexpected.push(`${xy} ${path}`);
    }
    seen.add(path);
  }
  return { files: files.sort(), unexpected };
}

// `git diff --raw -z --no-renames --full-index` emits metadata and path
// as separate fields. Only ordinary 0644 files may be added or modified.
export function validateRaw(raw, allowed) {
  const ok = allowedSet(allowed);
  const parts = fields(raw);
  const problems = [];
  const seen = new Set();
  if (parts.length % 2) return ["malformed raw diff"];
  for (let i = 0; i < parts.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{4,64}) ([0-9a-f]{4,64}) ([A-Z])$/.exec(
      parts[i],
    );
    const path = parts[i + 1];
    if (!match || !path) {
      problems.push("malformed raw diff record");
      continue;
    }
    const [, oldMode, newMode, oldHash, newHash, status] = match;
    if (oldHash.length !== newHash.length) problems.push(`inconsistent hash lengths: ${path}`);
    if (!ok.has(path) || seen.has(path)) problems.push(`path not allowed or duplicated: ${path}`);
    if (status !== "M" && status !== "A") problems.push(`status ${status} not allowed: ${path}`);
    if (
      newMode !== "100644" ||
      (status === "M" && oldMode !== "100644") ||
      (status === "A" && oldMode !== "000000")
    ) {
      problems.push(`mode change or non-regular file: ${path}`);
    }
    seen.add(path);
  }
  return problems;
}
