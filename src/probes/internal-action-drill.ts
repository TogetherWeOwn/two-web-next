// Staging-only drill for the queued CallInternalAction job (docs/parity.md §6;
// TOG-11706. CLI: bin/internal-action-drill.mjs, modeled on
// bin/internal-action-smoke.mjs and the smoke probe in ./bot-smoke).
//
// Production web never dispatches CallInternalAction — it is drill-only — so
// there is no web route to exercise. The drill invokes the queued handler
// SHAPE directly: the real producers (dispatchAnnouncement/dispatchRoleAssign
// in ../jobs/call-internal-action) mint the carriers into a capturing queue,
// then the real consumer (handleCallInternalAction, at the attempts=1 the
// queue would deliver first) runs each message against the staging bot through
// the caller-supplied client. No web route dispatch, no queue infra, no
// redirects. Only role.assign/announcement.post are drilled: those are the two
// actions CallInternalAction handles (event.upsert belongs to SyncEventToDiscord).
//
// Safety: two independent refusals before anything runs. resolveDrillTarget
// reuses the smoke's stagingEndpoint guard for BOT_ENDPOINT_URL (the entire
// production bot hostname refused, a valid BOT_PRODUCTION_URL mandatory), and
// resolveDrillWebOrigin refuses the production web apex for APP_URL. Secrets
// stay in the caller's environment; nothing here logs bodies or secrets —
// check details carry outcomes and a single-use carrier UUID only.

import { validateAnnouncement, validateRoleAssign } from "../bot/client-validation";
import {
  dispatchAnnouncement,
  dispatchRoleAssign,
  handleCallInternalAction,
} from "../jobs/call-internal-action";
import type { BotClient, QueueMessage } from "../jobs/types";
import { BotTerminalError } from "../jobs/types";
import type { Outcome } from "../jobs/sync-event";
import { stagingEndpoint } from "./bot-smoke";
import { derivePayloadAt, deriveUuid, validateRunId } from "./run-identity";

export type DrillArgs = { discordId: string; roleKey: string; channelKey: string; runId?: string };

/**
 * Stable machine IDs for the drill checks, shared by the plan the CLI prints
 * and the report the run produces. Labels are human text and may be reworded;
 * IDs are the contract agent callers match on.
 */
export const DRILL_CHECK_IDS = {
  roleCarrier: "role-assign-null-carrier",
  announcementCarrier: "announcement-uuid-carrier",
  roleHandled: "role-assign-handled",
  announcementHandled: "announcement-post-handled",
} as const;

export type DrillCheck = { id: string; label: string; ok: boolean; detail: string };

export type DrillPlanCheck = { id: string; label: string };

export type DrillReport = { checks: DrillCheck[]; failures: string[]; ok: boolean };

export type DrillEnv = {
  BOT_ENDPOINT_URL?: string;
  BOT_PRODUCTION_URL?: string;
  APP_URL?: string;
};

// Production web apex. Canonical definition: src/headers.ts PRODUCTION_APEX
// (the staging-noindex half of the nginx map). Anything else admitted as the
// drill's APP_URL is staging, a preview, or dev — never production.
const PRODUCTION_APEX = "togetherweown.com";

/**
 * Admit an explicit non-production web origin for the drill. Throws
 * BotTerminalError (exit 2: misconfigured) when APP_URL is missing,
 * malformed, or names the production apex. A bare subdomain of the apex
 * (next.togetherweown.com) is staging and is admitted; only the apex itself
 * is refused.
 */
