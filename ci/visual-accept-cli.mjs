// Shared command line for ci/visual-accept.mjs and ci/kit-visual-accept.mjs:
//   node ci/<script> [--dry-run] [--format json] <artifact-dir>
// Flags may sit before or after the positional, each at most once. Anything
// else starting with "-" is refused (exit 2) before the artifact is read or a
// baseline written.
//
// Order of checks: flags (UNKNOWN_FLAG), then the positional count
// (MISSING_ARG, EXTRA_ARGS), then the artifact directory (ARTIFACT_NOT_FOUND),
// then planning (NO_CANDIDATES, COLLISION, STALE_COPY_CONFLICT, boundary
// codes, IO_ERROR), then the only writes. Usage errors exit 2, refusals and
// no-ops exit 1, success 0.
//
// --dry-run prints the plan and writes nothing. --format json replaces the
// human output with one versioned verdict line on stdout (stderr stays empty),
// except MISSING_ARG, which has no artifact to judge and stays a stderr usage error.
// No output carries an absolute path, file bytes or a stack: files are named
// by destination filename or artifact-relative path, errors by fixed code.
//
// Adapters (see HONO_ADAPTER and KIT_ADAPTER) supply the suite's plan/apply
// and its compatible human wording; this module never imports either suite.
import { statSync } from "node:fs";
import {
  MAX_DIAGNOSTIC_BYTES,
  safeDestName,
  safeRelativePath,
  truncateUtf8,
} from "./visual-accept-policy.mjs";

export const JSON_VERSION = 1;
const MAX_LISTED = 20;

export const CODES = Object.freeze({
  OK: "OK",
  UNKNOWN_FLAG: "UNKNOWN_FLAG",
  EXTRA_ARGS: "EXTRA_ARGS",
  MISSING_ARG: "MISSING_ARG",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  COLLISION: "COLLISION",
  STALE_COPY_CONFLICT: "STALE_COPY_CONFLICT",
  NO_CANDIDATES: "NO_CANDIDATES",
  NO_CHANGES: "NO_CHANGES",
  IO_ERROR: "IO_ERROR",
  SOURCE_SYMLINK: "SOURCE_SYMLINK",
  DESTINATION_SYMLINK: "DESTINATION_SYMLINK",
  ARTIFACT_LIMIT: "ARTIFACT_LIMIT",
});

const NEXT_ACTION = {
  OK: "Review the baseline diff, then commit only the intentional changes.",
  DRY_RUN_OK: "Rerun without --dry-run to write these baselines.",
  UNKNOWN_FLAG: "Use only --dry-run and --format json, before or after the artifact directory.",
  MISSING_ARG: "Pass the unzipped failure artifact directory as the one positional argument.",
  EXTRA_ARGS: "Pass exactly one artifact directory and remove the extra positional argument.",
  ARTIFACT_NOT_FOUND: "Unzip the failure artifact and pass the path of that existing directory.",
  COLLISION:
    "Keep one reviewed actual per baseline name in the artifact, or use a current artifact, then rerun.",
  STALE_COPY_CONFLICT:
    "Use a current artifact or review a matching actual for the named baseline; never delete the newer checkout baseline.",
  NO_CANDIDATES:
    "Pass the unzipped e2e-failure artifact from the failed run for this suite, then rerun.",
  NO_CHANGES:
    "Every candidate already matches the checkout; check you unzipped the failed run's artifact.",
  IO_ERROR: "Check read and write permission on the artifact and baseline directories, then rerun.",
  SOURCE_SYMLINK:
    "Remove the symlink from the artifact tree and pass a real directory, then rerun.",
  DESTINATION_SYMLINK: "Remove the linked destination file or directory and rerun.",
  ARTIFACT_LIMIT: "Narrow the artifact to the failed run's screenshots and rerun.",
};

