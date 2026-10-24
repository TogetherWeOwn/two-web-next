#!/usr/bin/env node
// Accept reviewed Kit baselines from an unzipped failure artifact:
//   node ci/kit-visual-accept.mjs <unzipped artifact dir>
// Only Kit suite directories relative to that root establish ownership; root
// names and substring-lookalike folders never admit Hono images into Kit.
// Reviewed actuals can replace checkout bytes. Artifact baseline copies can
// only add absent files or match existing bytes; stale copies refuse the full
// plan before any write. Inspect the failure images before accepting them.
// Flags (all optional, either side of the positional): --dry-run prints the
// plan and writes nothing; --format json prints one versioned verdict. Any
// other flag exits 2 with a stable code before the artifact is read. See
// ci/visual-accept-cli.mjs for the codes.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPlan, planBaselines } from "./visual-accept.mjs";
import { runCli } from "./visual-accept-cli.mjs";

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

const MAX_NAMES_SHOWN = 20;

export function acceptBaselines(
  artifactDir,
  { cwd = process.cwd(), copy, mkdir = mkdirSync } = {},
) {
  const destDir = join(cwd, KIT_SCREENSHOT_DIR);
  const plan = planKit(artifactDir, destDir);
  if (plan.verdict === "no_candidates") {
    return { ok: false, message: NO_CANDIDATES_MESSAGE };
  }
  if (plan.verdict === "collision") {
    return {
      ok: false,
      message: `kit-visual-accept: refusing: different sources map to ${plan.duplicates[0].dest}; no baselines written`,
    };
  }
  if (plan.verdict === "stale_copy_conflict") {
    return { ok: false, message: `kit-visual-accept: ${plan.conflict.message}` };
  }
  if (plan.writes.length > 0) mkdir(destDir, { recursive: true });
  for (const { src, target, bytes } of plan.writes) {
    if (copy) copy(src, target);
    else writeFileSync(target, bytes);
  }
  return { ok: true, accepted: plan.writes.map(({ dest }) => dest) };
}

const NO_CANDIDATES_MESSAGE = "kit-visual-accept: no baseline candidates in artifact";

const planKit = (artifactDir, destDir) => planBaselines(artifactDir, destDir, collectCandidates);

// Kit suite adapter for the shared CLI (ci/visual-accept-cli.mjs).
export const KIT_ADAPTER = {
  tool: "kit-visual-accept",
  script: "ci/kit-visual-accept.mjs",
  destLabel: KIT_SCREENSHOT_DIR,
  // The documented run exits 0 when every candidate already matches.
  nothingWrittenFails: false,
  noCandidatesMessage: NO_CANDIDATES_MESSAGE,
  plan: (artifact) => planKit(artifact, join(process.cwd(), KIT_SCREENSHOT_DIR)),
  apply: (plan) => applyPlan(plan, join(process.cwd(), KIT_SCREENSHOT_DIR)),
  refusalMessage: (plan) =>
    plan.verdict === "collision"
      ? `kit-visual-accept: refusing: different sources map to ${plan.duplicates[0].dest}; no baselines written`
      : `kit-visual-accept: ${plan.conflict.message}`,
  successLines: (plan) => {
    const names = plan.writes.map(({ dest }) => dest);
    const shown = names.slice(0, MAX_NAMES_SHOWN).join(", ");
    const more = names.length > MAX_NAMES_SHOWN ? ` (+${names.length - MAX_NAMES_SHOWN} more)` : "";
    return [
      `kit-visual-accept: accepted ${names.length} Kit baselines into ${KIT_SCREENSHOT_DIR}: ${shown}${more}`,
    ];
  },
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { status, stdout, stderr } = runCli(KIT_ADAPTER, process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = status;
}