export function resolveDrillWebOrigin(rawAppUrl: string | undefined): string {
  if (!rawAppUrl || rawAppUrl.trim() === "") {
    throw new BotTerminalError(
      "APP_URL is missing: the drill runs against the staging web origin only — set APP_URL explicitly (e.g. https://next.togetherweown.com).",
    );
  }
  let url: URL;
  try {
    url = new URL(rawAppUrl.trim());
  } catch {
    throw new BotTerminalError("APP_URL must be a valid HTTP(S) URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BotTerminalError(
      "APP_URL must be an HTTP(S) URL without credentials, query or fragment.",
    );
  }
  // DNS names are case-insensitive, and a trailing root dot names the same host.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === PRODUCTION_APEX) {
    throw new BotTerminalError(
      "refusing: APP_URL targets the production web host. The drill targets staging only.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/** Resolve both drill targets, refusing production on either side. */
export function resolveDrillTarget(env: DrillEnv): { botUrl: string; webOrigin: string } {
  return {
    botUrl: stagingEndpoint(env.BOT_ENDPOINT_URL, env.BOT_PRODUCTION_URL),
    webOrigin: resolveDrillWebOrigin(env.APP_URL),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreparedDrillRun = {
  roleAssignment: { userId: string; roleKey: string };
  announcement: { channelKey: string; body: string };
};

/**
 * Preflight both payloads before dispatching either carrier. Both the plan
 * and the run go through here, so a plan the CLI prints is a run the apply
 * would attempt. Throws BotTerminalError on an invalid input.
 */
function prepareDrillRun(args: DrillArgs, now: () => Date): PreparedDrillRun {
  // Like the smoke: a named run stamps the identity-derived instant, so a
  // repeated apply replays a byte-identical body. Unnamed runs keep the wall.
  const runId = args.runId;
  const at = runId === undefined ? now() : derivePayloadAt(runId);
  const roleAssignment = { userId: args.discordId, roleKey: args.roleKey };
  const announcement = {
    channelKey: args.channelKey,
    body: `TOG-11706 drill run. Ignore. ${at.toISOString()}`,
  };
  validateRoleAssign(roleAssignment);
  validateAnnouncement(announcement);
  return { roleAssignment, announcement };
}

/**
 * The checks an apply of these args would run, with the same stable IDs the
 * report carries. No dispatches, no client calls. Throws BotTerminalError on
 * an invalid input, like the run itself.
 */
export function planInternalActionDrill(
  args: DrillArgs,
  now: () => Date = () => new Date(),
): DrillPlanCheck[] {
  prepareDrillRun(args, now);
  return [
    { id: DRILL_CHECK_IDS.roleCarrier, label: "role.assign dispatched with a null carrier" },
    {
      id: DRILL_CHECK_IDS.announcementCarrier,
      label: "announcement.post dispatched with a UUID carrier",
    },
    { id: DRILL_CHECK_IDS.roleHandled, label: "role.assign handled" },
    { id: DRILL_CHECK_IDS.announcementHandled, label: "announcement.post handled" },
  ];
}

/**
 * Dispatch one role.assign and one announcement.post through the real
 * producers, then handle each captured message once (attempts=1) with the
 * real consumer against the caller's bot client. A transport throw inside a
 * call becomes a failed check (exit 1), never a crash; producer-shape and
 * target misconfiguration throw before any check (exit 2 at the CLI).
 * Never logs request bodies — the announcement text in particular stays out —
 * and never carries raw exception text — throws are class-only.
 *
 * With `args.runId`, the captured announcement carrier is replaced by the
 * run-derived one before handling, and the body stamp derives from the same
 * identity, so a repeated apply of the same plan replays the same carrier
 * with a byte-identical body. The producers are untouched: direct dispatches
 * still mint fresh keys.
 */
export async function runInternalActionDrill(
  bot: BotClient,
  args: DrillArgs,
  now: () => Date = () => new Date(),
): Promise<DrillReport> {
  const checks: DrillCheck[] = [];
  const failures: string[] = [];
  const check = (id: string, label: string, passed: boolean, detail: string) => {
    checks.push({ id, label, ok: passed, detail });
    if (!passed) failures.push(`${label}: ${detail}`);
  };
  const handle = async (id: string, label: string, run: () => Promise<Outcome>): Promise<void> => {
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (e) {
      // A throw the consumer did not absorb (transport, bug) becomes a failed
      // check, never a crash — the same contract as runBotSmoke. Terminal
      // answers never reach here: handleCallInternalAction converts them to
      // { failed }, and the CLI's assertConfigured owns the exit-2 path
      // before the drill starts. Class-only: the exception message can carry
      // tokens or personal data, so the report withholds the text.
      check(
        id,
        label,
        false,
        `threw ${e instanceof Error ? e.constructor.name : typeof e}: details withheld (transport error; see the bot logs)`,
      );
      return;
    }
    if ("done" in outcome) {
      check(id, label, true, "handled: done");
    } else if ("retryInSeconds" in outcome) {
      check(
        id,
        label,
        false,
        `retry requested in ${outcome.retryInSeconds}s after attempt 1: the queue would redeliver; the drill takes a single pass`,
      );
    } else {
      check(id, label, false, outcome.failed);
    }
  };

  if (args.runId !== undefined) validateRunId(args.runId);
  const { roleAssignment, announcement } = prepareDrillRun(args, now);

  // Dispatch through the real producers into a capturing queue: the carriers
  // below are exactly what the queue would deliver to the consumer.
  const sent: QueueMessage[] = [];
  const queue = { send: async (b: unknown): Promise<unknown> => void sent.push(b as QueueMessage) };
  await dispatchRoleAssign(queue, roleAssignment);
  await dispatchAnnouncement(queue, announcement);

  const [roleMsg, annMsg] = sent;
  if (roleMsg?.kind !== "role-assign" || annMsg?.kind !== "announcement") {
    throw new Error(
      "internal-action drill: producers did not capture one role-assign and one announcement",
    );
  }
  if (args.runId !== undefined) {
    // Resume the same carrier: the drill replays the run-derived key instead
    // of the freshly minted one. This overwrite is drill-local — the global
    // producer still mints a fresh key on every direct dispatch.
    annMsg.idempotencyKey = deriveUuid(args.runId, "drill:announcement");
  }

  // `unknown` on purpose: the member types idempotencyKey as literal null,
  // so reading it in the `!== null` branch would narrow to `never`. The
  // runtime value is what the guard is about.
  const roleCarrier: unknown = roleMsg.idempotencyKey;
  check(
    DRILL_CHECK_IDS.roleCarrier,
    "role.assign dispatched with a null carrier",
    roleCarrier === null,
    roleCarrier === null
      ? "idempotencyKey=null (natural idempotency, no replay key)"
      : `idempotencyKey=${String(roleCarrier)} (role.assign must send null)`,
  );
  const carrier = annMsg.idempotencyKey;
  check(
    DRILL_CHECK_IDS.announcementCarrier,
    "announcement.post dispatched with a UUID carrier",
    UUID_RE.test(carrier),
    UUID_RE.test(carrier)
      ? `carrier=${carrier}`
      : "carrier is not a UUID (a retry would post twice)",
  );

  await handle(DRILL_CHECK_IDS.roleHandled, "role.assign handled", () =>
    handleCallInternalAction(roleMsg, 1, bot),
  );
  await handle(DRILL_CHECK_IDS.announcementHandled, "announcement.post handled", () =>
    handleCallInternalAction(annMsg, 1, bot),
  );

  return { checks, failures, ok: failures.length === 0 };
}