// Parses argv (without node and script) into flags and positionals. Never
// touches the filesystem. `error` is the first failing check in documented
// order, or null. Each flag is accepted at most once: a repeat is most likely
// a pasted typo, so it fails like any other unknown flag.
export function parseInvocation(argv) {
  let dryRun = false;
  let json = false;
  let badFlag = false;
  let seenDryRun = false;
  let seenFormat = false;
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      if (seenDryRun) badFlag = true;
      seenDryRun = true;
      dryRun = true;
    } else if (token === "--format") {
      if (seenFormat) badFlag = true;
      seenFormat = true;
      if (argv[index + 1] === "json") {
        json = true;
        index += 1;
      } else {
        badFlag = true;
        // A bad value (for example xml) belongs to --format, not to the path.
        if (index + 1 < argv.length && !argv[index + 1].startsWith("-")) index += 1;
      }
    } else if (token.startsWith("-")) {
      badFlag = true;
    } else {
      positionals.push(token);
    }
  }
  let error = null;
  if (badFlag) error = CODES.UNKNOWN_FLAG;
  else if (positionals.length === 0) error = CODES.MISSING_ARG;
  else if (positionals.length > 1) error = CODES.EXTRA_ARGS;
  return { dryRun, json, error, artifact: positionals[0] ?? null };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listed(items) {
  return { shown: items.slice(0, MAX_LISTED), truncated: Math.max(0, items.length - MAX_LISTED) };
}

function errnoToken(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && /^E[A-Z0-9]{2,15}$/.test(code) ? code : null;
}

// Sources are absolute or cwd-relative under the artifact root; print them
// artifact-relative with forward slashes.
function relativeSource(root, path) {
  return safeRelativePath(root, path);
}

function jsonBase(adapter, flags, outcome) {
  return {
    version: JSON_VERSION,
    tool: adapter.tool,
    mode: flags.dryRun ? "dry-run" : "accept",
    ok: outcome.ok,
    code: outcome.code,
    next_action: outcome.nextAction,
    destinations: outcome.destinations ?? 0,
    sources: outcome.sources ?? 0,
  };
}

// Trim complete list entries, never serialized JSON. Counts include entries
// omitted for either the listing limit or the final UTF-8 byte budget.
function boundedJson(payload) {
  const lists = payload.plan
    ? ["destinations", "sources", "skipped", "collisions"].map((key) => ({
        items: payload.plan[key],
        omit: () => {
          payload.plan.truncated[key] += 1;
        },
      }))
    : ["accepted", "collisions"]
        .filter((key) => Array.isArray(payload[key]))
        .map((key) => ({
          items: payload[key],
          omit: () => {
            payload.truncated += 1;
          },
        }));
  let output = `${JSON.stringify(payload)}\n`;
  while (Buffer.byteLength(output) > MAX_DIAGNOSTIC_BYTES) {
    const largest = lists
      .filter(({ items }) => items.length > 0)
      .sort(
        (a, b) =>
          Buffer.byteLength(JSON.stringify(b.items)) - Buffer.byteLength(JSON.stringify(a.items)),
      )[0];
    if (!largest) throw new Error("Fixed visual report exceeds its byte budget.");
    largest.items.pop();
    largest.omit();
    output = `${JSON.stringify(payload)}\n`;
  }
  return output;
}

function boundedHuman(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  // Keep the machine-readable refusal and next action after a truncated list.
  const codeAt = value.lastIndexOf("\ncode=");
  const suffix = codeAt === -1 ? "" : value.slice(codeAt + 1);
  const body = codeAt === -1 ? value : value.slice(0, codeAt);
  const marker = "\n... report truncated\n";
  return `${truncateUtf8(body, maxBytes - Buffer.byteLength(marker + suffix))}${marker}${suffix}`;
}

function finish(adapter, flags, outcome, human) {
  if (flags.json) {
    const payload = { ...jsonBase(adapter, flags, outcome), ...(outcome.extra ?? {}) };
    return { status: outcome.status, stdout: boundedJson(payload), stderr: "" };
  }
  const stderr = boundedHuman(human.stderr ?? "", MAX_DIAGNOSTIC_BYTES);
  const stdout = boundedHuman(human.stdout ?? "", MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(stderr));
  return { status: outcome.status, stdout, stderr };
}

function codeLines(outcome) {
  return `code=${outcome.code}\nnext_action=${outcome.nextAction}\n`;
}

function usageOutcome(code) {
  return { status: 2, ok: false, code, nextAction: NEXT_ACTION[code] };
}

