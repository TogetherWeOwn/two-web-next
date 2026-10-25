#!/usr/bin/env node
// Shared filesystem trust primitives for visual baseline acceptors. Used by
// ci/visual-accept.mjs (Hono) and ci/kit-visual-accept.mjs (Kit) during
// planning. The CLI surface (flags, dry-run, versioned JSON, stable codes,
// next actions) lives in ci/visual-accept-cli.mjs; plan composition
// (resolve, preflight, apply) lives in ci/visual-accept.mjs.
//
// Trust boundary: the extracted artifact directory is untrusted input (it may
// contain foreign suites, lookalike names, symlinks, cycles, hostile filenames,
// deep trees, or many entries). The destination checkout is trusted but must not
// be escaped via symlinked files, roots, or ancestors. All planning is
// preflighted before any mkdir or write; any boundary failure leaves all
// destination and outside bytes unchanged.
//
// Errors: symlink and traversal-budget violations throw BoundaryError with a
// fixed code and a bounded safe relative path. Ordinary filesystem read
// failures propagate raw so the CLI reports them as IO_ERROR with an errno and
// never echoes a path or message.
//
// Concurrency limit (honest): cached source bytes are read once during
// preflight and reused at apply, but this does not claim safety against a
// concurrent hostile filesystem writer. Apply-time disk errors are not rolled
// back. Callers must not run acceptors concurrently against the same roots
// with an untrusted writer.
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Shared finite traversal budget. Refuse plans that exceed either bound, even
// when a valid candidate exists. Do not filter by suite before enforcing: every
// visited entry counts.
export const MAX_DEPTH = 64;
export const MAX_ENTRIES = 4096;

// Bounded diagnostics. Reports never exceed this many bytes and never disclose
// absolute roots, traversal segments, control characters, raw filesystem
// errors, or source bytes.
export const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
export const MAX_PATH_LEN = 256;

export const CODE_SOURCE_SYMLINK = "SOURCE_SYMLINK";
export const CODE_DESTINATION_SYMLINK = "DESTINATION_SYMLINK";
export const CODE_ARTIFACT_LIMIT = "ARTIFACT_LIMIT";

export class BoundaryError extends Error {
  constructor(code, path, message) {
    super(message ?? code);
    this.name = "BoundaryError";
    this.code = code;
    this.path = path ?? ".";
  }
}

// Replace ASCII control characters and DEL with "_" so JSON and human output
// never carry raw control bytes. Hostile filenames stay identifiable without
// injecting terminal escapes or newlines.
export function sanitizeVisible(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, "_");
}
// Make one path segment safe: no slashes, no traversal, no control, bounded.
// Empty and "." become "_" except for the explicit root marker "." handled by
// callers.
function safeSegment(segment) {
  let out = sanitizeVisible(segment).replace(/[\\/]/g, "_");
  if (out === "" || out === "." || out === "..") out = "_";
  if (out.length > MAX_PATH_LEN) out = out.slice(0, MAX_PATH_LEN);
  return out;
}

// Convert an absolute path inside a root to a bounded safe relative diagnostic.
// Returns "." for the root itself, for outside paths, and for root-level errors
// so callers never leak absolute locations or ".." segments.
export function safeRelativePath(rootAbs, targetAbs) {
  try {
    const rel = relative(rootAbs, targetAbs);
    if (rel === "" || rel === ".") return ".";
    const parts = rel.split(sep);
    if (parts.some((part) => part === "..")) return ".";
    const cleaned = parts
      .map(safeSegment)
      .filter((part) => part !== "_")
      .join("/");
    if (!cleaned) return ".";
    const out = cleaned.length > MAX_PATH_LEN ? cleaned.slice(0, MAX_PATH_LEN) : cleaned;
    return out || ".";
  } catch {
    return ".";
  }
}

// Safe diagnostic for a destination filename (single basename, no directories).
export function safeDestName(dest) {
  const base = sanitizeVisible(basename(String(dest))).replace(/[\\/]/g, "_");
  if (base === "" || base === "." || base === "..") return "_";
  return base.length > MAX_PATH_LEN ? base.slice(0, MAX_PATH_LEN) : base;
}

