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

import { BotTerminalError } from "../jobs/types";
import type { BotFailure } from "../jobs/types";
import type {
  AnnouncementResult,
  BotActionClient,
  EventUpsertResult,
  RoleAssignResult,
} from "../bot/client";

export type SmokeArgs =
  | {
      announcementOnly?: false;
      discordId: string;
      roleKey: string;
      channelKey: string;
      eventKey: string;
    }
  // Receivers that expose announcement.post only (the two-bot-next staging
  // receiver, TOG-12973): skip role.assign and event.upsert, which they refuse.
  | { announcementOnly: true; channelKey: string };

export type SmokeCheck = { label: string; ok: boolean; detail: string };

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

/**
 * Drive role.assign, announcement.post (+ same-key retry), event.upsert
 * against the staging bot (announcement.post and its retry only when
 * `args.announcementOnly`). BotTerminalError propagates (misconfigured: exit
 * 2); anything else a call throws becomes a failed check (exit 1). Never logs
 * request bodies — the announcement text in particular stays out of logs.
 */
export async function runBotSmoke(
  client: SmokeClient,
  args: SmokeArgs,
  now: () => Date = () => new Date(),
): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  const failures: string[] = [];
  const check = (label: string, passed: boolean, detail: string) => {
    checks.push({ label, ok: passed, detail });
    if (!passed) failures.push(`${label}: ${detail}`);
  };
  const attempt = async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof BotTerminalError) throw e;
      failures.push(
        `${label} threw ${e instanceof Error ? e.constructor.name : typeof e}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  };

  // role.assign — natural idempotency, no key.
  if (!args.announcementOnly) {
    const { discordId, roleKey } = args;
    const role = await attempt("role.assign", () =>
      client.assignRole({ userId: discordId, roleKey }),
    );
    if (role !== null) check("role.assign is ok", ok(role), describe(role));
  }

  // announcement.post — needs key. The same key retried must replay, not post twice.
  const key = crypto.randomUUID();
  const announcement = {
    channelKey: args.channelKey,
    body: `TOG-10112 smoke run. Ignore. ${now().toISOString()}`,
  };
  const first = await attempt("announcement.post", () =>
    client.postAnnouncement(announcement, key),
  );
  if (first !== null) check("announcement.post is ok", ok(first), describe(first));
  const replay = await attempt("announcement.post retried with the same idempotency key", () =>
    client.postAnnouncement(announcement, key),
  );
  if (replay !== null) {
    check("retry is ok", ok(replay), describe(replay));
    check(
      "retry is flagged Idempotent-Replay",
      ok(replay) && (replay as AnnouncementResult).replayed === true,
      `replayed=${ok(replay) && (replay as AnnouncementResult).replayed ? "true" : "false"}`,
    );
    const firstId = first && ok(first) ? (first as AnnouncementResult).messageId : null;
    const replayId = replay && ok(replay) ? (replay as AnnouncementResult).messageId : null;
    check(
      "retry returns the original message_id",
      firstId !== null && firstId === replayId,
      `first=${firstId ?? "(none)"} retry=${replayId ?? "(none)"}`,
    );
  }

  if (args.announcementOnly) return { checks, failures, ok: failures.length === 0 };

  // event.upsert — fresh event key per run by default, so a run creates rather than updates.
  const { eventKey } = args;
  const event = await attempt("event.upsert", () =>
    client.upsertEvent(
      {
        eventKey,
        name: "TOG-10112 smoke event",
        startsAt: new Date(now().getTime() + 86_400_000).toISOString(),
        endsAt: new Date(now().getTime() + 90_000_000).toISOString(),
        location: "Smoke run - ignore",
        description: "Created by the two-web-next internal-action staging smoke",
      },
      crypto.randomUUID(),
    ),
  );
  if (event !== null) check("event.upsert is ok", ok(event), describe(event));

  return { checks, failures, ok: failures.length === 0 };
}
