#!/usr/bin/env node
// Accept reviewed Kit baselines from an unzipped failure artifact:
//   node ci/kit-visual-accept.mjs <unzipped artifact dir>
// Only Kit suite directories relative to that root establish ownership; root
// names and substring-lookalike folders never admit Hono images into Kit.
// Reviewed actuals can replace checkout bytes. Artifact baseline copies can
// only add absent files or match existing bytes; stale copies refuse the full
// plan before any write. Inspect the failure images before accepting them.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { preflightWrites, resolveDestinations } from "./visual-accept.mjs";

export const KIT_SCREENSHOT_DIR = "e2e/visual/__screenshots-kit__";
export const HONO_SCREENSHOT_DIR = "e2e/visual/__screenshots__";

// Only exact directory segments inside the artifact establish suite ownership.
export function destinationName(entry, relativePath) {
  const directories = dirname(relativePath).split(sep);
  if (entry.endsWith(".png") && directories.includes("__screenshots-kit__")) {
    return basename(entry);
  }
  const fromKitSuite =
    directories.includes("test-results-kit-visual") ||
    directories.includes("test-results-kit-parity");
  if (entry.endsWith("-actual.png") && fromKitSuite) {
    return basename(entry).replace(/-actual\.png$/, ".png");
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
        const relativePath = relative(root, full);
        const dest = destinationName(entry, relativePath);
        if (dest !== null) {
          const actual =
            entry.endsWith("-actual.png") &&
            !dirname(relativePath).split(sep).includes("__screenshots-kit__");
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

export function acceptBaselines(
  artifactDir,
  { cwd = process.cwd(), copy, mkdir = mkdirSync } = {},
) {
  const candidates = collectCandidates(artifactDir);
  if (candidates.length === 0) {
    return { ok: false, message: "kit-visual-accept: no baseline candidates in artifact" };
  }
  const { resolved, duplicates } = resolveDestinations(candidates);
  if (duplicates.length > 0) {
    return {
      ok: false,
      message: `kit-visual-accept: refusing: different sources map to ${duplicates[0].dest}; no baselines written`,
    };
  }
  const destDir = join(cwd, KIT_SCREENSHOT_DIR);
  let writes;
  try {
    writes = preflightWrites(resolved, destDir);
  } catch (error) {
    return { ok: false, message: `kit-visual-accept: ${error.message}` };
  }
  if (writes.length > 0) mkdir(destDir, { recursive: true });
  for (const { src, target, bytes } of writes) {
    if (copy) copy(src, target);
    else writeFileSync(target, bytes);
  }
  return { ok: true, accepted: writes.map(({ dest }) => dest) };
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
