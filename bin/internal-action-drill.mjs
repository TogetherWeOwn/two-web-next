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
// Modes: no mode flag or --dry-run prints an effect-free plan and exits 0 — no
// secrets needed, no fetch attempted, no queue carriers sent. The bare
// `--apply` flag runs the existing staging effects. `--run-id=<id>` names the
// run identity a repeated apply resumes under (same announcement carrier
// and body); `--json` renders the plan, report or error as one versioned
// JSON document. See docs/bot-probe-staging.md for the staging procedure.
//
// Safety: an apply posts a REAL announcement to a throwaway channel and
// performs a REAL staging role.assign — --channel-key must name a throwaway
// channel and the discord id must be a drill identity. Requires a valid
// BOT_PRODUCTION_URL and APP_URL; refuses the entire production bot hostname
// AND the production web apex, reaches only the admitted staging targets,
// and never follows redirects. Exit codes match the smoke: 0 every check
// passed (or a plan printed), 1 a check failed, 2 misconfigured. Secrets
// come from the environment only (never argv) and are never printed or logged.
import { createBotClient } from "../src/bot/client.ts";
import { BotTerminalError } from "../src/jobs/types.ts";
import {
  planInternalActionDrill,
  resolveDrillTarget,
  runInternalActionDrill,
} from "../src/probes/internal-action-drill.ts";
import { validateRunId } from "../src/probes/run-identity.ts";

import { parseInternalActionArgs } from "./internal-action-args.mjs";
import {
  ERROR_CODES,
  emitJson,
  errorDoc,
  nextFor,
  planDoc,
  reportDoc,
} from "./internal-action-output.mjs";

const TOOL = "internal-action-drill";

// `--json` decides error rendering too, so it is pre-scanned before parsing:
// even a run the parser refuses must still render its error as JSON.
const wantsJson = process.argv.slice(2).includes("--json");
const fail = (code, message) => {
  if (wantsJson) emitJson(errorDoc({ tool: TOOL, errorCode: code, message }));
  else console.error(`internal-action-drill: ${message}`);
  process.exit(2);
};

let args;
try {
  args = parseInternalActionArgs(process.argv.slice(2));
} catch (e) {
  fail(ERROR_CODES.INVALID_ARGUMENTS, e.message);
}
if (args.help) {
  console.log(args.usage);
  process.exit(0);
}
const { discordId, roleKey, channelKey, runId, apply } = args;

if (runId !== undefined) {
  try {
    validateRunId(runId);
  } catch (e) {
    fail(ERROR_CODES.INVALID_RUN_ID, e instanceof Error ? e.message : String(e));
  }
}

let targets;
try {
  targets = resolveDrillTarget(process.env);
} catch (e) {
  fail(ERROR_CODES.INVALID_TARGET, e instanceof Error ? e.message : String(e));
}

const probeArgs = { discordId, roleKey, channelKey, ...(runId === undefined ? {} : { runId }) };

if (!apply) {
  let planned;
  try {
    planned = planInternalActionDrill(probeArgs);
  } catch (e) {
    fail(ERROR_CODES.INVALID_ARGUMENTS, e instanceof BotTerminalError ? e.message : String(e));
  }
  if (wantsJson) {
    emitJson(
      planDoc({
        tool: TOOL,
        runId,
        target: new URL(targets.botUrl).origin,
        webOrigin: new URL(targets.webOrigin).origin,
        checks: planned,
      }),
    );
    process.exit(0);
  }
  console.log("internal action drill: plan (preview only, no effects)");
  console.log(`  bot     ${new URL(targets.botUrl).origin}`);
  console.log(`  web     ${new URL(targets.webOrigin).origin}`);
  console.log(
    runId === undefined
      ? "  run-id  (none: the carrier will be minted fresh for this run)"
      : `  run-id  ${runId}`,
  );
  console.log(`  checks  ${planned.length} planned`);
  for (const c of planned) console.log(`    - ${c.label}`);
  console.log("  next    re-run with --apply to execute this plan");
  console.log("");
  process.exit(0);
}

if (!wantsJson) {
  console.log("internal action drill (TOG-11706)");
  console.log(`  bot     ${new URL(targets.botUrl).origin}`);
  console.log(`  web     ${new URL(targets.webOrigin).origin}`);
  console.log("");
}

const bot = createBotClient({
  url: targets.botUrl,
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
  report = await runInternalActionDrill(bot, probeArgs);
} catch (e) {
  // Misconfiguration (including the production refusals) is exit 2, not a failed check.
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
  console.error(`internal-action-drill: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (wantsJson) {
  emitJson(
    reportDoc({
      tool: TOOL,
      runId,
      report,
      errorCode: ERROR_CODES.DRILL_CHECKS_FAILED,
    }),
  );
  process.exit(report.ok ? 0 : 1);
}

for (const c of report.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.detail}`);
console.log("");

if (!report.ok) {
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.error(`${report.failures.length} check(s) failed. NEEDS WORK`);
  console.error(`next: ${nextFor(ERROR_CODES.DRILL_CHECKS_FAILED)}`);
  process.exit(1);
}
console.log("PASS");