export function truncateUtf8(value, maxBytes) {
  const str = String(value);
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let out = str.slice(0, maxBytes);
  while (out && Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

export function boundedDiagnostic(value) {
  return truncateUtf8(sanitizeVisible(value), MAX_DIAGNOSTIC_BYTES);
}

export function assertRegularFile(stat) {
  if (!stat.isFile()) {
    const error = new Error("Expected a regular file.");
    error.code = "EINVAL";
    throw error;
  }
}

// lstat every ancestor prefix of an absolute path, refusing symlinks. Returns
// the absolute path. Linked roots/ancestors throw BoundaryError; missing or
// unreadable prefixes propagate raw so callers report the real errno.
function assertNoSymlinkAncestors(abs, kind) {
  const parts = abs.split(sep).filter(Boolean);
  let prefix = sep;
  const prefixes = [sep];
  for (const part of parts) {
    prefix = prefix === sep ? `${sep}${part}` : `${prefix}${sep}${part}`;
    prefixes.push(prefix);
  }
  for (const candidate of prefixes) {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink()) {
      throw new BoundaryError(
        kind === "dest" ? CODE_DESTINATION_SYMLINK : CODE_SOURCE_SYMLINK,
        ".",
        "Linked root ancestor.",
      );
    }
  }
  return abs;
}

export function validateArtifactRoot(artifactRoot) {
  const abs = resolve(artifactRoot);
  assertNoSymlinkAncestors(abs, "source");
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new BoundaryError(CODE_SOURCE_SYMLINK, ".", "Artifact root is a symlink.");
  }
  if (!st.isDirectory()) {
    const error = new Error("Artifact root is not a directory.");
    error.code = "ENOTDIR";
    throw error;
  }
  return abs;
}

// Destination roots may not exist yet (valid additions, dry-run with absent
// destination). Validate existing ancestors and the root itself when present;
// never follow a link while creating directories later. An existing non-
// directory root is left for the later target access to fail raw.
export function validateDestinationRoot(destDir) {
  const abs = resolve(destDir);
  const parts = abs.split(sep).filter(Boolean);
  let prefix = sep;
  const prefixes = [sep];
  for (const part of parts)
    prefixes.push((prefix = prefix === sep ? `${sep}${part}` : `${prefix}${sep}${part}`));
  for (let i = 0; i < prefixes.length - 1; i += 1) {
    const candidate = prefixes[i];
    let st;
    try {
      st = lstatSync(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") break;
      throw error;
    }
    if (st.isSymbolicLink()) {
      throw new BoundaryError(CODE_DESTINATION_SYMLINK, ".", "Linked destination ancestor.");
    }
    if (!st.isDirectory()) break;
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new BoundaryError(CODE_DESTINATION_SYMLINK, ".", "Destination root is a symlink.");
    }
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (!error || error.code !== "ENOENT") throw error;
  }
  return abs;
}

// Bounded walk that never follows symlinks. Counts every visited entry (files
// and directories, in-suite or not) against the shared budget and refuses
// links, cycles (which must use links), depth, and entry-count violations
// before any write. Filesystem read failures propagate raw. Returns admitted
// candidates sorted for determinism.
export function collectCandidatesBounded(rootAbs, destinationName) {
  validateArtifactRoot(rootAbs);
  const candidates = [];
  let entries = 0;
  const walk = (dirAbs, depth) => {
    if (depth > MAX_DEPTH) {
      throw new BoundaryError(CODE_ARTIFACT_LIMIT, ".", "Artifact tree exceeds max depth.");
    }
    const names = readdirSync(dirAbs);
    for (const entry of [...names].sort()) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        throw new BoundaryError(CODE_ARTIFACT_LIMIT, ".", "Artifact exceeds max entries.");
      }
      const full = join(dirAbs, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const safe = safeRelativePath(rootAbs, full);
        throw new BoundaryError(CODE_SOURCE_SYMLINK, safe, `Artifact contains a symlink: ${safe}.`);
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        // Never open pipes, sockets or devices, even when outside this suite.
        assertRegularFile(st);
        const relativePath = relative(rootAbs, full);
        const dest = destinationName(entry, relativePath);
        if (dest !== null && dest !== undefined) {
          const actual =
            entry.endsWith("-actual.png") &&
            !dirname(relativePath).split(sep).includes("__screenshots__") &&
            !dirname(relativePath).split(sep).includes("__screenshots-kit__");
          candidates.push({ src: full, dest, actual });
        }
      }
    }
  };
  walk(rootAbs, 1);
  candidates.sort((a, b) =>
    a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
  );
  return candidates;
}
