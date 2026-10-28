#!/usr/bin/env node
// Operator member erasure. Backs the published deletion promise
// (src/privacy-content.ts "Deletion"): for ONE Discord id, remove that
// member's rows in one transaction across users, profiles, rsvps,
// web_sessions (signs them out everywhere), web_session_grace (retired
// predecessor records), join_attempts, overlay_configs and overlay_tokens.
//
//   node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production] [--confirm <host>]
//
// Dry-run is the default: print per-table row counts only, never row
// contents. --apply deletes. DATABASE_URL is env-only; never argv or logs.
// A host outside agent-testdb and loopback needs `--target staging` or
// `--target production`; a production-looking URL needs `--target production`.
// Remote connections need sslmode=verify-full or sslrootcert=system.
// `--apply` against a remote host also needs `--confirm <host>`, typed exactly
// as the DATABASE_URL host (no trim, no case folding), checked before any
// connection opens. A remote dry-run prints `targetHost` and, without the
// flag, a `confirmHint`. Local hosts never need it. No TTY prompt.
// Exit 0 on success, 2 on usage/config/refusal (including a malformed id),
// 1 on driver/transaction failure. Driver console output is discarded.
import { pathToFileURL } from "node:url";
import { parseDatabaseUrl } from "./db-ping-core.mjs";
import {
  createOperatorClient,
  isLockTimeoutError,
  LOCAL_HOSTS,
  isProductionDatabaseUrl as sharedIsProductionDatabaseUrl,
  validateOperatorEnvironment,
} from "./operator-db-core.mjs";
import {
  OperatorCliError,
  operatorErrorTable,
  writeOperatorError,
} from "./operator-cli-errors.mjs";
import { assertDiscordId, eraseMember, InvalidMemberIdError } from "../src/member-erasure.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production] [--confirm <host>]. Connection settings come from env only. Example: DATABASE_URL=<url> node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> --apply --target staging --confirm <host>, where <host> is the DATABASE_URL host (remote --apply only; a dry-run shows the host).";

const CONFIRM_HINT =
  "--apply on this remote target requires --confirm <host>, typed exactly as targetHost.";

export function parseEraseArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new OperatorCliError("E_UNKNOWN_FLAG");
  if (args.includes("--help")) return { help: true };
  let discordId = "";
  let hasDiscordId = false;
  let mode = "dry-run";
  let target;
  let confirm;
  let seenMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply" || arg === "--dry-run") {
      const requested = arg === "--apply" ? "apply" : "dry-run";
      if (seenMode)
        throw new OperatorCliError(mode === requested ? "E_DUPLICATE_FLAG" : "E_MODE_CONFLICT");
      seenMode = true;
      mode = requested;
      continue;
    }
    if (arg === "--target" || arg.startsWith("--target=")) {
      if (target !== undefined) throw new OperatorCliError("E_DUPLICATE_FLAG");
      const value = arg === "--target" ? args[++i] : arg.slice("--target=".length);
      if (value === undefined || value.startsWith("--")) throw new OperatorCliError("E_TARGET");
      target = value;
      continue;
    }
    if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      if (confirm !== undefined) throw new OperatorCliError("E_DUPLICATE_FLAG");
      const value = arg === "--confirm" ? args[++i] : arg.slice("--confirm=".length);
      if (value === undefined || value === "" || value.startsWith("--"))
        throw new OperatorCliError("E_CONFIRM");
      confirm = value;
      continue;
    }
    if (arg.startsWith("--discord-id=")) {
      if (hasDiscordId) throw new OperatorCliError("E_DUPLICATE_FLAG");
      hasDiscordId = true;
      discordId = arg.slice("--discord-id=".length);
      continue;
    }
    // Refuse URL-shaped argv without ever reflecting it in the diagnostic.
    if (arg.includes("://") || arg.startsWith("postgres")) throw new OperatorCliError("E_URL_ARG");
    if (arg.startsWith("-")) throw new OperatorCliError("E_UNKNOWN_FLAG");
    if (hasDiscordId) throw new OperatorCliError("E_DUPLICATE_FLAG");
    hasDiscordId = true;
    discordId = arg;
  }
  if (target !== undefined && target !== "production" && target !== "staging")
    throw new OperatorCliError("E_TARGET");
  // Malformed ids are refused here, before any connection is opened.
  try {
    assertDiscordId(discordId);
  } catch {
    throw new OperatorCliError("E_DISCORD_ID");
  }
  return { discordId, mode, target, confirm };
}

/** Production-looking connection strings need `--target production`. */
export function isProductionDatabaseUrl(raw) {
  return sharedIsProductionDatabaseUrl(raw);
}

export function validateEraseEnvironment(env, target) {
  return validateOperatorEnvironment(env, target);
}

export function createEraseClient(postgres, raw) {
  return createOperatorClient(postgres, raw, "erase-member");
}

/** The URL host for a non-local target, else undefined. Called after validation. */
function remoteDatabaseHost(raw) {
  if (LOCAL_HOSTS.has(parseDatabaseUrl(raw).host[0].toLowerCase().replace(/\.$/, "")))
    return undefined;
  return new URL(raw).hostname;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseEraseArgs(args);
  } catch (error) {
    return writeOperatorError(error instanceof OperatorCliError ? error.code : "E_UNKNOWN_FLAG");
  }
  if (parsed.help) {
    console.log(`${USAGE}\n\n${operatorErrorTable()}`);
    return 0;
  }
  let target;
  try {
    // Node reads the live process environment at connect time, not the `env` argument.
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new OperatorCliError("E_TLS_OVERRIDE");
    target = validateEraseEnvironment(env, parsed.target);
  } catch (error) {
    return writeOperatorError(error instanceof OperatorCliError ? error.code : "E_DATABASE_URL");
  }
  // Remote targets: the typed host must equal the DATABASE_URL host exactly.
  // Decided from the environment alone, so a refusal precedes any connection.
  const remoteHost = remoteDatabaseHost(env.DATABASE_URL);
  if (remoteHost !== undefined && parsed.mode === "apply" && parsed.confirm !== remoteHost)
    return writeOperatorError("E_CONFIRM");
  // This standalone process owns its environment. Discard ambient libpq
  // settings before driver construction, including PGAPPNAME/PGSSLMODE.
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  // The driver prints some protocol errors straight to the console; the only
  // permitted output is the one JSON result below.
  for (const method of ["log", "info", "warn", "error", "debug", "trace"])
    console[method] = () => {};
  let sql;
  try {
    const { default: postgres } = await import("postgres");
    sql = createEraseClient(postgres, target.databaseUrl);
    const result = await eraseMember(sql, parsed.discordId, {
      dryRun: parsed.mode === "dry-run",
    });
    // Counts only: never row contents, never the connection string. counts
    // keeps one key per table; passes and deletesPerPass report the
    // session-chase forensics next to it.
    const { passes, deletesPerPass, ...counts } = result;
    const remoteDryRun = remoteHost !== undefined && parsed.mode === "dry-run";
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: parsed.mode,
        counts,
        passes,
        deletesPerPass,
        // Dry-run only: the already-visible host, and the apply requirement.
        ...(remoteDryRun ? { targetHost: remoteHost } : {}),
        ...(remoteDryRun && parsed.confirm === undefined ? { confirmHint: CONFIRM_HINT } : {}),
      })}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof InvalidMemberIdError) return writeOperatorError("E_DISCORD_ID");
    return writeOperatorError(isLockTimeoutError(error) ? "LOCK_TIMEOUT" : "TX_FAILED");
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
