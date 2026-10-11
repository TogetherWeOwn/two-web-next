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
// before any baseline write. When two admitted candidates flatten to one
// destination name, acceptance is refused with a nonzero exit and existing
// baseline bytes and directory contents are left untouched.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_DESTINATIONS_SHOWN = 5;
const MAX_SOURCES_SHOWN = 5;

// Maps one artifact file to its baseline destination filename, or null when
// the file is not an admitted baseline candidate. Naming is unchanged:
// `*-actual.png` flattens to `<name>.png`, and new baselines already under a
// `__screenshots__` path keep their filename.
export function destinationName(entry, fullPath) {
  if (entry.endsWith("-actual.png")) {
    return basename(entry).replace(/-actual\.png$/, ".png");
  }
  if (entry.endsWith(".png") && fullPath.includes("__screenshots__")) {
    return basename(entry);
  }
  return null;
}

// Walks the artifact tree and returns every admitted candidate as
// `{ src, dest }`. No filesystem writes happen here.
export function collectCandidates(root) {
  const candidates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        const dest = destinationName(entry, full);
        if (dest !== null) candidates.push({ src: full, dest });
      }
    }
  };
  walk(root);
  candidates.sort((a, b) =>
    a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : a.src < b.src ? -1 : a.src > b.src ? 1 : 0,
  );
  return candidates;
}

// Groups candidates by destination; every destination with more than one
// source is a collision. Sorted by destination for a stable diagnostic.
export function findDuplicateDestinations(candidates) {
  const byDest = new Map();
  for (const { src, dest } of candidates) {
    const sources = byDest.get(dest) ?? [];
    sources.push(src);
    byDest.set(dest, sources);
  }
  const duplicates = [];
  for (const [dest, sources] of byDest) {
    if (sources.length > 1) duplicates.push({ dest, sources: [...sources].sort() });
  }
  duplicates.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
  return duplicates;
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

// Two-phase acceptance: preflight the full map, then write only when every
// destination has exactly one source. Returns the number of baselines written.
export function acceptBaselines(artifactDir, destDir) {
  const candidates = collectCandidates(artifactDir);
  const duplicates = findDuplicateDestinations(candidates);
  if (duplicates.length > 0) {
    throw new Error(formatCollisionDiagnostic(duplicates));
  }
  mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const { src, dest } of candidates) {
    copyFileSync(src, join(destDir, dest));
    n++;
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node ci/visual-accept.mjs <artifact-dir>");
    process.exit(2);
  }
  const dest = "e2e/visual/__screenshots__";
  let candidates;
  try {
    candidates = collectCandidates(root);
  } catch (error) {
    console.error(`visual baseline acceptance failed: ${error.message}`);
    process.exit(1);
  }
  const duplicates = findDuplicateDestinations(candidates);
  if (duplicates.length > 0) {
    console.error(formatCollisionDiagnostic(duplicates));
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const { src, dest: name } of candidates) {
    copyFileSync(src, join(dest, name));
    n++;
  }
  console.log(`accepted ${n} baseline(s) into ${dest}`);
  process.exit(n ? 0 : 1);
}
