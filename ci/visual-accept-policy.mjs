#!/usr/bin/env node
// Shared bounded artifact-plan boundary policy for visual baseline acceptors.
// Used by ci/visual-accept.mjs (Hono) and ci/kit-visual-accept.mjs (Kit).
//
// Trust boundary: the extracted artifact directory is untrusted input (it may
// contain foreign suites, lookalike names, symlinks, cycles, hostile filenames,
// deep trees, or many entries). The destination checkout is trusted but must not
// be escaped via symlinked files, roots, or ancestors. All planning is
// preflighted before any mkdir or write; any boundary failure leaves all
// destination and outside bytes unchanged.
//
// Concurrency limit (honest): cached source bytes are read once during
// preflight and reused at apply, but this does not claim safety against a
// concurrent hostile filesystem writer. Apply-time disk errors are not rolled
// back. Callers must not run acceptors concurrently against the same roots
// with an untrusted writer.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const POLICY_VERSION = 1;
export const SUITE_HONO = "hono";
export const SUITE_KIT = "kit";

// Shared finite traversal budget. Refuse plans that exceed either bound, even
// when a valid candidate exists. Do not filter by suite before enforcing: every
// visited entry counts.
export const MAX_DEPTH = 64;
export const MAX_ENTRIES = 4096;

// Bounded diagnostics. Human and JSON reports never exceed this many bytes and
// never disclose absolute roots, traversal segments, control characters, raw
// filesystem errors, or source bytes.
export const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
export const MAX_PATH_LEN = 256;
export const MAX_NEXT_ACTION_LEN = 256;
export const MAX_ID_LEN = 160;

export const CODE_SOURCE_SYMLINK = "SOURCE_SYMLINK";
export const CODE_DESTINATION_SYMLINK = "DESTINATION_SYMLINK";
export const CODE_SOURCE_UNREADABLE = "SOURCE_UNREADABLE";
export const CODE_PLAN_COLLISION = "PLAN_COLLISION";
export const CODE_STALE_COPY = "STALE_COPY";
export const CODE_ARTIFACT_LIMIT = "ARTIFACT_LIMIT";
export const CODE_INVALID_ARGUMENTS = "INVALID_ARGUMENTS";
// No admitted candidates (empty or foreign-only artifact). Preserves the
// existing empty-artifact refusal without overloading a boundary code.
export const CODE_NO_CANDIDATES = "NO_CANDIDATES";

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
  const base = sanitizeVisible(basename(String(dest)));
  if (base === "" || base === "." || base === "..") return "_";
  return base.length > MAX_PATH_LEN ? base.slice(0, MAX_PATH_LEN) : base;
}

function truncateUtf8(value, maxBytes) {
  const str = String(value);
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let out = str.slice(0, maxBytes);
  while (out && Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

export function boundedDiagnostic(value) {
  return truncateUtf8(sanitizeVisible(value), MAX_DIAGNOSTIC_BYTES);
}

export function nextActionFor(code, detail) {
  const base = {
    [CODE_SOURCE_SYMLINK]: "Remove the symlink and re-run with a real directory tree.",
    [CODE_DESTINATION_SYMLINK]: "Remove the linked destination and re-run.",
    [CODE_SOURCE_UNREADABLE]: "Fix file permissions and re-run with a readable artifact.",
    [CODE_PLAN_COLLISION]: "Resolve the colliding sources and re-run.",
    [CODE_STALE_COPY]:
      "Use a current artifact or review a matching actual; do not delete the newer baseline.",
    [CODE_ARTIFACT_LIMIT]: "Reduce artifact size or depth and re-run.",
    [CODE_INVALID_ARGUMENTS]: "Run with <artifact-root> [--dry-run] [--format json].",
    [CODE_NO_CANDIDATES]: "Provide an artifact with suite screenshots; nothing to accept.",
  }[code];
  let message = base ?? "Fix the reported issue and re-run.";
  if (detail) {
    const suffix = ` ${sanitizeVisible(detail)}`;
    if (message.length + suffix.length <= MAX_NEXT_ACTION_LEN) message += suffix;
  }
  if (message.length > MAX_NEXT_ACTION_LEN) message = message.slice(0, MAX_NEXT_ACTION_LEN);
  return message;
}

// Strict CLI parser shared by both acceptors. Artifact root first, then
// optional --dry-run and --format json, each at most once. Unknown flags,
// extra positionals, value-bearing --dry-run, missing/wrong --format values,
// --format=json, and duplicates all fail before any filesystem access.
export function parseCliArgs(argv) {
  if (!argv || argv.length === 0) {
    throw new BoundaryError(
      CODE_INVALID_ARGUMENTS,
      ".",
      "Missing artifact directory. Usage: <artifact-root> [--dry-run] [--format json].",
    );
  }
  const [artifactRoot, ...rest] = argv;
  if (!artifactRoot || artifactRoot.startsWith("-")) {
    throw new BoundaryError(
      CODE_INVALID_ARGUMENTS,
      ".",
      "Missing artifact directory. Usage: <artifact-root> [--dry-run] [--format json].",
    );
  }
  let dryRun = false;
  let formatJson = false;
  let seenDryRun = false;
  let seenFormat = false;
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      if (seenDryRun) {
        throw new BoundaryError(CODE_INVALID_ARGUMENTS, ".", "Duplicate --dry-run.");
      }
      seenDryRun = true;
      dryRun = true;
      index += 1;
    } else if (arg === "--format") {
      if (seenFormat) {
        throw new BoundaryError(CODE_INVALID_ARGUMENTS, ".", "Duplicate --format.");
      }
      seenFormat = true;
      index += 1;
      if (index >= rest.length) {
        throw new BoundaryError(CODE_INVALID_ARGUMENTS, ".", "Missing value for --format.");
      }
      const value = rest[index];
      if (value !== "json") {
        throw new BoundaryError(
          CODE_INVALID_ARGUMENTS,
          ".",
          `Unsupported --format value: ${sanitizeVisible(value).slice(0, 32)}.`,
        );
      }
      formatJson = true;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new BoundaryError(
        CODE_INVALID_ARGUMENTS,
        ".",
        `Unknown option: ${sanitizeVisible(arg).slice(0, 64)}.`,
      );
    } else {
      throw new BoundaryError(
        CODE_INVALID_ARGUMENTS,
        ".",
        `Unexpected argument: ${sanitizeVisible(arg).slice(0, 64)}.`,
      );
    }
  }
  return { artifactRoot, dryRun, formatJson };
}

