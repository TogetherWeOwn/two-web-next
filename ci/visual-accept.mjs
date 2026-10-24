#!/usr/bin/env node
// Accept new visual baselines from a browser-smoke failure artifact:
//   node ci/visual-accept.mjs <unzipped e2e-failure artifact dir> [--dry-run] [--format json]
// Copies every `*-actual.png` under the exact test-results-visual/ suite (a
// changed page) over the matching committed baseline, and every new baseline
// the run wrote under e2e/visual/__screenshots__/ (a page with no baseline
// yet), into e2e/visual/__screenshots__/. Review the diff images in
// the same artifact before committing; a baseline change is a reviewed change.
//
// Only actual images under the exact `test-results-visual` directory segment
// inside the extracted artifact have Hono replacement authority. An extraction
// folder named like a suite does not itself confer authority. Unrelated,
// lookalike and Kit suite screenshots are ignored. Copies under the existing
// Hono baseline path can add absent baselines or match identical bytes, but
// cannot replace differing checkout bytes; a reviewed matching actual outranks
// its stale artifact copy. Do not delete the newer checkout baseline to force
// acceptance.
//
// Preview with `node ci/visual-accept.mjs <artifact-root> --dry-run`, or add
// `--format json` for the version-1 suite/item/error report and next action.
// Apply uses the same validated plan with `node ci/visual-accept.mjs
// <artifact-root>`. Validate flags and the entire bounded plan before creating
// any directory or writing any destination. Input roots must be real
// directories; reject symlinks at the root, in its ancestry and among
// discovered descendants, including cycles. Reject linked destination files,
// the destination root and linked ancestors. Keep resolved sources and
// destinations inside their intended roots, and apply the source bytes cached
// during preflight. Any boundary refusal leaves existing destinations and
// outside files unchanged. This assumes no concurrent hostile filesystem
// writer; apply-time disk errors are not an atomic rollback guarantee.
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
  CODE_STALE_COPY,
  collectCandidatesBounded,
  nextActionFor,
  parseCliArgs,
  preflightWritesBounded,
  resolveDestinationsBounded,
  safeDestName,
  SUITE_HONO,
  validateArtifactRoot,
  validateDestinationRoot,
} from "./visual-accept-policy.mjs";

const MAX_DESTINATIONS_SHOWN = 5;
const MAX_SOURCES_SHOWN = 5;

// Maps one artifact file to its baseline destination filename, or null when
// the file is not an admitted baseline candidate. Naming is unchanged:
// `*-actual.png` flattens to `<name>.png`, and new baselines already under a
// `__screenshots__` directory keep their filename, even with an -actual suffix.
//
// Suite boundary: positively admit Hono actuals only from the exact
// `test-results-visual` segment. The shared e2e-failure artifact also carries
// foreign outputs (`test-results-staging/`, lookalikes, random folders) and
// the Kit outputs (`test-results-kit-visual/`, `test-results-kit-parity/`,
// `__screenshots-kit__/`), which belong to ci/kit-visual-accept.mjs. Anything
// from those paths is ignored here, so a foreign screenshot or Kit redesign
// can never regenerate a Hono baseline.
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
  if (entry.endsWith("-actual.png") && directories.includes("test-results-visual")) {
    return basename(entry).replace(/-actual\.png$/, ".png");
  }
  return null;
}

// Walks the artifact tree and returns every admitted candidate as
// `{ src, dest, actual }`. Baseline-directory copies are never reviewed actuals.
// No filesystem writes happen here. Uses the shared bounded policy: never
// follows symlinks, enforces depth/entry budgets, and counts out-of-suite
// entries before filtering.
export function collectCandidates(root) {
  const rootAbs = resolve(root);
  return collectCandidatesBounded(rootAbs, destinationName);
}

// Resolves every destination to a single winning source. Returns `{ resolved,
// droppedStale, duplicates }`: `resolved` holds candidates with cached bytes
// in destination order, `droppedStale` counts committed copies superseded by a
// reviewed actual, and `duplicates` lists destinations with more than one
// genuinely different source. Sorted by destination for a stable diagnostic.
// Shared with Kit via the bounded policy; unreadable sources throw
// SOURCE_UNREADABLE with a safe relative path.
export function resolveDestinations(candidates, artifactRootAbs) {
  // When no root is supplied (legacy callers), resolve relative to the first
  // candidate's directory so safe paths still name the file without absolutes.
  const rootAbs = artifactRootAbs ?? (candidates[0] ? dirname(candidates[0].src) : resolve("."));
  return resolveDestinationsBounded(candidates, rootAbs);
}

// Bounded diagnostic: names colliding destinations and their sources without
// dumping an unbounded artifact listing and without disclosing absolute roots.
export function formatCollisionDiagnostic(duplicates) {
  const total = duplicates.reduce((sum, { sources }) => sum + sources.length, 0);
  const lines = [
    `Refusing visual baseline acceptance: ${duplicates.length} destination(s) ` +
      `have multiple sources (${total} candidate(s)); no baselines written.`,
  ];
  for (const { dest, sources } of duplicates.slice(0, MAX_DESTINATIONS_SHOWN)) {
    const safeSources = sources.map((src) => safeDestName(basename(String(src))));
    const shown = safeSources.slice(0, MAX_SOURCES_SHOWN).join(", ");
    const more =
      sources.length > MAX_SOURCES_SHOWN ? ` (+${sources.length - MAX_SOURCES_SHOWN} more)` : "";
    lines.push(`  ${safeDestName(dest)} <- ${shown}${more}`);
  }
  if (duplicates.length > MAX_DESTINATIONS_SHOWN) {
    lines.push(`  ... and ${duplicates.length - MAX_DESTINATIONS_SHOWN} more destination(s)`);
  }
  return boundedDiagnostic(lines.join("\n"));
}

