#!/usr/bin/env node
// Deploy-time moderator role-config probe (docs/parity.md §7, W16 pre-flip).
// Port of two-web `php artisan discord:check-moderators`.
//
//   node --import ./bin/ts-hook.mjs bin/check-moderators.mjs [--require-configured] [--json]
//   node --import ./bin/ts-hook.mjs bin/check-moderators.mjs --config=<path> [--env=<name>] [--require-configured] [--json]
//
// Reads DISCORD_MODERATOR_ROLE_IDS from the environment as the login path
// parses it, plus DISCORD_GUILD_ID for the guild binding: the configured
// pair must be the pair bound to the queried guild, so a production pair in
// a staging config fails. Network-free: it checks resolved config, never
// Discord, so it cannot target production. Exit 0 when nothing FAILs,
// 1 otherwise; 2 for usage/input refusals (docs/operator-probes.md).
//
// With --config alone it reads top-level vars; with --config plus --env it
// reads env.<name>.vars only, with no fallback to the top level (Wrangler
// does not inherit top-level vars into named environments, so a fallback
// would prove nothing about what the named deploy receives).
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { checkModerators, renderModeratorReport } from "../src/probes/check-moderators.ts";
import {
  emitProbeError,
  OPERATOR_PROBE_CONTRACT,
  OPERATOR_PROBE_MAX_INPUT_BYTES,
  ProbeInputError,
} from "./operator-probe-errors.mjs";

const USAGE = `Usage: node --import ./bin/ts-hook.mjs bin/check-moderators.mjs [--require-configured] [--json] [--config=<path> [--env=<name>]] [--help]

Deploy-time moderator role-config probe. Reads DISCORD_MODERATOR_ROLE_IDS plus
DISCORD_GUILD_ID, or --config top-level vars (with --env, env.<name>.vars only).
--json emits the findings verdict; usage/input refusals go only to stderr as
operator-probe-error.v1. Exit 0 = pass, 1 = failed findings, 2 = usage/input error.
--help prints this usage to stdout and reads nothing. Network-free: it checks
resolved config, never Discord. Supply each option at most once.
Contract, codes and offline examples: ${OPERATOR_PROBE_CONTRACT}`;

const refuse = (code) => {
  throw new ProbeInputError(code);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function main(
  args = process.argv.slice(2),
  stdout = (t) => process.stdout.write(t),
  stderr = (t) => process.stderr.write(t),
) {
  if (args.includes("--help")) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const configs = args.filter((a) => a.startsWith("--config="));
    const envs = args.filter((a) => a.startsWith("--env="));
    if (
      args.some(
        (a) =>
          a !== "--require-configured" &&
          a !== "--json" &&
          !a.startsWith("--config=") &&
          !a.startsWith("--env="),
      )
    ) {
      refuse("UNKNOWN_OPTION");
    }
    for (const flag of ["--json", "--require-configured"]) {
      if (args.filter((a) => a === flag).length > 1) refuse("DUPLICATE_OPTION");
    }
    if (
      envs.length > 0 &&
      (configs.length !== 1 ||
        configs[0] === "--config=" ||
        envs.length !== 1 ||
        envs[0] === "--env=")
    ) {
      refuse("ENV_SOURCE_INVALID");
    }
    if (configs.length > 0 && (configs.length !== 1 || configs[0] === "--config=")) {
      refuse("CONFIG_SOURCE_INVALID");
    }

    let raw = process.env.DISCORD_MODERATOR_ROLE_IDS;
    let guildId = process.env.DISCORD_GUILD_ID || undefined;
    if (configs.length > 0) {
      let text;
      try {
        const path = configs[0].slice("--config=".length);
        const stat = statSync(path);
        if (!stat.isFile()) refuse("CONFIG_UNREADABLE");
        if (stat.size > OPERATOR_PROBE_MAX_INPUT_BYTES) refuse("CONFIG_TOO_LARGE");
        text = readFileSync(path, "utf8");
      } catch (err) {
        if (err instanceof ProbeInputError) throw err;
        refuse("CONFIG_UNREADABLE");
      }
      if (Buffer.byteLength(text, "utf8") > OPERATOR_PROBE_MAX_INPUT_BYTES) {
        refuse("CONFIG_TOO_LARGE");
      }
      let config;
      try {
        config = readWranglerConfig(text);
      } catch {
        refuse("CONFIG_INVALID");
      }
      if (!isObject(config)) refuse("CONFIG_INVALID");
      let selected = config;
      if (envs.length > 0) {
        if (config.env !== undefined && !isObject(config.env)) refuse("CONFIG_INVALID");
        const envName = envs[0].slice("--env=".length);
        if (!config.env || !Object.hasOwn(config.env, envName)) refuse("ENV_NOT_FOUND");
        selected = config.env[envName];
        if (!isObject(selected)) refuse("CONFIG_INVALID");
      }
      if (selected.vars !== undefined && !isObject(selected.vars)) refuse("CONFIG_INVALID");
      // Named vars never fall back to top-level vars or independent process/CI values.
      raw = selected.vars?.DISCORD_MODERATOR_ROLE_IDS;
      if (raw !== undefined && typeof raw !== "string") refuse("MODERATOR_VAR_INVALID");
      guildId = selected.vars?.DISCORD_GUILD_ID;
      if (guildId !== undefined && typeof guildId !== "string") refuse("GUILD_VAR_INVALID");
      guildId ||= undefined;
    }
    // Missing/blank guilds on required config reads must fail guild-binding,
    // not silently fall back to the legacy production-pair expectation.
    const effectiveGuildId =
      args.includes("--require-configured") && configs.length > 0 && guildId === undefined
        ? ""
        : guildId;
    const probe = checkModerators(raw, {
      requireConfigured: args.includes("--require-configured"),
      guildId: effectiveGuildId,
    });
    if (args.includes("--json")) {
      stdout(
        `${JSON.stringify(
          {
            results: probe.findings,
            failures: probe.failures,
            unknowns: probe.unknowns,
            ok: probe.ok,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stdout(`${renderModeratorReport(probe)}\n`);
    }
    return probe.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ProbeInputError) {
      return emitProbeError("check-moderators", args.includes("--json"), err.code, stderr);
    }
    throw err;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = main();
}
