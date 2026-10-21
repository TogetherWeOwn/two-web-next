// Live-against-staging QA for the bot's internal actions. Port of two-web
// app/Console/Commands/BotInternalActionSmoke.php (docs/parity.md §7), driven
// through the ported client in ../bot/client (which signs with ../bot/signer).
//
// Deliberate narrowing vs legacy: legacy also ran each action through the
// shipped queue job inline. Here the queue path (key minting, retry/backoff,
// replay-safety) is pinned by test/jobs.test.ts against fixtures, so the smoke
// exercises what fixtures cannot — the signer, the client and a real staging
// endpoint. The one retry that matters (same idempotency key, fresh nonce,
// asserting Idempotent-Replay and the same message id) is kept.
//
// Safety: this posts a REAL announcement to a throwaway channel and creates a
// REAL staging event. Both an explicit staging target and a valid production
// exclusion (BOT_PRODUCTION_URL) are mandatory. The entire production hostname
// is refused regardless of port. Nothing here reads production creds.

import {
  validateAnnouncement,
  validateEventUpsert,
  validateRoleAssign,
} from "../bot/client-validation";
import { BotTerminalError } from "../jobs/types";
import type { BotFailure } from "../jobs/types";
import type {
  AnnouncementResult,
  BotActionClient,
  EventUpsertResult,
  RoleAssignResult,
} from "../bot/client";
import { derivePayloadAt, deriveUuid, validateRunId } from "./run-identity";

export type SmokeArgs =
  | {
      announcementOnly?: false;
      discordId: string;
      roleKey: string;
      channelKey: string;
      eventKey: string;
      runId?: string;
    }
  // Receivers that expose announcement.post only (the two-bot-next staging
  // receiver, TOG-12973): skip role.assign and event.upsert, which they refuse.
  | { announcementOnly: true; channelKey: string; runId?: string };

/**
 * Stable machine IDs for the smoke checks, shared by the plan the CLI prints
 * and the report the run produces. Labels are human text and may be reworded;
 * IDs are the contract agent callers match on.
 */
export const SMOKE_CHECK_IDS = {
  roleAssign: "role-assign-ok",
  announcementPost: "announcement-post-ok",
  retry: "retry-ok",
  replayFlag: "retry-replay-flag",
  replayMessageId: "retry-message-id",
  eventUpsert: "event-upsert-ok",
} as const;

export type SmokeCheck = { id: string; label: string; ok: boolean; detail: string };

export type SmokePlanCheck = { id: string; label: string };

export type SmokeReport = { checks: SmokeCheck[]; failures: string[]; ok: boolean };

/**
 * Resolve the staging bot base URL, refusing production. Throws
 * BotTerminalError (exit 2: misconfigured) on a missing/malformed URL or when
 * it targets the production host named by `productionUrl`.
 */
export function stagingEndpoint(rawUrl: string | undefined, productionUrl?: string): string {
  if (!rawUrl || rawUrl.trim() === "") {
    throw new BotTerminalError(
      "Bot is not configured: BOT_ENDPOINT_URL is missing (staging bot URL).",
    );
  }
  const parse = (raw: string | undefined, name: string): URL => {
    let url: URL;
    try {
      url = new URL(raw?.trim() ?? "");
    } catch {
      throw new BotTerminalError(`${name} must be a valid HTTP(S) URL.`);
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
        `${name} must be an HTTP(S) URL without credentials, query or fragment.`,
      );
    }
    return url;
  };
  const target = parse(rawUrl, "BOT_ENDPOINT_URL");
  const production = parse(productionUrl, "BOT_PRODUCTION_URL");
  // DNS names are case-insensitive, and a trailing root dot names the same host.
  const hostname = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname(target) === hostname(production)) {
    throw new BotTerminalError(
      "refusing: BOT_ENDPOINT_URL targets the production bot host. The smoke targets the staging bot only.",
    );
  }
  return target.href.replace(/\/+$/, "");
}

type SmokeClient = Pick<BotActionClient, "assignRole" | "postAnnouncement" | "upsertEvent">;

type Answer = RoleAssignResult | AnnouncementResult | EventUpsertResult | BotFailure;

const ok = (a: Answer): a is RoleAssignResult | AnnouncementResult | EventUpsertResult =>
  a !== null && typeof a === "object" && (a as { ok: unknown }).ok === true;

