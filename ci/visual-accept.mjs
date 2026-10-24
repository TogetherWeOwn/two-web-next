#!/usr/bin/env node
// Accept new visual baselines from a browser-smoke failure artifact:
//   node ci/visual-accept.mjs [--dry-run] [--format json] <unzipped e2e-failure artifact dir>
// --dry-run prints the plan and writes nothing; --format json prints one
// versioned verdict. Any other flag exits 2 with a stable code before the
// artifact is read (ci/visual-accept-cli.mjs lists the codes).
// Copies every `*-actual.png` under test-results-visual/ (a changed page) over
// the matching committed baseline, and every new baseline the run wrote under
// e2e/visual/__screenshots__/ (a page with no baseline yet), into
// e2e/visual/__screenshots__/. Review the diff images in
// the same artifact before committing; a baseline change is a reviewed change.
//
// Collision preflight: the full destination-name map is built and validated
// before any baseline write. Destinations with two genuinely different sources
// (for example two different `*-actual.png` files flattening to one name) are
// refused with a nonzero exit and existing baseline bytes and directory
// contents are left untouched. Two non-collisions never refuse:
// a reviewed `*-actual.png` supersedes a stale committed copy of the same
// destination carried inside the artifact (the e2e-failure artifact uploads
// the whole `e2e/visual/__screenshots__/` directory), and byte-identical
// duplicates of one destination collapse to a single write. An artifact copy
// without a reviewed actual never replaces differing checkout bytes: that
// conflict refuses the full plan before writes, as do unreadable candidates.
// Suite directories are exact segments relative to the artifact root, so the
// extraction folder's own name cannot change the plan.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./visual-accept-cli.mjs";

const MAX_DESTINATIONS_SHOWN = 5;
const MAX_SOURCES_SHOWN = 5;

// Fixed skip reasons shared by the CLI plan, dry run and JSON output.
export const SKIP_SUPERSEDED = "superseded by reviewed actual";
export const SKIP_DUPLICATE = "byte-identical duplicate";
export const SKIP_UNCHANGED = "identical to checkout baseline";
export const STALE_COPY_CODE = "STALE_COPY_CONFLICT";

// Artifact-relative display path with forward slashes: diagnostics never carry
// the absolute extraction directory.
export function displayPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

// Maps one artifact file to its baseline destination filename, or null when
// the file is not an admitted baseline candidate. Naming is unchanged:
// `*-actual.png` flattens to `<name>.png`, and new baselines already under a
// `__screenshots__` directory keep their filename, even with an -actual suffix.
//
// Suite boundary: the shared e2e-failure artifact also carries the Kit
// outputs (`test-results-kit-visual/`, `test-results-kit-parity/`,
// `__screenshots-kit__/`), which belong to ci/kit-visual-accept.mjs. Anything
// from those paths is ignored here, so a Kit redesign can never regenerate a
// Hono baseline.
export function destinationName(entry, relativePath) {
  const directories = dirname(relativePath).split(sep);
  if (
    directories.includes("test-results-kit-visual") ||
    directories.includes("test-results-kit-parity") ||
    directories.includes("__screenshots-kit__")
  ) {
    return null;
  }
  if (entry.endsWith(".png") && directories.includes("__screenshots__")) {
    return basename(entry);
  }
  if (entry.endsWith("-actual.png")) {
    return basename(entry).replace(/-actual\.png$/, ".png");
  }
  return null;
}

// Walks the artifact tree and returns every admitted candidate as
// `{ src, dest, actual }`. Baseline-directory copies are never reviewed actuals.
// No filesystem writes happen here.
export function collectCandidates(root) {
  const candidates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        const relativePath = relative(root, full);
        const dest = destinationName(entry, relativePath);
        if (dest !== null) {
          const actual =
            entry.endsWith("-actual.png") &&
            !dirname(relativePath).split(sep).includes("__screenshots__");
          candidates.push({ src: full, dest, actual });
        }
      }
    }
  };
  walk(root);
  candidates.sort((a, b) =>
    a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
  );
  return candidates;
}

// One representative per distinct byte content, in first-seen order.
function distinctByBytes(sources) {
  const seen = [];
  for (const source of sources) {
    if (!seen.some((entry) => entry.bytes.equals(source.bytes))) {
      seen.push(source);
    }
  }
  return seen;
}

