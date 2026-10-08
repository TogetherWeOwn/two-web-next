// Discord-native scheduled events for the calendar (legacy
// App\Support\Events\DiscordEventsSource, TOG-5168): the recurring community
// events live in the bot's database, so the page merges them in as
// display-only transients — expiring cache bytes, never canonical events,
// published, or handed to the write-back. Fail-open by contract: a dark collector is the error empty
// state on an otherwise-empty page, never a 500.
//
// One resolve per request (legacy render() resolve rule): the rows and the
// failure flag must come from the same instance — asking a second reader
// whether the first one's read failed is always "no".

import type { Env } from "../env";
import type { DiscordTransient } from "../islands/contracts";
import { admitScheduledEvent, type AdmittedScheduledEvent } from "./discord-transient-shape";
import {
  DISCORD_CACHE_FRESH_MS,
  type SnapshotCompletion,
  DISCORD_FAILURE_HOLD_MS,
  DISCORD_SNAPSHOT_MAX_BYTES,
  DISCORD_SNAPSHOT_MAX_ROWS,
  type DiscordSnapshotStore,
  discordSnapshotKey,
  encodeDiscordSnapshot,
  usableDiscordSnapshot,
} from "./discord-snapshot";
import { postgresDiscordSnapshotStore } from "./discord-snapshot-postgres";

export {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
} from "./discord-snapshot";

const API = "https://discord.com/api/v10";
const SAFE_SNAPSHOT_SQLSTATES = ["42501", "42P01", "55P03", "57014"];

function safeSnapshotSqlState(error: unknown): string | undefined {
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof rawCode === "string" && SAFE_SNAPSHOT_SQLSTATES.includes(rawCode)
    ? rawCode
    : undefined;
}

/** Discord guild scheduled-event statuses we show: 1 scheduled, 2 active. */
const LIVE_STATUSES = new Set([1, 2]);

/** Legacy: the source drops anything scheduled more than 90 days out. */
const HORIZON_MS = 90 * 86_400_000;

/** One budget for headers and the entire body, so Discord cannot hold the calendar open. */
export const DISCORD_READ_DEADLINE_MS = 1000;

/**
 * Why one read failed, for diagnostics and shared retry eligibility. Never carries a message, URL, header
 * or body: a driver message can echo the bot token. `exception` is a fixed safe
 * error category. The error body is deliberately not read: a stalled one must not hold the page.
 */
export type ReadFailure = {
  reason: "deadline" | "status" | "aborted" | "no_body" | "invalid_payload" | "exception";
  status?: number;
  retryAfter?: number;
  exception?: string;
};

class DiscordReadError extends Error {
  constructor(readonly failure: ReadFailure) {
    super("DiscordReadFailure");
    this.name = "DiscordReadError";
  }
}

export interface DiscordEventsSource {
  /** Scheduled/active guild events (display-only transients). */
  upcoming(now?: Date): Promise<DiscordTransient[]>;
  /** True when the read behind `upcoming` failed — drives the error state. */
  lastReadFailed(): boolean;
  /** Sanitized internal metadata from this read, never reparsed from logs. */
  lastReadFailure?(): ReadFailure | null;
}

function toTransient(row: AdmittedScheduledEvent): DiscordTransient | null {
  // Legacy drops rows it cannot honestly place on the calendar
  // (DiscordEventsReaderTest "drops rows…"): a whitespace-only name is no
  // name — it would render a blank card and pollute search.
  if (!row.name.trim()) return null;
  const startsAt = new Date(row.scheduled_start_time);
  if (Number.isNaN(startsAt.getTime())) return null;
  const ends = row.scheduled_end_time == null ? null : new Date(row.scheduled_end_time);
  if (ends && Number.isNaN(ends.getTime())) return null;
  const transient: DiscordTransient = {
    discordId: row.id,
    status: row.status === 2 ? "active" : "scheduled",
    title: row.name,
    description: row.description,
    location: row.location,
    startsAt,
    // Preserve no-end voice/stage events; Discord's live status is their boundary.
    endsAt: ends,
  };
  try {
    // Malformed live rows are dropped alone; stored corruption rejects the whole snapshot.
    encodeDiscordSnapshot([transient]);
    return transient;
  } catch {
    return null;
  }
}

