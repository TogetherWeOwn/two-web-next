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
  TLS_OVERRIDE_REFUSAL,
  validateOperatorEnvironment,
} from "./operator-db-core.mjs";
import { assertDiscordId, InvalidMemberIdError } from "../src/member-erasure.ts";
import { revokeMemberSessions } from "../src/session-revocation.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production]. Connection settings come from env only.";

export function parseRevokeArgs(args) {
  if (!Array.isArray(args)) throw new Error(USAGE);
  if (args.includes("--help")) return { help: true };
  let discordId = "";
  let hasDiscordId = false;
  let mode = "dry-run";
  let target;
  let seenMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply" || arg === "--dry-run") {
      if (seenMode) throw new Error(USAGE);
      seenMode = true;
      mode = arg === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (arg === "--target") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || target !== undefined)
        throw new Error(USAGE);
      target = value;
      i++;
      continue;
    }
    if (arg.startsWith("--target=")) {
      if (target !== undefined) throw new Error(USAGE);
      target = arg.slice("--target=".length);
      continue;
    }
    if (arg.startsWith("--discord-id=")) {
      if (hasDiscordId) throw new Error(USAGE);
      hasDiscordId = true;
      discordId = arg.slice("--discord-id=".length);
      continue;
    }
    if (arg.startsWith("--") || arg.includes("://") || arg.startsWith("postgres"))
      throw new Error(USAGE);
    if (hasDiscordId) throw new Error(USAGE);
    hasDiscordId = true;
    discordId = arg;
  }
  if (target !== undefined && target !== "staging" && target !== "production")
    throw new Error(USAGE);
  assertDiscordId(discordId);
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
    console.error(
      error instanceof InvalidMemberIdError
        ? "revoke-sessions: refusing: malformed Discord id."
        : "revoke-sessions: refusing: expected --discord-id=<snowflake>; connection URLs are env-only.",
    );
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  let target;
  try {
    // Node reads the live process environment at connect time, not the `env` argument.
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error(TLS_OVERRIDE_REFUSAL);
    target = validateRevokeEnvironment(env, parsed.target);
  } catch (error) {
    console.error(`revoke-sessions: ${error instanceof Error ? error.message : "refusing."}`);
    return 2;
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
      `${JSON.stringify({ mode: parsed.mode, counts, passes, stampsPerPass })}\n`,
    );
    return 0;
  } catch (error) {
    if (isLockTimeoutError(error)) {
      process.stderr.write(
        "revoke-sessions: operation failed with a lock timeout (55P03); transaction rolled back. Retry once the lock clears; verify with a dry-run first.\n",
      );
      return 1;
    }
    process.stderr.write(
      "revoke-sessions: operation failed; transaction rolled back if it started. Re-run the dry-run to inspect active counts.\n",
    );
    return 1;
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
