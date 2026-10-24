#!/usr/bin/env node
// Accept reviewed Kit baselines from an unzipped failure artifact:
//   node ci/kit-visual-accept.mjs <unzipped artifact dir> [--dry-run] [--format json]
// Only Kit suite directories relative to that root establish ownership; root
// names and substring-lookalike folders never admit Hono images into Kit.
// Reviewed actuals can replace checkout bytes. Artifact baseline copies can
// only add absent files or match existing bytes; stale copies refuse the full
// plan before any write. Inspect the failure images before accepting them.
//
// Use `node ci/kit-visual-accept.mjs <artifact-root> [--dry-run] [--format
// json]` for Kit-only acceptance. Actual replacement authority comes only from
// the existing exact `test-results-kit-visual` or `test-results-kit-parity`
// segments inside the artifact; baseline copies retain the existing
// `e2e/visual/__screenshots-kit__` path. Hono and unrelated/lookalike
// screenshots have no Kit replacement authority. The extraction folder's name
// is not a suite marker. Hono and Kit share one bounded filesystem/plan policy
// and the same version-1 reporting/error conventions, with stable `hono`/`kit`
// suite identity and stable effective-item IDs.
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
import {
  argvWantsJson,
  BoundaryError,
  boundedDiagnostic,
  buildJsonReport,
  buildPlanItems,
  CODE_INVALID_ARGUMENTS,
  CODE_NO_CANDIDATES,
  CODE_PLAN_COLLISION,
  collectCandidatesBounded,
  nextActionFor,
  parseCliArgs,
  preflightWritesBounded,
  resolveDestinationsBounded,
  safeDestName,
  SUITE_KIT,
  validateArtifactRoot,
  validateDestinationRoot,
} from "./visual-accept-policy.mjs";
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
  const rootAbs = resolve(root);
  return collectCandidatesBounded(rootAbs, destinationName);
}

// Re-export the shared resolvers for backward compatibility; Kit now plans
// through the bounded policy below.
export { preflightWrites, resolveDestinations };

function planKitAcceptance(artifactDir, destDirAbs) {
  const artifactAbs = validateArtifactRoot(resolve(artifactDir));
  validateDestinationRoot(destDirAbs);
  const candidates = collectCandidatesBounded(artifactAbs, destinationName);
  if (candidates.length === 0) {
    return { candidates, resolved: [], droppedStale: 0, writes: [], items: [], empty: true };
  }
  const { resolved, droppedStale, duplicates } = resolveDestinationsBounded(
    candidates,
    artifactAbs,
  );
  if (duplicates.length > 0) {
    throw new BoundaryError(
      CODE_PLAN_COLLISION,
      safeDestName(duplicates[0].dest),
      `different sources map to ${safeDestName(duplicates[0].dest)}`,
    );
  }
  if (resolved.length === 0) {
    return { candidates, resolved, droppedStale, writes: [], items: [], empty: true };
  }
  const writes = preflightWritesBounded(resolved, destDirAbs, artifactAbs);
  const items = buildPlanItems(SUITE_KIT, resolved);
  return { candidates, resolved, droppedStale, writes, items, empty: false };
}

export function acceptBaselines(
  artifactDir,
  { cwd = process.cwd(), copy, mkdir = mkdirSync } = {},
) {
  const destDir = join(resolve(cwd), KIT_SCREENSHOT_DIR);
  let plan;
  try {
    plan = planKitAcceptance(artifactDir, destDir);
  } catch (error) {
    const code = error instanceof BoundaryError ? error.code : "SOURCE_UNREADABLE";
    const path = error instanceof BoundaryError ? error.path : ".";
    const detail =
      error instanceof Error
        ? boundedDiagnostic(error.message).slice(0, 200)
        : String(error).slice(0, 200);
    return {
      ok: false,
      message: `kit-visual-accept: refusing: ${detail}; no baselines written`,
      code,
      path,
    };
  }
  if (plan.empty) {
    return {
      ok: false,
      message: "kit-visual-accept: no baseline candidates in artifact",
      code: CODE_NO_CANDIDATES,
      path: ".",
    };
  }
  if (plan.writes.length > 0) mkdir(destDir, { recursive: true });
  for (const { src, target, bytes } of plan.writes) {
    if (copy) copy(src, target);
    else writeFileSync(target, bytes);
  }
  return {
    ok: true,
    accepted: plan.writes.map(({ dest }) => dest),
    items: plan.items,
    dropped: plan.droppedStale,
  };
}

function emitJsonAndExit(suite, { items, errors, next_action }, exitCode) {
  const { text } = buildJsonReport({ suite, items, errors, next_action });
  process.stdout.write(`${text}\n`);
  process.exit(exitCode);
}

function runCli(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    const code = error instanceof BoundaryError ? error.code : CODE_INVALID_ARGUMENTS;
    if (argvWantsJson(argv)) {
      emitJsonAndExit(
        SUITE_KIT,
        {
          items: [],
          errors: [{ code, path: "." }],
          next_action: nextActionFor(code),
        },
        2,
      );
    }
    console.error(boundedDiagnostic(error instanceof Error ? error.message : String(error)));
    console.error(
      "Usage: node ci/kit-visual-accept.mjs <unzipped artifact dir> [--dry-run] [--format json]",
    );
    process.exitCode = 2;
    return;
  }
  const destDir = join(process.cwd(), KIT_SCREENSHOT_DIR);
  try {
    const plan = planKitAcceptance(parsed.artifactRoot, destDir);
    if (plan.empty) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_KIT,
          {
            items: [],
            errors: [{ code: CODE_NO_CANDIDATES, path: "." }],
            next_action: nextActionFor(CODE_NO_CANDIDATES),
          },
          1,
        );
      }
      console.error("kit-visual-accept: no baseline candidates in artifact");
      process.exitCode = 1;
      return;
    }
    if (parsed.dryRun) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_KIT,
          {
            items: plan.items,
            errors: [],
            next_action:
              `Run without --dry-run to apply ${plan.items.length} validated item(s).`.slice(
                0,
                256,
              ),
          },
          0,
        );
      }
      console.log(
        boundedDiagnostic(
          `kit-visual-accept: would accept ${plan.writes.length} Kit baseline(s) (${plan.items.length} item(s) validated); no writes (dry-run)`,
        ),
      );
      process.exitCode = 0;
      return;
    }
    if (plan.writes.length > 0) mkdirSync(destDir, { recursive: true });
    for (const { bytes, target } of plan.writes) {
      writeFileSync(target, bytes);
    }
    if (parsed.formatJson) {
      emitJsonAndExit(
        SUITE_KIT,
        {
          items: plan.items,
          errors: [],
          next_action:
            `Accepted ${plan.writes.length} Kit baseline(s); commit the intentional changes.`.slice(
              0,
              256,
            ),
        },
        0,
      );
    }
    console.log(
      boundedDiagnostic(
        `kit-visual-accept: accepted ${plan.writes.length} Kit baselines into ${KIT_SCREENSHOT_DIR}: ${plan.writes.map(({ dest }) => dest).join(", ")}`,
      ),
    );
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof BoundaryError ? error.code : "SOURCE_UNREADABLE";
    const path = error instanceof BoundaryError ? error.path : ".";
    if (parsed.formatJson) {
      emitJsonAndExit(
        SUITE_KIT,
        {
          items: [],
          errors: [{ code, path }],
          next_action: nextActionFor(code),
        },
        1,
      );
    }
    console.error(
      boundedDiagnostic(
        `kit-visual-accept: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2));
}