/** Numeric `retry-after` seconds from a 429; anything else is not worth logging. */
function retryAfterSeconds(res: Response): number | undefined {
  // `Number(null)` and `Number("")` are 0: an absent header must not log as "retry now".
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  // Only representable numeric delays are valid; no HTTP dates or infinity.
  return Number.isFinite(n) && n * 1000 <= 8_000_000_000_000_000 ? n : undefined;
}

/** One warn line per failed read: a silent error state cannot be told from an outage. */
function warnReadFailed(failure: ReadFailure, startedAt: number): void {
  console.warn("Discord scheduled-events read failed.", {
    ...failure,
    elapsedMs: Date.now() - startedAt,
  });
}

/**
 * The live reader: one GET of the guild's scheduled events per `upcoming()`
 * call, bot-token auth. Any failure — network, non-2xx, malformed rows — flips
 * `lastReadFailed` and returns an empty list; the page decides what that means.
 */
export function liveDiscordEventsSource(env: Env): DiscordEventsSource {
  let failed = false;
  let failure: ReadFailure | null = null;
  return {
    lastReadFailed: () => failed,
    lastReadFailure: () => failure && { ...failure },
    async upcoming(now = new Date()): Promise<DiscordTransient[]> {
      failed = false;
      failure = null;
      const startedAt = Date.now();
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DiscordReadError({ reason: "deadline" })),
          DISCORD_READ_DEADLINE_MS,
        );
      });
      const read = async (): Promise<unknown> => {
        const res = await fetch(`${API}/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`, {
          headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
          signal: controller.signal,
        });
        // A fetch adapter may ignore abort and deliver headers after we have returned.
        if (controller.signal.aborted) {
          void res.body?.cancel().catch(() => {});
          throw new DiscordReadError({ reason: "aborted" });
        }
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          throw new DiscordReadError({
            reason: "status",
            status: res.status,
            retryAfter: res.status === 429 ? retryAfterSeconds(res) : undefined,
          });
        }
        if (!res.body) throw new DiscordReadError({ reason: "no_body" });
        // Own the reader so a stalled body can be cancelled even if it ignores abort.
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let json = "";
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          // Cancellation resolves a pending read as done; discard its buffered JSON.
          if (controller.signal.aborted) throw new DiscordReadError({ reason: "aborted" });
          if (done) break;
          bytes += value.byteLength;
          if (bytes > DISCORD_SNAPSHOT_MAX_BYTES)
            throw new DiscordReadError({ reason: "invalid_payload" });
          json += decoder.decode(value, { stream: true });
        }
        return JSON.parse(json + decoder.decode()) as unknown;
      };
      try {
        const rows: unknown = await Promise.race([read(), deadline]);
        if (!Array.isArray(rows) || rows.length > DISCORD_SNAPSHOT_MAX_ROWS)
          throw new DiscordReadError({ reason: "invalid_payload" });
        const horizon = now.getTime() + HORIZON_MS;
        return rows
          .map(admitScheduledEvent)
          .filter(
            (r): r is AdmittedScheduledEvent => r !== null && LIVE_STATUSES.has(r.status ?? 1),
          )
          .map(toTransient)
          .filter((t): t is DiscordTransient => t !== null && t.startsAt.getTime() <= horizon);
      } catch (err) {
        controller.abort();
        // Cleanup must not extend the deadline if the stream's cancel hook hangs.
        void reader?.cancel().catch(() => {});
        failed = true;
        failure =
          err instanceof DiscordReadError
            ? err.failure
            : {
                reason: "exception",
                exception:
                  err instanceof TypeError
                    ? "TypeError"
                    : err instanceof SyntaxError
                      ? "SyntaxError"
                      : err instanceof Error
                        ? "Error"
                        : typeof err,
              };
        warnReadFailed(failure, startedAt);
        return [];
      } finally {
        clearTimeout(timer);
        reader?.releaseLock();
      }
    },
  };
}

