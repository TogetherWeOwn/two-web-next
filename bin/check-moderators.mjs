#!/usr/bin/env node
// Deploy-time moderator role-config probe (docs/parity.md §7, W16 pre-flip).
// Port of two-web `php artisan discord:check-moderators`.
//
//   node --import ./bin/ts-hook.mjs bin/check-moderators.mjs [--require-configured] [--json]
//
// Reads DISCORD_MODERATOR_ROLE_IDS from the environment as the login path
// parses it. Network-free: it checks resolved config, never Discord, so it
// cannot target production. Exit 0 when nothing FAILs, 1 otherwise.
import { readFileSync } from "node:fs";
import { readWranglerConfig } from "../ci/check-config-docs.mjs";
import { checkModerators, renderModeratorReport } from "../src/probes/check-moderators.ts";

const args = new Set(process.argv.slice(2));
const configs = [...args].filter((a) => a.startsWith("--config="));
const unknown = [...args].filter((a) => a !== "--require-configured" && a !== "--json" && !a.startsWith("--config="));
if (unknown.length > 0) {
  console.error(`check-moderators: unknown option(s): ${unknown.join(" ")}`);
  process.exit(2);
}

let raw = process.env.DISCORD_MODERATOR_ROLE_IDS;
if (configs.length > 0) {
  if (configs.length !== 1 || configs[0] === "--config=") {
    console.error("check-moderators: supply exactly one nonempty --config=<path>");
    process.exit(2);
  }
  try {
    // Top-level config only: deploy must use this exact --config without --env
    // or --var overrides. Never fall back to an independent process/CI value.
    const config = readWranglerConfig(readFileSync(configs[0].slice("--config=".length), "utf8"));
    raw = config.vars?.DISCORD_MODERATOR_ROLE_IDS;
    if (raw !== undefined && typeof raw !== "string") throw new Error("invalid var");
  } catch {
    console.error("check-moderators: cannot read a valid Wrangler config with a string moderator var");
    process.exit(2);
  }
}
const probe = checkModerators(raw, {
  requireConfigured: args.has("--require-configured"),
});

if (args.has("--json")) {
  console.log(
    JSON.stringify(
      { results: probe.findings, failures: probe.failures, unknowns: probe.unknowns, ok: probe.ok },
      null,
      2,
    ),
  );
} else {
  console.log(renderModeratorReport(probe));
}

process.exit(probe.ok ? 0 : 1);
