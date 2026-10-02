#!/usr/bin/env node
// Staging-only drill for the queued CallInternalAction job (docs/parity.md §6,
// TOG-11706). Port shape: production web never dispatches CallInternalAction
// (drill-only), so this invokes the queued handler shape directly against
// staging through ../src/probes/internal-action-drill — no web route dispatch.
//
//   APP_URL=https://next.togetherweown.com \
//   BOT_ENDPOINT_URL=<staging bot> BOT_PRODUCTION_URL=<production bot> \
//   BOT_SHARED_SECRET=<secret> BOT_KEY_ID=<key id> \
//     node --import ./bin/ts-hook.mjs bin/internal-action-drill.mjs \
//       --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway>
//
// Safety: posts a REAL announcement to a throwaway channel and performs a REAL
// staging role.assign — --channel-key must name a throwaway channel and the
// discord id must be a drill identity. Requires a valid BOT_PRODUCTION_URL
// and APP_URL; refuses the entire production bot hostname AND the production
// web apex, reaches only the admitted staging targets, and never follows
// redirects. Exit codes match the smoke: 0 every check passed, 1 a check
// failed, 2 misconfigured. Secrets come from the environment only (never
// argv) and are never printed or logged.
import { createBotClient } from "../src/bot/client.ts";
import { BotTerminalError } from "../src/jobs/types.ts";
import { resolveDrillTarget, runInternalActionDrill } from "../src/probes/internal-action-drill.ts";

function opt(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

const discordId = opt("discord-id");
const roleKey = opt("role-key");
const channelKey = opt("channel-key");

const missing = ["discord-id", "role-key", "channel-key"].filter(
  (n) => opt(n) === "",
);
if (missing.length > 0) {
  console.error(`internal-action-drill: missing required option(s): ${missing.map((n) => `--${n}`).join(" ")}`);
  process.exit(2);
}

let targets;
try {
  targets = resolveDrillTarget(process.env);
} catch (e) {
  console.error(`internal-action-drill: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

console.log("internal action drill (TOG-11706)");
console.log(`  bot     ${new URL(targets.botUrl).origin}`);
console.log(`  web     ${new URL(targets.webOrigin).origin}`);
console.log("");

const bot = createBotClient({
  url: targets.botUrl,
  secret: process.env.BOT_SHARED_SECRET,
  keyId: process.env.BOT_KEY_ID,
});
try {
  bot.assertConfigured();
} catch (e) {
  console.error(`internal-action-drill: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

let report;
try {
  report = await runInternalActionDrill(bot, { discordId, roleKey, channelKey });
} catch (e) {
  // Misconfiguration (including the production refusals) is exit 2, not a failed check.
  console.error(`internal-action-drill: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(e instanceof BotTerminalError ? 2 : 1);
}

for (const c of report.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.detail}`);
console.log("");

if (!report.ok) {
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.error(`${report.failures.length} check(s) failed. NEEDS WORK`);
  process.exit(1);
}
console.log("PASS");
