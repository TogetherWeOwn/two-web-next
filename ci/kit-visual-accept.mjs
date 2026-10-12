#!/usr/bin/env node
// Accept Kit redesign baselines from a kit-parity failure artifact:
//   node ci/kit-visual-accept.mjs <unzipped kit-parity-failure artifact dir>
// Copies every `*-actual.png` under test-results-kit-parity/ (a changed Kit
// page) over the matching baseline in e2e/visual/__screenshots-kit__/, and
// every new baseline the run wrote under a `__screenshots-kit__` path, into
// place. An intentional redesign is a reviewed artifact committed in the same
// PR; reviewers treat a baseline change like code.
//
// Hard boundary: this script writes ONLY under e2e/visual/__screenshots-kit__/
// and NEVER into e2e/visual/__screenshots__/ (the 16 attributable Hono
// baselines) — the destination directory is fixed, not derived from artifact
// paths, so a Kit redesign can never silently regenerate a Hono baseline.
// Same file names in the two directories are independent suites, not a
// collision. Use node ci/visual-accept.mjs for Hono.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const KIT_SCREENSHOT_DIR = "e2e/visual/__screenshots-kit__";
export const HONO_SCREENSHOT_DIR = "e2e/visual/__screenshots__";

export function destinationName(entry, fullPath) {
  if (entry.endsWith("-actual.png")) {
    return basename(entry).replace(/-actual\.png$/, ".png");
  }
  if (entry.endsWith(".png") && fullPath.includes("__screenshots-kit__")) {
    return basename(entry);
  }
  return null;
}

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

export function acceptBaselines(
  artifactDir,
  { cwd = process.cwd(), copy = copyFileSync, mkdir = mkdirSync } = {},
) {
  const candidates = collectCandidates(artifactDir);
  if (candidates.length === 0) {
    return { ok: false, message: "kit-visual-accept: no baseline candidates in artifact" };
  }
  const byDest = new Map();
  for (const candidate of candidates) {
    if (!byDest.has(candidate.dest)) byDest.set(candidate.dest, []);
    byDest.get(candidate.dest).push(candidate.src);
  }
  for (const [dest, sources] of byDest) {
    const distinct = distinctByBytes(sources);
    if (distinct.length > 1) {
      return {
        ok: false,
        message: `kit-visual-accept: refusing: ${distinct.length} different sources map to ${dest}`,
      };
    }
  }
  const destDir = join(cwd, KIT_SCREENSHOT_DIR);
  mkdir(destDir, { recursive: true });
  for (const [dest, sources] of byDest) {
    copy(distinctByBytes(sources)[0].src, join(destDir, dest));
  }
  return { ok: true, accepted: [...byDest.keys()].sort() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , artifactDir] = process.argv;
  if (!artifactDir) {
    console.error("Usage: node ci/kit-visual-accept.mjs <unzipped artifact dir>");
    process.exitCode = 2;
  } else {
    const result = acceptBaselines(artifactDir);
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
    } else {
      console.log(
        `kit-visual-accept: accepted ${result.accepted.length} Kit baselines into ${KIT_SCREENSHOT_DIR}: ${result.accepted.join(", ")}`,
      );
    }
  }
}
