#!/usr/bin/env node
// Revoke one Discord member's active web sessions.
//
//   node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production]
//
// Dry-run is the default and prints counts only. DATABASE_URL is env-only;
// Remote URLs require --target staging or --target production;
// production-looking URLs require exactly --target production.
// Exit 0 on success, 2 on usage/config/refusal, 1 on driver/transaction failure.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  createOperatorClient,
  isLockTimeoutError,
  isProductionDatabaseUrl as sharedIsProductionDatabaseUrl,
  validateOperatorEnvironment,
} from "./operator-db-core.mjs";
import {
  OperatorCliError,
  operatorErrorTable,
  writeOperatorError,
} from "./operator-cli-errors.mjs";
import { assertDiscordId, InvalidMemberIdError } from "../src/member-erasure.ts";
import { revokeMemberSessions } from "../src/session-revocation.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production]. Connection settings come from env only.";

export function parseRevokeArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new OperatorCliError("E_UNKNOWN_FLAG");
  if (args.includes("--help")) return { help: true };
  let discordId = "";
  let hasDiscordId = false;
  let mode = "dry-run";
  let target;
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
    if (arg.startsWith("--discord-id=")) {
      if (hasDiscordId) throw new OperatorCliError("E_DUPLICATE_FLAG");
      hasDiscordId = true;
      discordId = arg.slice("--discord-id=".length);
      continue;
    }
    if (arg.includes("://") || arg.startsWith("postgres")) throw new OperatorCliError("E_URL_ARG");
    if (arg.startsWith("-")) throw new OperatorCliError("E_UNKNOWN_FLAG");
    if (hasDiscordId) throw new OperatorCliError("E_DUPLICATE_FLAG");
    hasDiscordId = true;
    discordId = arg;
  }
  if (target !== undefined && target !== "staging" && target !== "production")
    throw new OperatorCliError("E_TARGET");
  try {
    assertDiscordId(discordId);
  } catch {
    throw new OperatorCliError("E_DISCORD_ID");
  }
  return { discordId, mode, target };
}

export function isProductionDatabaseUrl(raw) {
  return sharedIsProductionDatabaseUrl(raw);
}

export function validateRevokeEnvironment(env, target) {
  return validateOperatorEnvironment(env, target);
}

export function createRevokeClient(postgres, raw) {
  return createOperatorClient(postgres, raw, "revoke-sessions");
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseRevokeArgs(args);
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
    target = validateRevokeEnvironment(env, parsed.target);
  } catch (error) {
    return writeOperatorError(error instanceof OperatorCliError ? error.code : "E_DATABASE_URL");
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"])
    console[method] = () => {};
  let sql;
  try {
    const { default: postgres } = await import("postgres");
    sql = createRevokeClient(postgres, target.databaseUrl);
    const result = await revokeMemberSessions(sql, parsed.discordId, {
      dryRun: parsed.mode === "dry-run",
    });
    // Counts only: never row contents, never the connection string. counts
    // keeps one key per table; passes and stampsPerPass report the
    // revocation-chase forensics next to it.
    const { passes, stampsPerPass, ...counts } = result;
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: parsed.mode, counts, passes, stampsPerPass })}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof InvalidMemberIdError) return writeOperatorError("E_DISCORD_ID");
    return writeOperatorError(isLockTimeoutError(error) ? "LOCK_TIMEOUT" : "TX_FAILED");
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
