// Fixed, shared diagnostics: never interpolate argv, URLs or driver errors.
export const OPERATOR_ERRORS = Object.freeze({
  E_MODE_CONFLICT: {
    message: "--apply and --dry-run conflict; they cannot be used together.",
    next: "Choose one mode: --dry-run (the default) or --apply.",
    exitCode: 2,
  },
  E_TARGET: {
    message: "--target must be staging or production.",
    next: "Set --target staging or --target production for the intended environment.",
    exitCode: 2,
  },
  E_DUPLICATE_FLAG: {
    message: "A flag or Discord id was repeated.",
    next: "Supply each flag and the Discord id only once.",
    exitCode: 2,
  },
  E_UNKNOWN_FLAG: {
    message: "Unknown or unsupported flag.",
    next: "Remove the unknown flag; use --help for supported options.",
    exitCode: 2,
  },
  E_URL_ARG: {
    message: "Connection URLs are not accepted as arguments.",
    next: "Supply DATABASE_URL through the environment only, never argv.",
    exitCode: 2,
  },
  E_DISCORD_ID: {
    message: "Missing or malformed Discord id.",
    next: "Supply --discord-id=<snowflake> using a nonzero, unpadded decimal Discord id.",
    exitCode: 2,
  },
  E_DATABASE_URL: {
    message: "Refusing: DATABASE_URL is missing or invalid.",
    next: "Check DATABASE_URL in the environment without logging its value.",
    exitCode: 2,
  },
  E_TLS_OVERRIDE: {
    message: "Refusing: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification.",
    next: "Remove NODE_TLS_REJECT_UNAUTHORIZED=0 from the environment.",
    exitCode: 2,
  },
  E_PRODUCTION_TARGET: {
    message: "Refusing: production database without --target production.",
    next: "Verify the intended environment before selecting --target production.",
    exitCode: 2,
  },
  E_REMOTE_TARGET: {
    message: "Refusing: remote database needs --target staging or --target production.",
    next: "Verify the intended environment and supply its --target explicitly.",
    exitCode: 2,
  },
  E_TLS_REQUIRED: {
    message: "Refusing: remote database must use sslmode=verify-full or sslrootcert=system.",
    next: "Configure verified TLS in the environment URL; do not disable verification.",
    exitCode: 2,
  },
  E_CONFIRM: {
    message:
      "Refusing: --apply with --target staging or --target production requires --confirm <host>.",
    next: "Re-run with --confirm <host> where <host> exactly matches the DATABASE_URL host; a dry-run shows the requirement.",
    exitCode: 2,
  },
  LOCK_TIMEOUT: {
    message: "operation failed; changes rolled back (lock timeout 55P03).",
    next: "Retry once the lock clears; verify with a dry-run first.",
    exitCode: 1,
  },
  TX_FAILED: {
    message: "operation failed; transaction rolled back if it started.",
    next: "Check connectivity and migrations without logging DATABASE_URL; re-run the dry-run.",
    exitCode: 1,
  },
});

export class OperatorCliError extends Error {
  constructor(code) {
    super(OPERATOR_ERRORS[code].message);
    this.name = "OperatorCliError";
    this.code = code;
  }
}

export function writeOperatorError(code) {
  const { message, next, exitCode } = OPERATOR_ERRORS[code];
  process.stderr.write(`${JSON.stringify({ ok: false, code, message, next })}\n`);
  return exitCode;
}

// Also checked against the runbook table, so documentation cannot drift.
export function operatorErrorTable() {
  return [
    "| Code | Exit | Message | Next action |",
    "| --- | --- | --- | --- |",
    ...Object.entries(OPERATOR_ERRORS).map(
      ([code, { message, next, exitCode }]) => `| ${code} | ${exitCode} | ${message} | ${next} |`,
    ),
  ].join("\n");
}
