#!/usr/bin/env node
// Deploy-time moderator role-audit (W16 pre-flip verification).
//
// Compares the Discord-moderator set against the app-moderator set and exits
// non-zero on drift with a bounded report. Read-only: it reads ID lists from
// files or flags, never touches the network or a database, never mutates
// roles, and never reads or prints tokens or secrets.
//
//   node --import ./bin/ts-hook.mjs bin/role-audit.mjs --discord-file=<path> --app-file=<path> [--json]
//   node --import ./bin/ts-hook.mjs bin/role-audit.mjs --discord-ids=<csv> --app-ids=<csv> [--json]
//
// Each side needs exactly one source (--*-file or --*-ids, not both, not
// neither). Files hold either a JSON array of strings or newline/comma
// separated IDs. Exit 0 = sets match (empty-safe), 1 = drift, 2 = usage or
// malformed input. Output is bounded to ROLE_AUDIT_MAX_SHOWN IDs per side.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  compareModeratorSets,
  InvalidRoleAuditInputError,
  renderRoleAuditReport,
  roleAuditJson,
  ROLE_AUDIT_MAX_SHOWN,
} from "../src/probes/role-audit.ts";

const USAGE =
  "Usage: node --import ./bin/ts-hook.mjs bin/role-audit.mjs (--discord-file=<path> | --discord-ids=<csv>) (--app-file=<path> | --app-ids=<csv>) [--json]. Exit 0 = match, 1 = drift, 2 = usage/input error.";

function flagValue(args, name) {
  const prefix = `${name}=`;
  const found = args.filter((a) => a.startsWith(prefix));
  if (found.length > 1) throw new Error(USAGE);
  const value = found[0] ? found[0].slice(prefix.length) : undefined;
  return value === undefined || value === "" ? undefined : value;
}

/** Parse a file as a JSON string array, else newline/comma separated text. */
export function parseIdFile(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new InvalidRoleAuditInputError("file is not valid JSON or ID text.");
    }
    if (!Array.isArray(parsed)) {
      throw new InvalidRoleAuditInputError("file is not valid JSON or ID text.");
    }
    return parsed;
  }
  return trimmed.split(/[\r\n,]+/);
}

function loadSide(file, ids, label) {
  if ((file === undefined) === (ids === undefined)) throw new Error(USAGE);
  if (file !== undefined) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new InvalidRoleAuditInputError(`cannot read ${label} file.`);
    }
    // Bound file reads: the report is bounded downstream, and a huge file is
    // a usage error rather than a comparison.
    if (raw.length > 1_000_000) {
      throw new InvalidRoleAuditInputError(`${label} file exceeds the 1 MiB input bound.`);
    }
    return parseIdFile(raw);
  }
  return String(ids).split(",");
}

export async function main(
  args = process.argv.slice(2),
  stdout = (t) => process.stdout.write(t),
  stderr = (t) => process.stderr.write(t),
) {
  if (args.includes("--help")) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const known = (a) =>
    a === "--json" ||
    a === "--help" ||
    a.startsWith("--discord-file=") ||
    a.startsWith("--app-file=") ||
    a.startsWith("--discord-ids=") ||
    a.startsWith("--app-ids=");
  const unknown = args.filter((a) => !known(a));
  if (unknown.length > 0) {
    stderr(`role-audit: unknown option(s): ${unknown.join(" ")}. ${USAGE}\n`);
    return 2;
  }
  let discord;
  let app;
  try {
    discord = loadSide(
      flagValue(args, "--discord-file"),
      flagValue(args, "--discord-ids"),
      "discord",
    );
    app = loadSide(flagValue(args, "--app-file"), flagValue(args, "--app-ids"), "app");
  } catch (err) {
    stderr(`role-audit: ${err instanceof Error ? err.message : USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = compareModeratorSets(discord, app);
  } catch (err) {
    if (err instanceof InvalidRoleAuditInputError) {
      stderr(`role-audit: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (json) {
    stdout(`${JSON.stringify(roleAuditJson(result, ROLE_AUDIT_MAX_SHOWN), null, 2)}\n`);
  } else {
    stdout(`${renderRoleAuditReport(result, ROLE_AUDIT_MAX_SHOWN)}\n`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
