#!/usr/bin/env node
// Accept Kit redesign baselines from a kit-parity failure artifact:
//   node ci/kit-visual-accept.mjs <unzipped kit-parity-failure artifact dir>
// Copies every Kit `*-actual.png` under test-results-kit-visual/ or
// test-results-kit-parity/ (a changed Kit page) over the matching baseline in
// e2e/visual/__screenshots-kit__/, and every new baseline the run wrote under
// a `__screenshots-kit__` path, into place. An intentional redesign is a reviewed artifact committed in the same
// PR; reviewers treat a baseline change like code.
//
// Hard boundary: this script writes ONLY under e2e/visual/__screenshots-kit__/
// and NEVER into e2e/visual/__screenshots__/ (the 16 attributable Hono
// baselines) — the destination directory is fixed, not derived from artifact
// paths, so a Kit redesign can never silently regenerate a Hono baseline.
// Source boundary too: the shared e2e-failure artifact carries both suites,
// so Hono `*-actual.png` files are ignored, never copied into the Kit
// baselines. Same file names in the two directories are independent suites,
// not a collision. Use node ci/visual-accept.mjs for Hono.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const KIT_SCREENSHOT_DIR = "e2e/visual/__screenshots-kit__";
export const HONO_SCREENSHOT_DIR = "e2e/visual/__screenshots__";

// Source-scoped: the shared e2e-failure artifact carries both suites, so an
// admitted candidate must come from the Kit suite's own folders —
// `test-results-kit-visual/` or `test-results-kit-parity/` (reviewed actuals),
// or a `__screenshots-kit__` path (new baselines). A Hono `*-actual.png` at any other path is ignored,
// never copied into the Kit baselines.
export function destinationName(entry, fullPath) {
  const fromKitSuite =
    fullPath.includes("test-results-kit-visual") ||
    fullPath.includes("test-results-kit-parity") ||
    fullPath.includes("__screenshots-kit__");
  if (entry.endsWith("-actual.png")) {
    if (!fromKitSuite) return null;
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
  const selectedByDest = new Map();
  for (const [dest, sources] of byDest) {
    const actuals = sources.filter((source) => source.endsWith("-actual.png"));
    const selected = distinctByBytes(actuals.length > 0 ? actuals : sources);
    if (selected.length > 1) {
      return {
        ok: false,
        message: `kit-visual-accept: refusing: ${selected.length} different sources map to ${dest}`,
      };
    }
    selectedByDest.set(dest, selected[0]);
  }
  const destDir = join(cwd, KIT_SCREENSHOT_DIR);
  mkdir(destDir, { recursive: true });
  for (const [dest, source] of selectedByDest) {
    copy(source.src, join(destDir, dest));
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