function describe(a: Answer | null): string {
  if (a === null) return "no result — the call did not complete";
  if (!ok(a)) {
    return `refused ${a.status} ${a.code} retryable=${a.retryable ? "true" : "false"} request_id=${a.requestId ?? "(none)"}`;
  }
  if ("messageId" in a)
    return `message_id=${a.messageId} replayed=${a.replayed ? "true" : "false"} request_id=${a.requestId ?? "(none)"}`;
  if ("discordEventId" in a && "outcome" in a)
    return `outcome=${a.outcome} event_id=${a.discordEventId} request_id=${a.requestId ?? "(none)"}`;
  return `outcome=${(a as RoleAssignResult).outcome} request_id=${a.requestId ?? "(none)"}`;
}

type PreparedSmokeRun = {
  announcement: { channelKey: string; body: string };
  roleAssignment: { userId: string; roleKey: string } | null;
  event: {
    eventKey: string;
    name: string;
    startsAt: string;
    endsAt: string;
    location: string;
    description: string;
  } | null;
};

/**
 * Prepare and validate the entire chosen run before its first effect. Both
 * the plan and the run go through here, so a plan the CLI prints is a run the
 * apply would attempt. Throws BotTerminalError on an invalid input.
 */
function prepareSmokeRun(args: SmokeArgs, now: () => Date): PreparedSmokeRun {
  // A named run replays byte-identical payloads: the stamp derives from the
  // identity instead of the wall clock, so two applies a minute apart sign
  // the same bytes under the same carriers. Unnamed runs keep the wall clock.
  const runId = args.runId;
  const at = runId === undefined ? now() : derivePayloadAt(runId);
  const announcement = {
    channelKey: args.channelKey,
    body: `TOG-10112 smoke run. Ignore. ${at.toISOString()}`,
  };
  const roleAssignment = args.announcementOnly
    ? null
    : { userId: args.discordId, roleKey: args.roleKey };
  const event = args.announcementOnly
    ? null
    : {
        eventKey: args.eventKey,
        name: "TOG-10112 smoke event",
        startsAt: new Date(at.getTime() + 86_400_000).toISOString(),
        endsAt: new Date(at.getTime() + 90_000_000).toISOString(),
        location: "Smoke run - ignore",
        description: "Created by the two-web-next internal-action staging smoke",
      };
  validateAnnouncement(announcement);
  if (roleAssignment !== null) validateRoleAssign(roleAssignment);
  if (event !== null) validateEventUpsert(event);
  return { announcement, roleAssignment, event };
}

/**
 * The checks an apply of these args would run, with the same stable IDs the
 * report carries. No client calls, no clock reads beyond validation. Throws
 * BotTerminalError on an invalid input, like the run itself.
 */
export function planBotSmoke(
  args: SmokeArgs,
  now: () => Date = () => new Date(),
): SmokePlanCheck[] {
  const { roleAssignment, event } = prepareSmokeRun(args, now);
  const planned: SmokePlanCheck[] = [];
  if (roleAssignment !== null)
    planned.push({ id: SMOKE_CHECK_IDS.roleAssign, label: "role.assign is ok" });
  planned.push(
    { id: SMOKE_CHECK_IDS.announcementPost, label: "announcement.post is ok" },
    { id: SMOKE_CHECK_IDS.retry, label: "retry is ok" },
    { id: SMOKE_CHECK_IDS.replayFlag, label: "retry is flagged Idempotent-Replay" },
    { id: SMOKE_CHECK_IDS.replayMessageId, label: "retry returns the original message_id" },
  );
  if (event !== null)
    planned.push({ id: SMOKE_CHECK_IDS.eventUpsert, label: "event.upsert is ok" });
  return planned;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; errorClass: string };

// A transport throw is reported class-only: the exception message can carry
// tokens or personal data, so the report keeps the class (which names the
// failure shape) and withholds the text.
const threwDetail = (what: string, errorClass: string): string =>
  `${what} threw ${errorClass}: the call did not complete (transport error; see the bot logs for detail)`;

/**
 * Drive role.assign, announcement.post (+ same-key retry), event.upsert
 * against the staging bot (announcement.post and its retry only when
 * `args.announcementOnly`). BotTerminalError propagates (misconfigured: exit
 * 2); anything else a call throws becomes failed checks (exit 1). Never logs
 * request bodies — the announcement text in particular stays out of logs —
 * and never carries raw exception text — throws are class-only.
 *
 * With `args.runId`, both idempotency carriers and the payload stamp derive
 * from the identity, so a repeated apply of the same plan replays the same
 * announcement and event carriers with byte-identical payloads. Without one,
 * each run mints fresh carriers and stamps the wall clock.
 */