// Check every local target before applying either suite's plan. Only an
// admitted actual may replace differing checkout bytes; artifact baseline
// copies are additions or identical no-ops, never replacement authority.
// Rejects linked destination files/roots/ancestors and confinement escapes
// before any mkdir or write.
export function preflightWrites(resolved, destDir) {
  const destAbs = resolve(destDir);
  return preflightWritesBounded(resolved, destAbs, destAbs);
}

// Build the full validated plan without writing. Shared authority for dry-run
// and apply: identical admission, bounds, symlink, collision, stale-copy, and
// cached-bytes handling. Throws BoundaryError on any refusal; returns
// `{ candidates, resolved, droppedStale, writes, items }` on success. Empty
// plans (no admitted candidates) return zero items for the caller to refuse as
// NO_CANDIDATES without writing.
export function planAcceptance(artifactDir, destDir) {
  const artifactAbs = validateArtifactRoot(resolve(artifactDir));
  const destAbs = resolve(destDir);
  validateDestinationRoot(destAbs);
  const candidates = collectCandidatesBounded(artifactAbs, destinationName);
  const { resolved, droppedStale, duplicates } = resolveDestinationsBounded(
    candidates,
    artifactAbs,
  );
  if (duplicates.length > 0) {
    throw new BoundaryError(
      CODE_PLAN_COLLISION,
      safeDestName(duplicates[0].dest),
      formatCollisionDiagnostic(duplicates),
    );
  }
  if (resolved.length === 0) {
    return { candidates, resolved, droppedStale, writes: [], items: [] };
  }
  const writes = preflightWritesBounded(resolved, destAbs, artifactAbs);
  const items = buildPlanItems(SUITE_HONO, resolved);
  return { candidates, resolved, droppedStale, writes, items };
}

// Two-phase acceptance: preflight all sources and local targets, then apply.
// This is not rollback for apply-time filesystem failures.
export function acceptBaselines(artifactDir, destDir) {
  const { resolved, droppedStale, writes } = planAcceptance(artifactDir, destDir);
  if (resolved.length === 0) return { written: 0, dropped: 0 };
  if (writes.length > 0) mkdirSync(resolve(destDir), { recursive: true });
  for (const { bytes, target } of writes) {
    writeFileSync(target, bytes);
  }
  return { written: writes.length, dropped: droppedStale };
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
        SUITE_HONO,
        {
          items: [],
          errors: [{ code, path: "." }],
          next_action: nextActionFor(code),
        },
        2,
      );
    }
    console.error(boundedDiagnostic(error instanceof Error ? error.message : String(error)));
    console.error("usage: node ci/visual-accept.mjs <artifact-dir> [--dry-run] [--format json]");
    process.exit(2);
  }
  const dest = "e2e/visual/__screenshots__";
  try {
    const plan = planAcceptance(parsed.artifactRoot, join(process.cwd(), dest));
    if (plan.resolved.length === 0) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_HONO,
          {
            items: [],
            errors: [{ code: CODE_NO_CANDIDATES, path: "." }],
            next_action: nextActionFor(CODE_NO_CANDIDATES),
          },
          1,
        );
      }
      console.error("visual-accept: no baseline candidates in artifact; no baselines written.");
      process.exit(1);
    }
    if (parsed.dryRun) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_HONO,
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
          `would accept ${plan.writes.length} baseline(s) into ${dest} (${plan.items.length} item(s) validated, ${plan.droppedStale} stale dropped); no writes (dry-run)`,
        ),
      );
      process.exit(0);
    }
    if (plan.writes.length > 0) mkdirSync(join(process.cwd(), dest), { recursive: true });
    for (const { bytes, target } of plan.writes) {
      writeFileSync(target, bytes);
    }
    if (parsed.formatJson) {
      // Success report carries the same stable item IDs as dry-run.
      emitJsonAndExit(
        SUITE_HONO,
        {
          items: plan.items,
          errors: [],
          next_action:
            `Accepted ${plan.writes.length} baseline(s); commit the intentional changes.`.slice(
              0,
              256,
            ),
        },
        0,
      );
    }
    if (plan.writes.length === 0) {
      console.log(`accepted 0 baseline(s) into ${dest} (all identical, no writes)`);
      if (plan.droppedStale > 0) {
        console.log(`dropped ${plan.droppedStale} stale copy(ies) superseded by *-actual.png`);
      }
      process.exit(0);
    }
    console.log(`accepted ${plan.writes.length} baseline(s) into ${dest}`);
    if (plan.droppedStale > 0) {
      console.log(`dropped ${plan.droppedStale} stale copy(ies) superseded by *-actual.png`);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof BoundaryError && error.code === CODE_STALE_COPY) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_HONO,
          {
            items: [],
            errors: [{ code: error.code, path: error.path }],
            next_action: nextActionFor(error.code),
          },
          1,
        );
      }
      console.error(
        boundedDiagnostic(
          `Refusing stale artifact copy conflict for ${error.path}: checkout baseline differs; no baselines written. Review a matching actual or use a current artifact.`,
        ),
      );
      process.exit(1);
    }
    if (error instanceof BoundaryError) {
      if (parsed.formatJson) {
        emitJsonAndExit(
          SUITE_HONO,
          {
            items: [],
            errors: [{ code: error.code, path: error.path }],
            next_action: nextActionFor(error.code),
          },
          1,
        );
      }
      console.error(boundedDiagnostic(error.message));
      process.exit(1);
    }
    console.error(boundedDiagnostic(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