// Resolves every destination to a single winning source. Returns `{ resolved,
// droppedStale, duplicates, skipped }`: `resolved` holds candidates with cached
// bytes in destination order, `droppedStale` counts committed copies superseded
// by a reviewed actual, `duplicates` lists destinations with more than one
// genuinely different source, and `skipped` names every source that does not
// feed a write with a fixed reason (stale copy superseded, byte-identical
// duplicate). Sorted by destination for a stable diagnostic.
export function resolveDestinations(candidates) {
  const byDest = new Map();
  for (const candidate of candidates) {
    const sources = byDest.get(candidate.dest) ?? [];
    // Read even superseded copies before writing anything. Keep the bytes so
    // the apply phase never needs to re-read a source from the artifact.
    sources.push({ ...candidate, bytes: readFileSync(candidate.src) });
    byDest.set(candidate.dest, sources);
  }
  const resolved = [];
  let droppedStale = 0;
  const duplicates = [];
  const skipped = [];
  for (const dest of [...byDest.keys()].sort()) {
    const sources = [...byDest.get(dest)].sort((a, b) =>
      a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
    );
    const actuals = sources.filter((source) => source.actual);
    if (actuals.length > 0) {
      // Reviewed actuals supersede stale committed copies of this destination.
      droppedStale += sources.length - actuals.length;
      for (const source of sources) {
        if (!source.actual) skipped.push({ src: source.src, dest, reason: SKIP_SUPERSEDED });
      }
      const winners = distinctByBytes(actuals);
      if (winners.length > 1) {
        duplicates.push({ dest, sources: actuals.map((source) => source.src) });
      } else {
        resolved.push(winners[0]);
        for (const source of actuals) {
          if (source !== winners[0])
            skipped.push({ src: source.src, dest, reason: SKIP_DUPLICATE });
        }
      }
    } else {
      const winners = distinctByBytes(sources);
      if (winners.length > 1) {
        duplicates.push({ dest, sources: sources.map((source) => source.src) });
      } else {
        resolved.push(winners[0]);
        for (const source of sources) {
          if (source !== winners[0])
            skipped.push({ src: source.src, dest, reason: SKIP_DUPLICATE });
        }
      }
    }
  }
  return { resolved, droppedStale, duplicates, skipped };
}

// Bounded diagnostic: names colliding destinations and their sources without
// dumping an unbounded artifact listing. With `root`, sources print relative to
// the artifact root instead of as absolute paths.
export function formatCollisionDiagnostic(duplicates, root) {
  const show = (source) => (root === undefined ? source : displayPath(root, source));
  const total = duplicates.reduce((sum, { sources }) => sum + sources.length, 0);
  const lines = [
    `Refusing visual baseline acceptance: ${duplicates.length} destination(s) ` +
      `have multiple sources (${total} candidate(s)); no baselines written.`,
  ];
  for (const { dest, sources } of duplicates.slice(0, MAX_DESTINATIONS_SHOWN)) {
    const shown = sources.slice(0, MAX_SOURCES_SHOWN).map(show).join(", ");
    const more =
      sources.length > MAX_SOURCES_SHOWN ? ` (+${sources.length - MAX_SOURCES_SHOWN} more)` : "";
    lines.push(`  ${dest} <- ${shown}${more}`);
  }
  if (duplicates.length > MAX_DESTINATIONS_SHOWN) {
    lines.push(`  ... and ${duplicates.length - MAX_DESTINATIONS_SHOWN} more destination(s)`);
  }
  return lines.join("\n");
}

// Check every local target before applying either suite's plan. Only an
// admitted actual may replace differing checkout bytes; artifact baseline
// copies are additions or identical no-ops, never replacement authority.
// Returns `{ writes, unchanged }`; `unchanged` holds candidates whose bytes
// already match the checkout. A stale copy conflict throws with `.dest` and
// `.visualAcceptCode`.
export function preflightPlan(resolved, destDir) {
  const writes = [];
  const unchanged = [];
  for (const candidate of resolved) {
    const target = join(destDir, candidate.dest);
    let current = null;
    try {
      current = readFileSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== null) {
      if (current.equals(candidate.bytes)) {
        unchanged.push(candidate);
        continue;
      }
      if (!candidate.actual) {
        const error = new Error(
          `Refusing stale artifact copy conflict for ${candidate.dest}: checkout baseline differs; no baselines written. Review a matching actual or use a current artifact.`,
        );
        error.visualAcceptCode = STALE_COPY_CODE;
        error.dest = candidate.dest;
        throw error;
      }
    }
    writes.push({ ...candidate, target });
  }
  return { writes, unchanged };
}