export async function runBotSmoke(
  client: SmokeClient,
  args: SmokeArgs,
  now: () => Date = () => new Date(),
): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  const failures: string[] = [];
  const check = (id: string, label: string, passed: boolean, detail: string) => {
    checks.push({ id, label, ok: passed, detail });
    if (!passed) failures.push(`${label}: ${detail}`);
  };
  const attempt = async <T>(call: () => Promise<T>): Promise<Attempt<T>> => {
    try {
      return { ok: true, value: await call() };
    } catch (e) {
      if (e instanceof BotTerminalError) throw e;
      return { ok: false, errorClass: e instanceof Error ? e.constructor.name : typeof e };
    }
  };

  if (args.runId !== undefined) validateRunId(args.runId);
  // Reuse these payloads below so a late invalid key cannot leave a partial run.
  const { announcement, roleAssignment, event } = prepareSmokeRun(args, now);

  // role.assign — natural idempotency, no key.
  if (roleAssignment !== null) {
    const role = await attempt(() => client.assignRole(roleAssignment));
    if (!role.ok) {
      check(
        SMOKE_CHECK_IDS.roleAssign,
        "role.assign is ok",
        false,
        threwDetail("role.assign", role.errorClass),
      );
    } else {
      check(SMOKE_CHECK_IDS.roleAssign, "role.assign is ok", ok(role.value), describe(role.value));
    }
  }

  // announcement.post — needs key. The same key retried must replay, not post twice.
  const key =
    args.runId === undefined ? crypto.randomUUID() : deriveUuid(args.runId, "smoke:announcement");
  const first = await attempt(() => client.postAnnouncement(announcement, key));
  if (!first.ok) {
    check(
      SMOKE_CHECK_IDS.announcementPost,
      "announcement.post is ok",
      false,
      threwDetail("announcement.post", first.errorClass),
    );
  } else {
    check(
      SMOKE_CHECK_IDS.announcementPost,
      "announcement.post is ok",
      ok(first.value),
      describe(first.value),
    );
  }
  const replay = await attempt(() => client.postAnnouncement(announcement, key));
  if (!replay.ok) {
    check(
      SMOKE_CHECK_IDS.retry,
      "retry is ok",
      false,
      threwDetail("announcement.post retried with the same idempotency key", replay.errorClass),
    );
    check(
      SMOKE_CHECK_IDS.replayFlag,
      "retry is flagged Idempotent-Replay",
      false,
      "the retry did not complete, so no replay flag was observed",
    );
    check(
      SMOKE_CHECK_IDS.replayMessageId,
      "retry returns the original message_id",
      false,
      "the retry did not complete, so no message id was observed",
    );
  } else {
    const answer = replay.value;
    check(SMOKE_CHECK_IDS.retry, "retry is ok", ok(answer), describe(answer));
    check(
      SMOKE_CHECK_IDS.replayFlag,
      "retry is flagged Idempotent-Replay",
      ok(answer) && (answer as AnnouncementResult).replayed === true,
      `replayed=${ok(answer) && (answer as AnnouncementResult).replayed ? "true" : "false"}`,
    );
    const firstId =
      first.ok && ok(first.value) ? (first.value as AnnouncementResult).messageId : null;
    const replayId = ok(answer) ? (answer as AnnouncementResult).messageId : null;
    check(
      SMOKE_CHECK_IDS.replayMessageId,
      "retry returns the original message_id",
      firstId !== null && firstId === replayId,
      `first=${firstId ?? "(none)"} retry=${replayId ?? "(none)"}`,
    );
  }

  if (event === null) return { checks, failures, ok: failures.length === 0 };

  // event.upsert — fresh event key per run by default, so a run creates rather than updates.
  const idempotencyKey =
    args.runId === undefined ? crypto.randomUUID() : deriveUuid(args.runId, "smoke:event");
  const result = await attempt(() => client.upsertEvent(event, idempotencyKey));
  if (!result.ok) {
    check(
      SMOKE_CHECK_IDS.eventUpsert,
      "event.upsert is ok",
      false,
      threwDetail("event.upsert", result.errorClass),
    );
  } else {
    check(
      SMOKE_CHECK_IDS.eventUpsert,
      "event.upsert is ok",
      ok(result.value),
      describe(result.value),
    );
  }

  return { checks, failures, ok: failures.length === 0 };
}
