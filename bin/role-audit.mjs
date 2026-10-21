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
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  assertSnowflakeIds,
  compareModeratorSets,
  InvalidRoleAuditInputError,
  normalizeIdList,
  renderRoleAuditReport,
  roleAuditJson,
  ROLE_AUDIT_MAX_SHOWN,
} from "../src/probes/role-audit.ts";

import {
  emitProbeError,
  OPERATOR_PROBE_CONTRACT,
  OPERATOR_PROBE_MAX_INPUT_BYTES,
  ProbeInputError,
} from "./operator-probe-errors.mjs";

const USAGE = `Usage: node --import ./bin/ts-hook.mjs bin/role-audit.mjs (--discord-file=<path> | --discord-ids=<csv>) (--app-file=<path> | --app-ids=<csv>) [--json] [--help]

Compare local ID lists only; no network, database or role changes. Each side needs
exactly one nonempty source option, supplied once. Files contain a JSON string
array, newline text or CSV; an empty file represents an empty set. IDs must be
10-25 decimal digits. Each input is at most 1000000 UTF-8 bytes; each drift list
shows at most 20 IDs with exact omitted counts.
Exit 0 = match, 1 = drift, 2 = usage/input error. --json keeps verdicts on stdout
and emits operator-probe-error.v1 refusals only on stderr. --help prints usage
on stdout without reading inputs.
Contract, codes and offline examples: ${OPERATOR_PROBE_CONTRACT}`;

function sourceOptions(args, side) {
  const files = args.filter((a) => a.startsWith(`--${side}-file=`));
  const ids = args.filter((a) => a.startsWith(`--${side}-ids=`));
  if (files.length + ids.length !== 1) {
    throw new ProbeInputError(`${side.toUpperCase()}_SOURCE_INVALID`);
  }
  const option = files[0] ?? ids[0];
  const value = option.slice(option.indexOf("=") + 1);
  if (value === "") throw new ProbeInputError(`${side.toUpperCase()}_SOURCE_INVALID`);
  return { file: files.length ? value : undefined, ids: ids.length ? value : undefined };
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

function loadSide({ file, ids }, side) {
  let raw = ids;
  if (file !== undefined) {
    try {
      if (!statSync(file).isFile()) throw new ProbeInputError(`${side}_FILE_UNREADABLE`);
      raw = readFileSync(file, "utf8");
    } catch {
      throw new ProbeInputError(`${side}_FILE_UNREADABLE`);
    }
  }
  if (Buffer.byteLength(raw, "utf8") > OPERATOR_PROBE_MAX_INPUT_BYTES) {
    throw new ProbeInputError(`${side}_INPUT_TOO_LARGE`);
  }
  try {
    const normalized = normalizeIdList(file !== undefined ? parseIdFile(raw) : raw.split(","));
    assertSnowflakeIds(normalized, side);
    return normalized;
  } catch (err) {
    if (err instanceof InvalidRoleAuditInputError) {
      // Validation exceptions can quote rejected IDs. Publish only a literal
      // side-specific refusal, never the exception text or the rejected value.
      throw new ProbeInputError(`${side}_INPUT_INVALID`);
    }
    throw err;
  }
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
  if (args.some((a) => !known(a))) {
    return emitProbeError("role-audit", json, "UNKNOWN_OPTION", stderr);
  }
  if (args.filter((a) => a === "--json").length > 1) {
    return emitProbeError("role-audit", json, "DUPLICATE_OPTION", stderr);
  }
  let discord;
  let app;
  try {
    // Refuse ambiguous sources on either side before opening any input file.
    const discordSource = sourceOptions(args, "discord");
    const appSource = sourceOptions(args, "app");
    discord = loadSide(discordSource, "DISCORD");
    app = loadSide(appSource, "APP");
  } catch (err) {
    if (err instanceof ProbeInputError) {
      return emitProbeError("role-audit", json, err.code, stderr);
    }
    throw err;
  }
  const result = compareModeratorSets(discord, app);
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