export function preflightWrites(resolved, destDir) {
  return preflightPlan(resolved, destDir).writes;
}

// Read-only plan for one suite: collect, resolve, collision and stale-copy
// preflight, with no filesystem writes. `verdict` is one of ok, no_candidates,
// collision, stale_copy_conflict. Counts: `sources` candidate files,
// `destinations` distinct destination names. Unreadable files throw.
export function planBaselines(artifactDir, destDir, collect = collectCandidates) {
  const candidates = collect(artifactDir);
  const plan = {
    verdict: "ok",
    sources: candidates.length,
    destinations: 0,
    dropped: 0,
    writes: [],
    skipped: [],
    duplicates: [],
    conflict: null,
  };
  if (candidates.length === 0) {
    plan.verdict = "no_candidates";
    return plan;
  }
  const { resolved, droppedStale, duplicates, skipped } = resolveDestinations(candidates);
  plan.destinations = resolved.length + duplicates.length;
  plan.dropped = droppedStale;
  plan.skipped = skipped;
  if (duplicates.length > 0) {
    plan.verdict = "collision";
    plan.duplicates = duplicates;
    return plan;
  }
  try {
    const { writes, unchanged } = preflightPlan(resolved, destDir);
    plan.writes = writes;
    for (const { src, dest } of unchanged) {
      plan.skipped.push({ src, dest, reason: SKIP_UNCHANGED });
    }
  } catch (error) {
    if (error.visualAcceptCode !== STALE_COPY_CODE) throw error;
    plan.verdict = "stale_copy_conflict";
    plan.conflict = error;
    return plan;
  }
  plan.skipped.sort((a, b) =>
    a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
  );
  return plan;
}

// Applies an `ok` plan: bytes were cached during planning, so nothing is
// re-read from the artifact. `write(target, bytes)` is injectable for Kit.
export function applyPlan(plan, destDir, write = (target, bytes) => writeFileSync(target, bytes)) {
  if (plan.writes.length > 0) mkdirSync(destDir, { recursive: true });
  for (const entry of plan.writes) write(entry.target, entry.bytes, entry);
}

// Two-phase acceptance: preflight all sources and local targets, then apply.
// This is not rollback for apply-time filesystem failures.
export function acceptBaselines(artifactDir, destDir) {
  const plan = planBaselines(artifactDir, destDir);
  if (plan.verdict === "collision") {
    throw new Error(formatCollisionDiagnostic(plan.duplicates));
  }
  if (plan.verdict === "stale_copy_conflict") throw plan.conflict;
  applyPlan(plan, destDir);
  return { written: plan.writes.length, dropped: plan.dropped };
}

const HONO_DEST_DIR = "e2e/visual/__screenshots__";

// Hono suite adapter for the shared CLI (ci/visual-accept-cli.mjs).
export const HONO_ADAPTER = {
  tool: "visual-accept",
  script: "ci/visual-accept.mjs",
  destLabel: HONO_DEST_DIR,
  // The documented run exits 1 when it writes nothing (empty or all unchanged).
  nothingWrittenFails: true,
  plan: (artifact) => planBaselines(artifact, HONO_DEST_DIR),
  apply: (plan) => applyPlan(plan, HONO_DEST_DIR),
  refusalMessage: (plan, root) =>
    plan.verdict === "collision"
      ? formatCollisionDiagnostic(plan.duplicates, root)
      : plan.conflict.message,
  successLines: (plan) => {
    const lines = [`accepted ${plan.writes.length} baseline(s) into ${HONO_DEST_DIR}`];
    if (plan.dropped > 0) {
      lines.push(`dropped ${plan.dropped} stale copy(ies) superseded by *-actual.png`);
    }
    return lines;
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, stdout, stderr } = runCli(HONO_ADAPTER, process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = status;
}
