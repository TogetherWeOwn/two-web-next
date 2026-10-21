// Versioned JSON plan/report/error documents for the internal-action CLIs
// (bin/internal-action-smoke.mjs, bin/internal-action-drill.mjs).
//
// Every `--json` run prints exactly one document to stdout: a `plan` for a
// preview (exit 0), a `report` for an apply (exit 0/1), an `error` for a
// misconfiguration (exit 2). Error codes are static UPPER_SNAKE; `next`
// always names a safe next action. Nothing here prints secrets, argv values,
// or raw exception text — callers pass static messages only.

export const PLAN_VERSION = 1;

export const ERROR_CODES = {
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  INVALID_RUN_ID: "INVALID_RUN_ID",
  INVALID_TARGET: "INVALID_TARGET",
  MISSING_CONFIGURATION: "MISSING_CONFIGURATION",
  SMOKE_CHECKS_FAILED: "SMOKE_CHECKS_FAILED",
  DRILL_CHECKS_FAILED: "DRILL_CHECKS_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

const NEXT_ACTIONS = {
  INVALID_ARGUMENTS: "Fix the flagged option and re-run without --apply to preview the plan.",
  INVALID_RUN_ID:
    "Choose a run identity of 1-64 letters, digits, underscore or hyphen (leading alnum) and re-run to preview.",
  INVALID_TARGET:
    "Point BOT_ENDPOINT_URL (and APP_URL for the drill) at the staging targets and re-run to preview.",
  MISSING_CONFIGURATION: "Export BOT_SHARED_SECRET and BOT_KEY_ID, then re-run with --apply.",
  SMOKE_CHECKS_FAILED:
    "Fix the failing checks, then re-run the same --run-id with --apply to resume the run.",
  DRILL_CHECKS_FAILED:
    "Fix the failing checks, then re-run the same --run-id with --apply to resume the run.",
  INTERNAL_ERROR: "Re-run without --apply to preview; report the failure with the plan output.",
};

export function nextFor(errorCode) {
  return NEXT_ACTIONS[errorCode] ?? NEXT_ACTIONS.INTERNAL_ERROR;
}

/** A preview: the checks an apply would run, never executed proof. */
export function planDoc({ tool, runId, target, scope, eventKey, webOrigin, checks }) {
  const doc = {
    version: PLAN_VERSION,
    tool,
    mode: "plan",
    runId: runId ?? null,
    target,
    checks: checks.map((c) => ({ id: c.id, label: c.label })),
    next: ["Re-run with --apply to execute this plan against the staging target."],
  };
  if (scope !== undefined) doc.scope = scope;
  if (eventKey !== undefined) doc.eventKey = eventKey;
  if (webOrigin !== undefined) doc.webOrigin = webOrigin;
  return doc;
}

/** An apply outcome: the executed checks plus a static code when they failed. */
export function reportDoc({ tool, runId, report, errorCode }) {
  const doc = {
    version: PLAN_VERSION,
    tool,
    mode: "report",
    runId: runId ?? null,
    ok: report.ok,
    checks: report.checks.map((c) => ({ id: c.id, label: c.label, ok: c.ok, detail: c.detail })),
    failures: [...report.failures],
    next: [
      report.ok ? "All checks passed; the staged effects above are the proof." : nextFor(errorCode),
    ],
  };
  if (!report.ok) doc.errorCode = errorCode;
  return doc;
}

/** A misconfiguration: static code and message, never raw text or secrets. */
export function errorDoc({ tool, errorCode, message }) {
  return {
    version: PLAN_VERSION,
    tool,
    mode: "error",
    checks: [],
    errorCode,
    message,
    next: [nextFor(errorCode)],
  };
}

export function emitJson(doc) {
  console.log(JSON.stringify(doc));
}