/** Shared completed snapshots and atomic admission; the HTTP reader remains request-owned. */
export function cachedDiscordEventsSource(
  env: Env,
  inner: DiscordEventsSource = liveDiscordEventsSource(env),
  store: DiscordSnapshotStore = postgresDiscordSnapshotStore(env),
): DiscordEventsSource {
  let failed = false;
  return {
    lastReadFailed: () => failed,
    async upcoming(now = new Date()): Promise<DiscordTransient[]> {
      failed = false;
      try {
        const key = discordSnapshotKey(env);
        const claim = await store.claim(key);
        const claimReturnedAt = performance.now();
        const claimClockAnchor =
          typeof claim.nowQueryStartedAt === "number" &&
          Number.isFinite(claim.nowQueryStartedAt) &&
          claim.nowQueryStartedAt <= claimReturnedAt
            ? claim.nowQueryStartedAt
            : null;
        const snapshotAt = (at: number): typeof claim | null => {
          if (claimClockAnchor === null) {
            // A tokenless success without an anchor could expire before it reaches the caller.
            if (!claim.token && claim.succeededAt !== null) return null;
            return claim;
          }
          return { ...claim, now: claim.now + Math.max(0, at - claimClockAnchor) };
        };
        const claimAtReturn = snapshotAt(claimReturnedAt);
        let snapshot = claimAtReturn ?? claim;
        let liveRows: DiscordTransient[] | null = null;
        let completionFailed = false;
        let completionCode: string | undefined;
        if (claim.token) {
          let result: SnapshotCompletion = { retryMs: DISCORD_FAILURE_HOLD_MS };
          try {
            const rows = await inner.upcoming(now);
            if (!inner.lastReadFailed()) {
              result = { payload: encodeDiscordSnapshot(rows) };
              liveRows = rows;
            } else {
              const failure = inner.lastReadFailure?.();
              const retry = failure?.status === 429 ? failure.retryAfter : undefined;
              if (
                typeof retry === "number" &&
                Number.isFinite(retry) &&
                retry >= 0 &&
                retry * 1000 <= 8_000_000_000_000_000
              )
                result = { retryMs: Math.max(DISCORD_FAILURE_HOLD_MS, Math.ceil(retry * 1000)) };
            }
          } catch {
            // A throwing reader or rejected payload is a failed refresh, not a success.
          }
          try {
            snapshot = { ...(await store.complete(key, claim.token, result)), token: null };
          } catch (error) {
            completionFailed = true;
            completionCode = safeSnapshotSqlState(error);
            // Keep valid live data, or re-check stale age from the DB-clock query start.
            snapshot = {
              ...claim,
              ...(claimClockAnchor === null
                ? {}
                : { now: claim.now + Math.max(0, performance.now() - claimClockAnchor) }),
            };
          }
        }
        const claimCheckedNow = snapshotAt(performance.now());
        if (!claim.token && claimCheckedNow) snapshot = claimCheckedNow;
        const recent = completionFailed
          ? (liveRows ??
            (claimClockAnchor === null || claimCheckedNow === null
              ? null
              : usableDiscordSnapshot(claimCheckedNow)))
          : claim.token === null
            ? claimCheckedNow === null
              ? null
              : usableDiscordSnapshot(claimCheckedNow)
            : usableDiscordSnapshot(snapshot);
        failed = recent === null;
        // One bounded diagnostic per request, never a key, payload or error message.
        console.info("Discord snapshot outcome", {
          outcome: failed
            ? "cold"
            : snapshot.retryAt > snapshot.now
              ? "held"
              : snapshot.now - snapshot.succeededAt! < DISCORD_CACHE_FRESH_MS
                ? "fresh"
                : "stale",
          completionFailed,
          ...(completionCode ? { code: completionCode } : {}),
        });
        return recent ?? [];
      } catch (err) {
        // No unadmitted live read on storage/corruption failure. Only known SQLSTATE
        // codes may leave the store; never log the driver's message or other fields.
        failed = true;
        const code = safeSnapshotSqlState(err);
        console.warn("Discord snapshot outcome", { outcome: "error", code });
        return [];
      }
    },
  };
}

type EnvWithDiscord = Env & { DISCORD_EVENTS?: DiscordEventsSource };

/**
 * Resolve the source for this request. `DISCORD_EVENTS` is the test/dev seam
 * (like `ADMIN_DB`): injected fakes answer instead of the live read.
 */
export function discordEventsSource(env: Env): DiscordEventsSource {
  return (env as EnvWithDiscord).DISCORD_EVENTS ?? cachedDiscordEventsSource(env);
}
