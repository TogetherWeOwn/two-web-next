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
// duplicates of one destination collapse to a single write.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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

function isActualSource(src) {
  return basename(src).endsWith("-actual.png");
}

// One representative `{ src, bytes }` per distinct byte content, in first-seen
// order. Reading happens during the preflight, so an unreadable candidate
// fails before any baseline is written.
function distinctByBytes(sources) {
  const seen = [];
  for (const src of sources) {
    const bytes = readFileSync(src);
    if (!seen.some((entry) => entry.bytes.equals(bytes))) {
      seen.push({ src, bytes });
    }
  }
  return seen;
}

// Resolves every destination to a single winning source. Returns `{ resolved,
// droppedStale, duplicates }`: `resolved` is the `[{ src, dest }]` write plan
// in destination order, `droppedStale` counts committed copies superseded by a
// reviewed actual, and `duplicates` lists destinations with more than one
// genuinely different source. Sorted by destination for a stable diagnostic.
export function resolveDestinations(candidates) {
  const byDest = new Map();
  for (const { src, dest } of candidates) {
    const sources = byDest.get(dest) ?? [];
    sources.push(src);
    byDest.set(dest, sources);
  }
  const resolved = [];
  let droppedStale = 0;
  const duplicates = [];
  for (const dest of [...byDest.keys()].sort()) {
    const sources = [...byDest.get(dest)].sort();
    const actuals = sources.filter(isActualSource);
    if (actuals.length > 0) {
      // Reviewed actuals supersede stale committed copies of this destination.
      droppedStale += sources.length - actuals.length;
      const winners = distinctByBytes(actuals);
      if (winners.length > 1) {
        duplicates.push({ dest, sources: actuals });
      } else {
        resolved.push({ src: winners[0].src, dest });
      }
    } else {
      const winners = distinctByBytes(sources);
      if (winners.length > 1) {
        duplicates.push({ dest, sources });
      } else {
        resolved.push({ src: winners[0].src, dest });
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

// Two-phase acceptance: preflight the full map, then write only when every
// destination resolves to one source. Candidates already byte-identical to
// the destination are skipped. Returns `{ written, dropped }`.
export function acceptBaselines(artifactDir, destDir) {
  const candidates = collectCandidates(artifactDir);
  const { resolved, droppedStale, duplicates } = resolveDestinations(candidates);
  if (duplicates.length > 0) {
    throw new Error(formatCollisionDiagnostic(duplicates));
  }
  mkdirSync(destDir, { recursive: true });
  let written = 0;
  for (const { src, dest } of resolved) {
    const target = join(destDir, dest);
    let current = null;
    try {
      current = readFileSync(target);
    } catch {
      current = null;
    }
    if (current !== null && current.equals(readFileSync(src))) {
      continue;
    }
    copyFileSync(src, target);
    written++;
  }
  return { written, dropped: droppedStale };
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
