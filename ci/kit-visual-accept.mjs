#!/usr/bin/env node
// Accept reviewed Kit baselines from an unzipped failure artifact:
//   node ci/kit-visual-accept.mjs [--dry-run] [--format json] <unzipped artifact dir>
// Only Kit suite directories relative to that root establish ownership; root
// names and substring-lookalike folders never admit Hono images into Kit.
// Reviewed actuals can replace checkout bytes. Artifact baseline copies can
// only add absent files or match existing bytes; stale copies refuse the full
// plan before any write. Inspect the failure images before accepting them.
//
// Use `node ci/kit-visual-accept.mjs [--dry-run] [--format json] <artifact-root>`
// for Kit-only acceptance. Actual replacement authority comes only from
// the existing exact `test-results-kit-visual` or `test-results-kit-parity`
// segments inside the artifact; baseline copies retain the existing
// `e2e/visual/__screenshots-kit__` path. Hono and unrelated/lookalike
// screenshots have no Kit replacement authority. The extraction folder's name
// is not a suite marker. Flags may sit before or after the positional:
// --dry-run prints the plan and writes nothing, --format json prints one
// versioned verdict, and any other flag exits 2 with a stable code before the
// artifact is read (ci/visual-accept-cli.mjs lists the codes).
//
// Dry-run is read-only and validates the same authority as apply. Reject
// source symlinks (including root/ancestor links, descendants and cycles) and
// linked destination files/ancestors before directory creation or writes.
// Confine the resolved plan to the intended artifact and Kit destination
// roots. Preflight the entire plan and cache source bytes, preserving
// actual-over-stale-copy precedence, collision/stale-copy refusal, additions
// and identical no-ops. Refusal must not change destination or outside bytes.
// Do not delete newer baselines to bypass a stale-copy conflict. These checks
// do not promise safety against a concurrent hostile filesystem writer or
// rollback after an apply-time disk failure.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPlan, planBaselines } from "./visual-accept.mjs";
import { runCli } from "./visual-accept-cli.mjs";
import { collectCandidatesBounded, safeDestName } from "./visual-accept-policy.mjs";

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
  const rootAbs = resolve(root);
  return collectCandidatesBounded(rootAbs, destinationName);
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
      message: `kit-visual-accept: refusing: different sources map to ${safeDestName(plan.duplicates[0].dest)}; no baselines written`,
    };
  }
  if (plan.verdict === "stale_copy_conflict") {
    return { ok: false, message: `kit-visual-accept: ${plan.conflict.message}` };
  }
  if (plan.verdict === "boundary") {
    return {
      ok: false,
      message: `kit-visual-accept: refusing: ${plan.boundary.code} at ${plan.boundary.path}; no baselines written`,
    };
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
  refusalMessage: (plan) => {
    if (plan.verdict === "collision")
      return `kit-visual-accept: refusing: different sources map to ${safeDestName(plan.duplicates[0].dest)}; no baselines written`;
    if (plan.verdict === "boundary")
      return `kit-visual-accept: refusing: ${plan.boundary.code} at ${plan.boundary.path}; no baselines written`;
    return `kit-visual-accept: ${plan.conflict.message}`;
  },
  successLines: (plan) => {
    const names = plan.writes.map(({ dest }) => safeDestName(dest));
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
