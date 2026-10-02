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

import { dispatchAnnouncement, dispatchRoleAssign, handleCallInternalAction } from "../jobs/call-internal-action";
import type { BotClient, QueueMessage } from "../jobs/types";
import { BotTerminalError } from "../jobs/types";
import type { Outcome } from "../jobs/sync-event";
import { stagingEndpoint } from "./bot-smoke";

export type DrillArgs = { discordId: string; roleKey: string; channelKey: string };

export type DrillCheck = { label: string; ok: boolean; detail: string };

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
    throw new BotTerminalError("APP_URL must be an HTTP(S) URL without credentials, query or fragment.");
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

/**
 * Dispatch one role.assign and one announcement.post through the real
 * producers, then handle each captured message once (attempts=1) with the
 * real consumer against the caller's bot client. A transport throw inside a
 * call becomes a failed check (exit 1), never a crash; producer-shape and
 * target misconfiguration throw before any check (exit 2 at the CLI).
 * Never logs request bodies — the announcement text in particular stays out.
 */
export async function runInternalActionDrill(
  bot: BotClient,
  args: DrillArgs,
  now: () => Date = () => new Date(),
): Promise<DrillReport> {
  const checks: DrillCheck[] = [];
  const failures: string[] = [];
  const check = (label: string, passed: boolean, detail: string) => {
    checks.push({ label, ok: passed, detail });
    if (!passed) failures.push(`${label}: ${detail}`);
  };
  const handle = async (label: string, run: () => Promise<Outcome>): Promise<void> => {
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (e) {
      // A throw the consumer did not absorb (transport, bug) becomes a failed
      // check, never a crash — the same contract as runBotSmoke. Terminal
      // answers never reach here: handleCallInternalAction converts them to
      // { failed }, and the CLI's assertConfigured owns the exit-2 path
      // before the drill starts.
      failures.push(
        `${label} threw ${e instanceof Error ? e.constructor.name : typeof e}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if ("done" in outcome) {
      check(label, true, "handled: done");
    } else if ("retryInSeconds" in outcome) {
      check(
        label,
        false,
        `retry requested in ${outcome.retryInSeconds}s after attempt 1: the queue would redeliver; the drill takes a single pass`,
      );
    } else {
      check(label, false, outcome.failed);
    }
  };

  // Dispatch through the real producers into a capturing queue: the carriers
  // below are exactly what the queue would deliver to the consumer.
  const sent: QueueMessage[] = [];
  const queue = { send: async (b: unknown): Promise<unknown> => void sent.push(b as QueueMessage) };
  await dispatchRoleAssign(queue, { userId: args.discordId, roleKey: args.roleKey });
  await dispatchAnnouncement(queue, {
    channelKey: args.channelKey,
    body: `TOG-11706 drill run. Ignore. ${now().toISOString()}`,
  });

  const [roleMsg, annMsg] = sent;
  if (roleMsg?.kind !== "role-assign" || annMsg?.kind !== "announcement") {
    throw new Error("internal-action drill: producers did not capture one role-assign and one announcement");
  }

  // `unknown` on purpose: the member types idempotencyKey as literal null,
  // so reading it in the `!== null` branch would narrow to `never`. The
  // runtime value is what the guard is about.
  const roleCarrier: unknown = roleMsg.idempotencyKey;
  check(
    "role.assign dispatched with a null carrier",
    roleCarrier === null,
    roleCarrier === null
      ? "idempotencyKey=null (natural idempotency, no replay key)"
      : `idempotencyKey=${String(roleCarrier)} (role.assign must send null)`,
  );
  const carrier = annMsg.idempotencyKey;
  check(
    "announcement.post dispatched with a UUID carrier",
    UUID_RE.test(carrier),
    UUID_RE.test(carrier) ? `carrier=${carrier}` : "carrier is not a UUID (a retry would post twice)",
  );

  await handle("role.assign handled", () => handleCallInternalAction(roleMsg, 1, bot));
  await handle("announcement.post handled", () => handleCallInternalAction(annMsg, 1, bot));

  return { checks, failures, ok: failures.length === 0 };
}
