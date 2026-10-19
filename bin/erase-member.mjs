#!/usr/bin/env node
// Operator member erasure (TOG-12548). Backs the published deletion promise
// (src/privacy-content.ts "Deletion"): for ONE Discord id, remove that
// member's rows in one transaction across users, profiles, rsvps,
// web_sessions (signs them out everywhere) and join_attempts.
//
//   node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production]
//
// Dry-run is the default: print per-table row counts only, never row
// contents. --apply deletes. DATABASE_URL is env-only; never argv or logs.
// A host outside agent-testdb and loopback needs `--target staging` or
// `--target production`; a production-looking URL needs `--target production`.
// Remote connections need sslmode=verify-full or sslrootcert=system.
// Exit 0 on success, 2 on usage/config/refusal (including a malformed id),
// 1 on driver/transaction failure. Driver console output is discarded.
import { pathToFileURL } from "node:url";
import { parseDatabaseUrl } from "./db-ping-core.mjs";
import { assertDiscordId, eraseMember, InvalidMemberIdError } from "../src/member-erasure.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/erase-member.mjs --discord-id=<snowflake> [--dry-run | --apply] [--target staging|production]. Connection settings come from env only.";

export function parseEraseArgs(args) {
  if (!Array.isArray(args)) throw new Error(USAGE);
  if (args.includes("--help")) return { help: true };
  let discordId = "";
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
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      if (target !== undefined) throw new Error(USAGE);
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
      if (discordId) throw new Error(USAGE);
      discordId = arg.slice("--discord-id=".length);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(USAGE);
    // Positional Discord id (exactly one). Anything URL-shaped is refused
    // here so a connection string can never arrive via argv.
    if (arg.includes("://") || arg.startsWith("postgres")) throw new Error(USAGE);
    if (discordId) throw new Error(USAGE);
    discordId = arg;
  }
  if (target !== undefined && target !== "production" && target !== "staging") {
    throw new Error(USAGE);
  }
  // Malformed ids are refused here, before any connection is opened.
  assertDiscordId(discordId);
  return { discordId, mode, target };
}

/** Production-looking connection strings need `--target production`. */
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
  if (/(^|[.-])(prod|production)([.-]|$)/.test(host)) return true;
  if (name === "prod" || name === "production") return true;
  return false;
}

const LOCAL_HOSTS = new Set(["agent-testdb", "localhost", "127.0.0.1", "::1"]);
const TLS_OVERRIDE_REFUSAL = "Refusing: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification.";

export function validateEraseEnvironment(env, target) {
  const raw = env.DATABASE_URL;
  let endpoint;
  try {
    endpoint = parseDatabaseUrl(raw);
  } catch {
    throw new Error("Refusing: DATABASE_URL is missing or invalid.");
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error(TLS_OVERRIDE_REFUSAL);
  if (isProductionDatabaseUrl(raw) && target !== "production") {
    throw new Error("Refusing: production database without --target production.");
  }
  if (LOCAL_HOSTS.has(endpoint.host[0].toLowerCase().replace(/\.$/, "")))
    return { databaseUrl: raw };
  if (target !== "staging" && target !== "production")
    throw new Error("Refusing: remote database needs --target staging or --target production.");
  const url = new URL(raw);
  const mode = url.searchParams.get("sslmode");
  const verified = mode === "verify-full" || (mode === null && url.searchParams.has("sslrootcert"));
  if (!verified)
    throw new Error(
      "Refusing: remote database must use sslmode=verify-full or sslrootcert=system.",
    );
  return { databaseUrl: raw };
}

export function createEraseClient(postgres, raw) {
  const endpoint = parseDatabaseUrl(raw);
  const host = endpoint.host[0].toLowerCase().replace(/\.$/, "");
  if (!LOCAL_HOSTS.has(host) && endpoint.ssl !== "verify-full")
    throw new Error("Refusing: remote client requires verify-full TLS.");
  // Only parsed endpoint fields reach the driver: query parameters such as
  // sslrootcert must never become server startup parameters (Postgres 42704).
  // Bounded operator waits: finite server-enforced statement and lock budgets
  // on this CLI's own single connection. They cover the dry-run counts (no
  // transaction) and every apply statement alike, without changing global
  // database policy. A locked target fails the whole operation; never SKIP
  // LOCKED and never report success while a member row stays unerased.
  return postgres({
    ...endpoint,
    host: [host],
    max: 1,
    connect_timeout: 10,
    debug: false,
    onnotice: () => {},
    target_session_attrs: "read-write",
    connection: {
      timezone: "UTC",
      search_path: "public",
      application_name: "erase-member",
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    },
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseEraseArgs(args);
  } catch (error) {
    if (error instanceof InvalidMemberIdError)
      console.error("erase-member: refusing: malformed Discord id.");
    else
      console.error(
        "erase-member: refusing: expected --discord-id=<snowflake>; connection URLs are env-only.",
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
    target = validateEraseEnvironment(env, parsed.target);
  } catch (error) {
    console.error(`erase-member: ${error instanceof Error ? error.message : "refusing."}`);
    return 2;
  }
  // This standalone process owns its environment. Discard ambient libpq
  // settings before driver construction, including PGAPPNAME/PGSSLMODE.
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  // The driver prints some protocol errors straight to the console; the only
  // permitted output is the one JSON result below.
  for (const method of ["log", "info", "warn", "error", "debug", "trace"])
    console[method] = () => {};
  const { default: postgres } = await import("postgres");
  let sql;
  try {
    sql = createEraseClient(postgres, target.databaseUrl);
    const counts = await eraseMember(sql, parsed.discordId, { dryRun: parsed.mode === "dry-run" });
    // Counts only: never row contents, never the connection string.
    process.stdout.write(`${JSON.stringify({ mode: parsed.mode, counts })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof InvalidMemberIdError) {
      process.stderr.write("erase-member: refusing: malformed Discord id.\n");
      return 2;
    }
    process.stderr.write(
      "erase-member: operation failed; changes rolled back. Check connectivity and migrations without logging DATABASE_URL.\n",
    );
    return 1;
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
