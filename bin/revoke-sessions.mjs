#!/usr/bin/env node
// Revoke one Discord member's active web sessions.
//
//   node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target production]
//
// Dry-run is the default and prints counts only. DATABASE_URL is env-only;
// remote database URLs require the explicit --target production flag.
// Exit 0 on success, 2 on usage/config/refusal, 1 on driver/transaction failure.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { parseDatabaseUrl } from "./db-ping-core.mjs";
import { assertDiscordId, InvalidMemberIdError } from "../src/member-erasure.ts";
import { revokeMemberSessions } from "../src/session-revocation.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/revoke-sessions.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target production]. Connection settings come from env only.";

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
  if (target !== undefined && target !== "production") throw new Error(USAGE);
  assertDiscordId(discordId);
  return { discordId, mode, target };
}

export function isProductionDatabaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let name = "";
  try {
    name = decodeURIComponent(url.pathname.slice(1)).toLowerCase();
  } catch {
    return false;
  }
  return /(^|[.-])(prod|production)([.-]|$)/.test(host) || name === "prod" || name === "production";
}

export function validateRevokeEnvironment(env, target) {
  const raw = env.DATABASE_URL;
  let endpoint;
  try {
    endpoint = parseDatabaseUrl(raw);
  } catch {
    throw new Error("Refusing: DATABASE_URL is missing or invalid.");
  }
  const host = endpoint.host[0].toLowerCase().replace(/\.$/, "");
  const knownLocalHost = new Set(["agent-testdb", "localhost", "127.0.0.1", "::1"]).has(host);
  if ((isProductionDatabaseUrl(raw) || !knownLocalHost) && target !== "production")
    throw new Error("Refusing: remote database without --target production.");
  const url = new URL(raw);
  if (
    !knownLocalHost &&
    url.searchParams.has("sslmode") &&
    url.searchParams.get("sslmode") !== "verify-full"
  )
    throw new Error("Refusing: remote database must use sslmode=verify-full.");
  if (!knownLocalHost && env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("Refusing: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification.");
  return { databaseUrl: raw };
}

export function createRevokeClient(postgres, raw) {
  const endpoint = parseDatabaseUrl(raw);
  const url = new URL(raw);
  const host = endpoint.host[0].toLowerCase().replace(/\.$/, "");
  if (
    !new Set(["agent-testdb", "localhost", "127.0.0.1", "::1"]).has(host) &&
    !url.searchParams.has("sslmode") &&
    !url.searchParams.has("sslrootcert")
  )
    endpoint.ssl = "verify-full";
  return postgres(raw, {
    ...endpoint,
    max: 1,
    connect_timeout: 10,
    debug: false,
    onnotice: () => {},
    target_session_attrs: "read-write",
    connection: { timezone: "UTC", search_path: "public", application_name: "revoke-sessions" },
  });
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
    const counts = await revokeMemberSessions(sql, parsed.discordId, {
      dryRun: parsed.mode === "dry-run",
    });
    process.stdout.write(`${JSON.stringify({ mode: parsed.mode, counts })}\n`);
    return 0;
  } catch {
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