// True when the raw argv explicitly carries a "json" token. Used to decide JSON
// vs human output for invalid invocations that never reach a parsed format.
export function argvWantsJson(argv) {
  return Array.isArray(argv) && argv.includes("json");
}

// lstat every ancestor prefix of an absolute path, refusing symlinks. Returns
// the absolute path. Throws SOURCE_SYMLINK for linked roots/ancestors and
// SOURCE_UNREADABLE for missing or non-directory roots.
function assertNoSymlinkAncestors(abs, kind) {
  const parts = abs.split(sep).filter(Boolean);
  let prefix = sep;
  const prefixes = [sep];
  for (const part of parts) {
    prefix = prefix === sep ? `${sep}${part}` : `${prefix}${sep}${part}`;
    prefixes.push(prefix);
  }
  for (const candidate of prefixes) {
    let st;
    try {
      st = lstatSync(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        // Ancestor missing: the requested root cannot exist as a real dir.
        throw new BoundaryError(
          kind === "dest" ? CODE_DESTINATION_SYMLINK : CODE_SOURCE_SYMLINK,
          ".",
          "Missing root ancestor.",
        );
      }
      throw new BoundaryError(CODE_SOURCE_UNREADABLE, ".", "Unreadable root ancestor.");
    }
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
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new BoundaryError(CODE_SOURCE_UNREADABLE, ".", "Artifact root is unreadable.");
  }
  if (st.isSymbolicLink()) {
    throw new BoundaryError(CODE_SOURCE_SYMLINK, ".", "Artifact root is a symlink.");
  }
  if (!st.isDirectory()) {
    throw new BoundaryError(
      CODE_SOURCE_UNREADABLE,
      ".",
      "Artifact root is unreadable: not a directory.",
    );
  }
  return abs;
}

// Destination roots may not exist yet (valid additions, dry-run with absent
// destination). Validate existing ancestors and the root itself when present;
// never follow a link while creating directories later.
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
      throw new BoundaryError(CODE_SOURCE_UNREADABLE, ".", "Unreadable destination ancestor.");
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
    if (!st.isDirectory()) {
      throw new BoundaryError(
        CODE_DESTINATION_SYMLINK,
        ".",
        "Destination root is not a directory.",
      );
    }
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (!error || error.code !== "ENOENT") {
      throw new BoundaryError(CODE_SOURCE_UNREADABLE, ".", "Unreadable destination root.");
    }
  }
  return abs;
}

