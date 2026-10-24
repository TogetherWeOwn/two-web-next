#!/usr/bin/env node
// Live-against-staging QA for the bot's internal actions (docs/parity.md §7,
// W16 cutover rehearsal). Port of two-web `php artisan bot:internal-action-smoke`.
//
//   BOT_ENDPOINT_URL=<staging bot> BOT_SHARED_SECRET=<secret> BOT_KEY_ID=<key id> \
//     node --import ./bin/ts-hook.mjs bin/internal-action-smoke.mjs \
//       --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway> [--event-key=<key>]
//
// --announcement-only: for a receiver that supports announcement.post alone.
// Runs announcement.post + the same-key retry and skips role.assign and
// event.upsert, so only --channel-key is required:
//   ... bin/internal-action-smoke.mjs --announcement-only --channel-key=<throwaway>
//
// Modes: no mode flag or --dry-run prints an effect-free plan and exits 0 — no
// secrets needed, no fetch attempted, no queue carriers sent. The bare
// `--apply` flag runs the existing staging effects. `--run-id=<id>` names the
// run identity a repeated apply resumes under (same carriers, same generated
// event key, byte-identical payloads); `--json` renders the plan, report or
// error as one versioned JSON document. See docs/bot-probe-staging.md for
// the staging procedure.
//
// Safety: an apply posts a REAL announcement to a throwaway channel and
// creates a REAL staging event — --channel-key must name a throwaway
// channel. The script requires valid BOT_PRODUCTION_URL and
// BOT_ENDPOINT_URL, refuses the entire production hostname, and never
// follows redirects. Exit codes match legacy: 0 every check passed (or a
// plan printed), 1 a check failed, 2 misconfigured. Secrets come from the
// environment only (never argv) and are never printed or logged.
import { createBotClient } from "../src/bot/client.ts";
import { BotTerminalError } from "../src/jobs/types.ts";
import { planBotSmoke, runBotSmoke, stagingEndpoint } from "../src/probes/bot-smoke.ts";
import { deriveEventKey, validateRunId } from "../src/probes/run-identity.ts";

import { parseInternalActionArgs } from "./internal-action-args.mjs";
import {
  ERROR_CODES,
  emitJson,
  errorDoc,
  nextFor,
  planDoc,
  reportDoc,
} from "./internal-action-output.mjs";

const TOOL = "internal-action-smoke";

// `--json` decides error rendering too, so it is pre-scanned before parsing:
// even a run the parser refuses must still render its error as JSON.
const wantsJson = process.argv.slice(2).includes("--json");
const fail = (code, message) => {
  if (wantsJson) emitJson(errorDoc({ tool: TOOL, errorCode: code, message }));
  else console.error(`internal-action-smoke: ${message}`);
  process.exit(2);
};

let args;
try {
  args = parseInternalActionArgs(process.argv.slice(2), true);
} catch (e) {
  fail(ERROR_CODES.INVALID_ARGUMENTS, e.message);
}
if (args.help) {
  console.log(args.usage);
  process.exit(0);
}
const { discordId, roleKey, channelKey, announcementOnly, runId, apply } = args;

if (runId !== undefined) {
  try {
    validateRunId(runId);
  } catch (e) {
    fail(ERROR_CODES.INVALID_RUN_ID, e instanceof Error ? e.message : String(e));
  }
}

let url;
try {
  url = stagingEndpoint(process.env.BOT_ENDPOINT_URL, process.env.BOT_PRODUCTION_URL);
} catch (e) {
  fail(ERROR_CODES.INVALID_TARGET, e instanceof Error ? e.message : String(e));
}

// The effective event key: supplied, or generated — stably per run identity
// so a repeated apply of the same plan reuses the same key.
const eventKey = announcementOnly
  ? undefined
  : (args.eventKey ??
    (runId === undefined ? `tog10112-${crypto.randomUUID().slice(0, 12)}` : deriveEventKey(runId)));
const probeArgs = announcementOnly
  ? { announcementOnly: true, channelKey, ...(runId === undefined ? {} : { runId }) }
  : { discordId, roleKey, channelKey, eventKey, ...(runId === undefined ? {} : { runId }) };

if (!apply) {
  let planned;
  try {
    planned = planBotSmoke(probeArgs);
  } catch (e) {
    fail(ERROR_CODES.INVALID_ARGUMENTS, e instanceof BotTerminalError ? e.message : String(e));
  }
  if (wantsJson) {
    emitJson(
      planDoc({
        tool: TOOL,
        runId,
        target: new URL(url).origin,
        scope: announcementOnly ? "announcement-only" : "full",
        ...(eventKey === undefined ? {} : { eventKey }),
        checks: planned,
      }),
    );
    process.exit(0);
  }
  console.log("internal actions smoke: plan (preview only, no effects)");
  console.log(`  target  ${new URL(url).origin}`);
  console.log(
    announcementOnly
      ? "  scope   announcement-only (role.assign and event.upsert skipped)"
      : "  scope   full run (role.assign, announcement.post, event.upsert)",
  );
  console.log(
    runId === undefined
      ? "  run-id  (none: carriers will be minted fresh for this run)"
      : `  run-id  ${runId}`,
  );
  if (eventKey !== undefined) console.log(`  event-key ${eventKey}`);
  console.log(`  checks  ${planned.length} planned`);
  for (const c of planned) console.log(`    - ${c.label}`);
  console.log("  next    re-run with --apply to execute this plan");
  console.log("");
  process.exit(0);
}

if (!wantsJson) {
  console.log("internal actions smoke (TOG-10112)");
  console.log(`  target  ${new URL(url).origin}`);
  if (announcementOnly)
    console.log("  scope   announcement-only (role.assign and event.upsert skipped)");
  console.log("");
}

const bot = createBotClient({
  url,
  secret: process.env.BOT_SHARED_SECRET,
  keyId: process.env.BOT_KEY_ID,
  // --json owns stdout: transport diagnostics go to stderr.
  stderrDiagnostics: wantsJson,
});
try {
  bot.assertConfigured();
} catch (e) {
  fail(ERROR_CODES.MISSING_CONFIGURATION, e instanceof Error ? e.message : String(e));
}

let report;
try {
  report = await runBotSmoke(bot, probeArgs);
} catch (e) {
  // Misconfiguration (including the production refusal) is exit 2, not a failed check.
  if (e instanceof BotTerminalError) {
    fail(ERROR_CODES.INVALID_ARGUMENTS, e.message);
  }
  if (wantsJson) {
    emitJson(
      errorDoc({
        tool: TOOL,
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        message: "the probe failed unexpectedly; re-run without --apply to preview.",
      }),
    );
    process.exit(1);
  }
  console.error(`internal-action-smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (wantsJson) {
  emitJson(
    reportDoc({
      tool: TOOL,
      runId,
      report,
      errorCode: ERROR_CODES.SMOKE_CHECKS_FAILED,
    }),
  );
  process.exit(report.ok ? 0 : 1);
}

for (const c of report.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.detail}`);
console.log("");

if (!report.ok) {
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.error(`${report.failures.length} check(s) failed. NEEDS WORK`);
  console.error(`next: ${nextFor(ERROR_CODES.SMOKE_CHECKS_FAILED)}`);
  process.exit(1);
}
console.log("PASS");
