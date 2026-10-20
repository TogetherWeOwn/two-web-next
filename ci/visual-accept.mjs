#!/usr/bin/env node
// Accept new visual baselines from a browser-smoke failure artifact:
//   node ci/visual-accept.mjs <unzipped e2e-failure artifact dir>
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

const MAX_DESTINATIONS_SHOWN = 5;
const MAX_SOURCES_SHOWN = 5;

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
// droppedStale, duplicates }`: `resolved` holds candidates with cached bytes
// in destination order, `droppedStale` counts committed copies superseded by a
// reviewed actual, and `duplicates` lists destinations with more than one
// genuinely different source. Sorted by destination for a stable diagnostic.
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
  for (const dest of [...byDest.keys()].sort()) {
    const sources = [...byDest.get(dest)].sort((a, b) =>
      a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
    );
    const actuals = sources.filter((source) => source.actual);
    if (actuals.length > 0) {
      // Reviewed actuals supersede stale committed copies of this destination.
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

// Bounded diagnostic: names colliding destinations and their sources without
// dumping an unbounded artifact listing.
export function formatCollisionDiagnostic(duplicates) {
  const total = duplicates.reduce((sum, { sources }) => sum + sources.length, 0);
  const lines = [
    `Refusing visual baseline acceptance: ${duplicates.length} destination(s) ` +
      `have multiple sources (${total} candidate(s)); no baselines written.`,
  ];
  for (const { dest, sources } of duplicates.slice(0, MAX_DESTINATIONS_SHOWN)) {
    const shown = sources.slice(0, MAX_SOURCES_SHOWN).join(", ");
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
export function preflightWrites(resolved, destDir) {
  const writes = [];
  for (const candidate of resolved) {
    const target = join(destDir, candidate.dest);
    let current = null;
    try {
      current = readFileSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== null) {
      if (current.equals(candidate.bytes)) continue;
      if (!candidate.actual) {
        throw new Error(
          `Refusing stale artifact copy conflict for ${candidate.dest}: checkout baseline differs; no baselines written. Review a matching actual or use a current artifact.`,
        );
      }
    }
    writes.push({ ...candidate, target });
  }
  return writes;
}

// Two-phase acceptance: preflight all sources and local targets, then apply.
// This is not rollback for apply-time filesystem failures.
export function acceptBaselines(artifactDir, destDir) {
  const candidates = collectCandidates(artifactDir);
  const { resolved, droppedStale, duplicates } = resolveDestinations(candidates);
  if (duplicates.length > 0) {
    throw new Error(formatCollisionDiagnostic(duplicates));
  }
  const writes = preflightWrites(resolved, destDir);
  if (writes.length > 0) mkdirSync(destDir, { recursive: true });
  for (const { bytes, target } of writes) {
    writeFileSync(target, bytes);
  }
  return { written: writes.length, dropped: droppedStale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node ci/visual-accept.mjs <artifact-dir>");
    process.exit(2);
  }
  const dest = "e2e/visual/__screenshots__";
  try {
    const { written, dropped } = acceptBaselines(root, dest);
    console.log(`accepted ${written} baseline(s) into ${dest}`);
    if (dropped > 0) {
      console.log(`dropped ${dropped} stale copy(ies) superseded by *-actual.png`);
    }
    process.exit(written ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