// Bounded walk that never follows symlinks. Counts every visited entry (files
// and directories, in-suite or not) against the shared budget and refuses
// links, cycles (which must use links), depth, and entry-count violations
// before any write. Returns admitted candidates sorted for determinism.
export function collectCandidatesBounded(rootAbs, destinationName) {
  validateArtifactRoot(rootAbs);
  const candidates = [];
  let entries = 0;
  const walk = (dirAbs, depth) => {
    if (depth > MAX_DEPTH) {
      throw new BoundaryError(CODE_ARTIFACT_LIMIT, ".", "Artifact tree exceeds max depth.");
    }
    let names;
    try {
      names = readdirSync(dirAbs);
    } catch {
      const safe = safeRelativePath(rootAbs, dirAbs);
      throw new BoundaryError(
        CODE_SOURCE_UNREADABLE,
        safe,
        `Artifact directory is unreadable: ${safe}.`,
      );
    }
    for (const entry of [...names].sort()) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        throw new BoundaryError(CODE_ARTIFACT_LIMIT, ".", "Artifact exceeds max entries.");
      }
      const full = join(dirAbs, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        const safe = safeRelativePath(rootAbs, full);
        throw new BoundaryError(
          CODE_SOURCE_UNREADABLE,
          safe,
          `Artifact entry is unreadable: ${safe}.`,
        );
      }
      if (st.isSymbolicLink()) {
        const safe = safeRelativePath(rootAbs, full);
        throw new BoundaryError(CODE_SOURCE_SYMLINK, safe, `Artifact contains a symlink: ${safe}.`);
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
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

function distinctByBytes(sources) {
  const seen = [];
  for (const source of sources) {
    if (!seen.some((entry) => entry.bytes.equals(source.bytes))) seen.push(source);
  }
  return seen;
}

// Read every candidate once and cache bytes for apply. Actuals supersede stale
// copies; byte-identical duplicates collapse; genuinely different sources for
// one destination are returned as duplicates for PLAN_COLLISION handling.
export function resolveDestinationsBounded(candidates, artifactRootAbs) {
  const byDest = new Map();
  for (const candidate of candidates) {
    let bytes;
    try {
      bytes = readFileSync(candidate.src);
    } catch {
      const safe = safeRelativePath(artifactRootAbs, candidate.src);
      throw new BoundaryError(
        CODE_SOURCE_UNREADABLE,
        safe,
        `Artifact source is unreadable: ${safe}.`,
      );
    }
    const sources = byDest.get(candidate.dest) ?? [];
    sources.push({ ...candidate, bytes });
    byDest.set(candidate.dest, sources);
  }
  const resolved = [];
  let droppedStale = 0;
  const duplicates = [];
  for (const dest of [...byDest.keys()].sort()) {
    const sources = [...byDest.get(dest)].sort((a, b) =>
      a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
    );
    const actuals = sources.filter((source) => source.actual);
    if (actuals.length > 0) {
      droppedStale += sources.length - actuals.length;
      const winners = distinctByBytes(actuals);
      if (winners.length > 1) {
        duplicates.push({ dest, sources: actuals.map((source) => source.src) });
      } else {
        resolved.push(winners[0]);
      }
    } else {
      const winners = distinctByBytes(sources);
      if (winners.length > 1) {
        duplicates.push({ dest, sources: sources.map((source) => source.src) });
      } else {
        resolved.push(winners[0]);
      }
    }
  }
  return { resolved, droppedStale, duplicates };
}

// Preflight every destination before any mkdir or write. Rejects linked files,
// confinement escapes, unreadable targets, and stale-copy replacements. Returns
// writes with cached bytes; identical no-ops are omitted from writes but stay
// in the effective plan for reporting.
export function preflightWritesBounded(resolved, destDirAbs, artifactRootAbs) {
  validateDestinationRoot(destDirAbs);
  const writes = [];
  for (const candidate of resolved) {
    const destName = safeDestName(candidate.dest);
    // Confine to the intended destination root: basenames only, never absolute
    // or parent-escaping.
    if (
      !destName ||
      destName === "." ||
      destName === ".." ||
      String(candidate.dest).includes("/") ||
      String(candidate.dest).includes("\\")
    ) {
      throw new BoundaryError(CODE_DESTINATION_SYMLINK, ".", "Destination escapes its root.");
    }
    const target = join(destDirAbs, destName);
    if (
      relative(destDirAbs, target).startsWith("..") ||
      relative(destDirAbs, target).startsWith("/")
    ) {
      throw new BoundaryError(CODE_DESTINATION_SYMLINK, ".", "Destination escapes its root.");
    }
    let targetStat = null;
    try {
      targetStat = lstatSync(target);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        const safe = safeRelativePath(destDirAbs, target);
        throw new BoundaryError(
          CODE_SOURCE_UNREADABLE,
          safe,
          `Destination target is unreadable: ${safe}.`,
        );
      }
    }
    if (targetStat && targetStat.isSymbolicLink()) {
      const safe = safeRelativePath(destDirAbs, target);
      throw new BoundaryError(
        CODE_DESTINATION_SYMLINK,
        safe,
        `Destination file is a symlink: ${safe}.`,
      );
    }
    let current = null;
    if (targetStat) {
      if (targetStat.isDirectory()) {
        const safe = safeRelativePath(destDirAbs, target);
        throw new BoundaryError(
          CODE_DESTINATION_SYMLINK,
          safe,
          `Destination target is a directory: ${safe}.`,
        );
      }
      try {
        current = readFileSync(target);
      } catch {
        const safe = safeRelativePath(destDirAbs, target);
        throw new BoundaryError(
          CODE_SOURCE_UNREADABLE,
          safe,
          `Destination target is unreadable: ${safe}.`,
        );
      }
    }
    if (current !== null) {
      if (current.equals(candidate.bytes)) continue;
      if (!candidate.actual) {
        throw new BoundaryError(
          CODE_STALE_COPY,
          safeDestName(candidate.dest),
          `Refusing stale artifact copy conflict for ${safeDestName(candidate.dest)}.`,
        );
      }
    }
    writes.push({ ...candidate, dest: destName, target });
  }
  return writes;
}

// Stable opaque item IDs: sha256(suite + dest) truncated, independent of
// absolute extraction path and enumeration order. Sorted by dest for stable
// output; a numeric suffix disambiguates the only realistic collision (same
// 16-hex prefix for two dests in one plan).
export function stableItemId(suite, dest, salt = "") {
  const hash = createHash("sha256").update(`${suite}:${salt}:${dest}`).digest("hex").slice(0, 16);
  const id = `${suite}-${hash}`;
  return id.length > MAX_ID_LEN ? id.slice(0, MAX_ID_LEN) : id;
}

export function buildPlanItems(suite, resolved) {
  const sorted = [...resolved].sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
  const seen = new Set();
  return sorted.map((candidate, index) => {
    let id = stableItemId(suite, candidate.dest);
    if (seen.has(id)) id = stableItemId(suite, candidate.dest, String(index));
    seen.add(id);
    return {
      id,
      dest: safeDestName(candidate.dest),
      actual: Boolean(candidate.actual),
    };
  });
}

function safeJsonStrings(value) {
  if (typeof value === "string") return sanitizeVisible(value);
  if (Array.isArray(value)) return value.map(safeJsonStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, safeJsonStrings(nested)]),
    );
  }
  return value;
}