function usageLine(adapter) {
  return `usage: node ${adapter.script} [--dry-run] [--format json] <artifact-dir>`;
}

function planOutcome(adapter, flags, plan) {
  const base = { destinations: plan.destinations, sources: plan.sources };
  if (plan.verdict === "no_candidates") {
    return { ...base, status: 1, ok: false, code: CODES.NO_CANDIDATES, verdict: "no-op" };
  }
  if (plan.verdict === "collision") {
    return { ...base, status: 1, ok: false, code: CODES.COLLISION, verdict: "refuse" };
  }
  if (plan.verdict === "stale_copy_conflict") {
    return { ...base, status: 1, ok: false, code: CODES.STALE_COPY_CONFLICT, verdict: "refuse" };
  }
  if (plan.verdict === "boundary") {
    return { ...base, status: 1, ok: false, code: plan.boundary.code, verdict: "refuse" };
  }
  if (plan.writes.length === 0 && adapter.nothingWrittenFails) {
    return { ...base, status: 1, ok: false, code: CODES.NO_CHANGES, verdict: "no-op" };
  }
  return { ...base, status: 0, ok: true, code: CODES.OK, verdict: "accept" };
}

function nextActionFor(outcome, dryRun) {
  if (outcome.code === CODES.OK && dryRun) return NEXT_ACTION.DRY_RUN_OK;
  return NEXT_ACTION[outcome.code];
}

function dryRunPlan(plan, outcome, root) {
  const sources = plan.writes.map(({ dest, src }) => ({
    destination: safeDestName(dest),
    source: relativeSource(root, src),
  }));
  const skipped = plan.skipped.map(({ src, reason }) => ({
    item: relativeSource(root, src),
    reason,
  }));
  const destinations = listed(plan.writes.map(({ dest }) => safeDestName(dest)));
  const sourceList = listed(sources);
  const skippedList = listed(skipped);
  const collisions = listed(
    plan.duplicates.map(({ dest, sources: files }) => ({
      destination: safeDestName(dest),
      source_count: files.length,
    })),
  );
  return {
    destinations: destinations.shown,
    sources: sourceList.shown,
    skipped: skippedList.shown,
    collisions: collisions.shown,
    collision: plan.verdict === "collision" ? "refused" : "none",
    boundary: plan.verdict === "boundary" ? { ...plan.boundary } : null,
    verdict: outcome.verdict,
    truncated: {
      destinations: destinations.truncated,
      sources: sourceList.truncated,
      skipped: skippedList.truncated,
      collisions: collisions.truncated,
    },
  };
}

function dryRunHuman(adapter, plan, outcome, root) {
  const lines = [`${adapter.tool} dry run: nothing written`];
  const count = plan.writes.length;
  if (outcome.verdict === "accept") {
    lines.push(`verdict: accept (would write ${count} baseline(s) into ${adapter.destLabel})`);
  } else if (plan.verdict === "collision") {
    lines.push("verdict: refuse (collision; would write no baselines)");
  } else if (plan.verdict === "stale_copy_conflict") {
    lines.push("verdict: refuse (stale copy conflict; would write no baselines)");
  } else if (plan.verdict === "boundary") {
    lines.push("verdict: refuse (boundary; would write no baselines)");
  } else if (plan.verdict === "no_candidates") {
    lines.push("verdict: no-op (no baseline candidates in artifact; would write nothing)");
  } else {
    lines.push("verdict: no-op (every candidate matches the checkout; would write nothing)");
  }
  lines.push(`collision: ${plan.verdict === "collision" ? "refused" : "none"}`);
  if (
    plan.verdict === "collision" ||
    plan.verdict === "stale_copy_conflict" ||
    plan.verdict === "boundary"
  ) {
    lines.push(adapter.refusalMessage(plan, root));
  }
  const writes = listed(plan.writes);
  lines.push(writes.shown.length > 0 ? `destinations (${count}):` : "destinations: none");
  for (const { dest, src } of writes.shown)
    lines.push(`  ${safeDestName(dest)} <- ${relativeSource(root, src)}`);
  if (writes.truncated > 0) lines.push(`  ... and ${writes.truncated} more destination(s)`);
  const skipped = listed(plan.skipped);
  lines.push(skipped.shown.length > 0 ? `skipped (${plan.skipped.length}):` : "skipped: none");
  for (const { src, reason } of skipped.shown)
    lines.push(`  ${relativeSource(root, src)}: ${reason}`);
  if (skipped.truncated > 0) lines.push(`  ... and ${skipped.truncated} more skipped source(s)`);
  return `${lines.join("\n")}\n${codeLines(outcome)}`;
}

