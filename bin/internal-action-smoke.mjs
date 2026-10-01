#!/usr/bin/env node
// Live-against-staging QA for the bot's internal actions (docs/parity.md §7,
// W16 cutover rehearsal). Port of two-web `php artisan bot:internal-action-smoke`.
//
//   BOT_ENDPOINT_URL=<staging bot> BOT_SHARED_SECRET=<secret> BOT_KEY_ID=<key id> \
//     node --import ./bin/ts-hook.mjs bin/internal-action-smoke.mjs \
//       --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway> [--event-key=<key>]
//
// Safety: posts a REAL announcement to a throwaway channel and creates a REAL
// staging event — --channel-key must name a throwaway channel. The script
// requires valid BOT_PRODUCTION_URL and BOT_ENDPOINT_URL, refuses the entire
// production hostname, and never follows redirects. Exit codes match legacy:
// 0 every check passed, 1 a check failed, 2 misconfigured. Secrets come from
// the environment only (never argv) and are never printed or logged.
import { createBotClient } from "../src/bot/client.ts";
import { BotTerminalError } from "../src/jobs/types.ts";
import { runBotSmoke, stagingEndpoint } from "../src/probes/bot-smoke.ts";

function opt(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

const discordId = opt("discord-id");
const roleKey = opt("role-key");
const channelKey = opt("channel-key");
const eventKey = opt("event-key") || `tog10112-${crypto.randomUUID().slice(0, 12)}`;

const missing = ["discord-id", "role-key", "channel-key"].filter(
  (n) => opt(n) === "",
);
if (missing.length > 0) {
  console.error(`internal-action-smoke: missing required option(s): ${missing.map((n) => `--${n}`).join(" ")}`);
  process.exit(2);
}

let url;
try {
  url = stagingEndpoint(process.env.BOT_ENDPOINT_URL, process.env.BOT_PRODUCTION_URL);
} catch (e) {
  console.error(`internal-action-smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

console.log("internal actions smoke (TOG-10112)");
console.log(`  target  ${new URL(url).origin}`);
console.log("");

const bot = createBotClient({
  url,
  secret: process.env.BOT_SHARED_SECRET,
  keyId: process.env.BOT_KEY_ID,
});
try {
  bot.assertConfigured();
} catch (e) {
  console.error(`internal-action-smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

let report;
try {
  report = await runBotSmoke(bot, { discordId, roleKey, channelKey, eventKey });
} catch (e) {
  // Misconfiguration (including the production refusal) is exit 2, not a failed check.
  console.error(`internal-action-smoke: ${e instanceof Error ? e.message : String(e)}`);
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