export function buildJsonReport({ suite, items, errors, next_action }) {
  const cleanItems = (items ?? []).map((item) => ({
    id: sanitizeVisible(item.id).slice(0, MAX_ID_LEN),
    dest: sanitizeVisible(item.dest ?? "").slice(0, MAX_PATH_LEN),
    actual: Boolean(item.actual),
  }));
  const cleanErrors = (errors ?? []).slice(0, 10).map((error) => ({
    code: sanitizeVisible(error.code).slice(0, 64),
    path: sanitizeVisible(error.path ?? ".").slice(0, MAX_PATH_LEN),
  }));
  let nextAction = sanitizeVisible(next_action ?? "");
  if (!nextAction) nextAction = nextActionFor(cleanErrors[0]?.code ?? CODE_NO_CANDIDATES);
  if (nextAction.length > MAX_NEXT_ACTION_LEN)
    nextAction = nextAction.slice(0, MAX_NEXT_ACTION_LEN);
  let report = safeJsonStrings({
    version: POLICY_VERSION,
    suite,
    items: cleanItems,
    errors: cleanErrors,
    next_action: nextAction,
  });
  let text = JSON.stringify(report);
  if (text.length > MAX_DIAGNOSTIC_BYTES) {
    report = safeJsonStrings({
      version: POLICY_VERSION,
      suite,
      items: [],
      errors: cleanErrors.slice(0, 1),
      next_action: nextAction.slice(0, MAX_NEXT_ACTION_LEN),
    });
    text = JSON.stringify(report);
    if (text.length > MAX_DIAGNOSTIC_BYTES) {
      report = {
        version: POLICY_VERSION,
        suite,
        items: [],
        errors: [{ code: cleanErrors[0]?.code ?? CODE_ARTIFACT_LIMIT, path: "." }],
        next_action: "Fix the reported issue and re-run.",
      };
      text = JSON.stringify(report);
    }
  }
  return { report, text };
}

export function boundaryErrorToJson({ suite, error, nextDetail }) {
  const code = error instanceof BoundaryError ? error.code : CODE_SOURCE_UNREADABLE;
  const path = error instanceof BoundaryError ? error.path : ".";
  return buildJsonReport({
    suite,
    items: [],
    errors: [{ code, path }],
    next_action: nextActionFor(code, nextDetail),
  });
}
