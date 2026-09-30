#!/usr/bin/env node
// Deploy-time moderator role-config probe (docs/parity.md §7, W16 pre-flip).
// Port of two-web `php artisan discord:check-moderators`.
//
//   node --import ./bin/ts-hook.mjs bin/check-moderators.mjs [--require-configured] [--json]
//
// Reads DISCORD_MODERATOR_ROLE_IDS from the environment as the login path
// parses it. Network-free: it checks resolved config, never Discord, so it
// cannot target production. Exit 0 when nothing FAILs, 1 otherwise.
import { checkModerators, renderModeratorReport } from "../src/probes/check-moderators.ts";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--require-configured" && a !== "--json");
if (unknown.length > 0) {
  console.error(`check-moderators: unknown option(s): ${unknown.join(" ")}`);
  process.exit(2);
}

const probe = checkModerators(process.env.DISCORD_MODERATOR_ROLE_IDS, {
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
