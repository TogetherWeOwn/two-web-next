// Discord transients: the live reader (structural split of
// ./discord-transients; zero behavior change). One bot-token GET of the
// guild's scheduled events per `upcoming()` call under a single
// headers-and-body deadline; any failure flips `lastReadFailed` and returns
// an empty list.

import type { Env } from "../env";
import type { DiscordTransient } from "../islands/contracts";
import { admitScheduledEvent, type AdmittedScheduledEvent } from "./discord-transient-shape";
import {
  DISCORD_SNAPSHOT_MAX_BYTES,
  DISCORD_SNAPSHOT_MAX_ROWS,
  encodeDiscordSnapshot,
} from "./discord-snapshot";
import { parseRetryAfterSeconds } from "../jobs/retry-delay";
import {
  DISCORD_READ_DEADLINE_MS,
  type DiscordEventsSource,
  type ReadFailure,
} from "./discord-transients-types";

const API = "https://discord.com/api/v10";

/** Discord guild scheduled-event statuses we show: 1 scheduled, 2 active. */
const LIVE_STATUSES = new Set([1, 2]);

/** Legacy: the source drops anything scheduled more than 90 days out. */
const HORIZON_MS = 90 * 86_400_000;

class DiscordReadError extends Error {
  constructor(readonly failure: ReadFailure) {
    super("DiscordReadFailure");
    this.name = "DiscordReadError";
  }
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

/**
 * Bounded `retry-after` seconds from a 429; anything else is not worth
 * logging. Thin `Response` adapter over the one shared parser in
 * `src/jobs/retry-delay.ts` — the same mapping the Discord OAuth path and
 * the bot transport use.
 */
function retryAfterSeconds(res: Response): number | undefined {
  return parseRetryAfterSeconds(res.headers.get("retry-after"));
}

/** One warn line per failed read: a silent error state cannot be told from an outage. */
function warnReadFailed(failure: ReadFailure, startedAt: number): void {
  console.warn("Discord scheduled-events read failed.", {
    ...failure,
    elapsedMs: Date.now() - startedAt,
  });
}

/** Named configuration error for a malformed env guild id. Never echoes the value. */
export class DiscordGuildIdConfigError extends Error {
  constructor() {
    super("Invalid DISCORD_GUILD_ID configuration");
    this.name = "DiscordGuildIdConfigError";
  }
}

/**
 * Charset admission for the env-configured Discord guild id: ASCII digits
 * only, 1-20 characters, tested as-is with no trimming, coercion or
 * decoding. Refusal throws the named configuration error before any fetch.
 */
export function admitDiscordGuildId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    throw new DiscordGuildIdConfigError();
  }
  return value;
}

/**
 * The live reader: one GET of the guild's scheduled events per `upcoming()`
 * call, bot-token auth. Any failure — network, non-2xx, malformed rows — flips
 * `lastReadFailed` and returns an empty list; the page decides what that means.
 */
export function liveDiscordEventsSource(env: Env): DiscordEventsSource {
  // Admit once at read time: a malformed guild id throws the named
  // configuration error before any credentialed request is constructed.
  const guildId = admitDiscordGuildId(env.DISCORD_GUILD_ID);
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
        const res = await fetch(`${API}/guilds/${encodeURIComponent(guildId)}/scheduled-events`, {
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