// Runs one invocation. Returns `{ status, stdout, stderr }`; the caller prints
// and sets the exit code. All filesystem access goes through the adapter after
// argument and artifact-directory validation.
export function runCli(adapter, argv) {
  const flags = parseInvocation(argv);
  if (flags.error !== null) {
    const outcome = usageOutcome(flags.error);
    // With no artifact named there is no verdict to report: MISSING_ARG always
    // prints the human usage error on stderr, even beside --format json.
    const asJson = flags.json && flags.error !== CODES.MISSING_ARG;
    return finish(adapter, { ...flags, json: asJson }, outcome, {
      stderr: `${usageLine(adapter)}\n${codeLines(outcome)}`,
    });
  }
  if (!isDirectory(flags.artifact)) {
    const outcome = usageOutcome(CODES.ARTIFACT_NOT_FOUND);
    return finish(adapter, flags, outcome, {
      stderr: `${usageLine(adapter)}\n${adapter.tool}: artifact directory not found or not a directory\n${codeLines(outcome)}`,
    });
  }

  const root = flags.artifact;
  let plan;
  try {
    plan = adapter.plan(root);
  } catch (error) {
    return ioFailure(adapter, flags, error);
  }
  const outcome = planOutcome(adapter, flags, plan);
  outcome.nextAction = nextActionFor(outcome, flags.dryRun);

  if (flags.dryRun) {
    outcome.extra = { plan: dryRunPlan(plan, outcome, root) };
    return finish(adapter, flags, outcome, {
      stdout: dryRunHuman(adapter, plan, outcome, root),
    });
  }

  if (plan.verdict === "ok") {
    try {
      adapter.apply(plan);
    } catch (error) {
      return ioFailure(adapter, flags, error);
    }
  }
  if (flags.json) {
    const names = listed(plan.writes.map(({ dest }) => safeDestName(dest)));
    outcome.extra = { accepted: names.shown, truncated: names.truncated };
    if (plan.verdict === "collision") {
      const collisions = listed(
        plan.duplicates.map(({ dest, sources }) => ({
          destination: safeDestName(dest),
          source_count: sources.length,
        })),
      );
      outcome.extra = { collisions: collisions.shown, truncated: collisions.truncated };
    } else if (plan.verdict === "stale_copy_conflict") {
      outcome.extra = { conflicts: [safeDestName(plan.conflict.dest)] };
    } else if (plan.verdict === "boundary") {
      outcome.extra = { boundary: { ...plan.boundary } };
    }
    return finish(adapter, flags, outcome, {});
  }

  if (
    plan.verdict === "collision" ||
    plan.verdict === "stale_copy_conflict" ||
    plan.verdict === "boundary"
  ) {
    return finish(adapter, flags, outcome, {
      stderr: `${adapter.refusalMessage(plan, root)}\n${codeLines(outcome)}`,
    });
  }
  if (plan.verdict === "no_candidates" && adapter.noCandidatesMessage) {
    return finish(adapter, flags, outcome, {
      stderr: `${adapter.noCandidatesMessage}\n${codeLines(outcome)}`,
    });
  }
  const success = `${adapter.successLines(plan).join("\n")}\n`;
  return finish(adapter, flags, outcome, {
    stdout: success,
    stderr: outcome.ok ? "" : codeLines(outcome),
  });
}

function ioFailure(adapter, flags, error) {
  const outcome = { status: 1, ok: false, code: CODES.IO_ERROR, nextAction: NEXT_ACTION.IO_ERROR };
  const token = errnoToken(error);
  const detail = token === null ? "" : ` (${token})`;
  return finish(adapter, flags, outcome, {
    stderr: `${adapter.tool}: could not read or write baseline files${detail}\n${codeLines(outcome)}`,
  });
}
