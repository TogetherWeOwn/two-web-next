// Discord-native scheduled events for the calendar (legacy
// App\Support\Events\DiscordEventsSource, TOG-5168): the recurring community
// events live in the bot's database, so the page merges them in as
// display-only transients — never persisted, never published, never handed to
// the write-back. Fail-open by contract: a dark collector is the error empty
// state on an otherwise-empty page, never a 500.
//
// One resolve per request (legacy render() resolve rule): the rows and the
// failure flag must come from the same instance — asking a second reader
// whether the first one's read failed is always "no".

import type { Env } from "../env";
import type { DiscordTransient } from "../islands/contracts";
import { admitScheduledEvent, type AdmittedScheduledEvent } from "./discord-transient-shape";

const API = "https://discord.com/api/v10";

/** Discord guild scheduled-event statuses we show: 1 scheduled, 2 active. */
const LIVE_STATUSES = new Set([1, 2]);

/** Legacy: the source drops anything scheduled more than 90 days out. */
const HORIZON_MS = 90 * 86_400_000;

/** One budget for headers and the entire body, so Discord cannot hold the calendar open. */
export const DISCORD_READ_DEADLINE_MS = 1000;

/**
 * Why one read failed, for the warn line only. Never carries a message, URL, header
 * or body: a driver message can echo the bot token. `exception` is the error class
 * name. The error body is deliberately not read: a stalled one must not hold the page.
 */
type ReadFailure = {
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
  return {
    discordId: row.id,
    status: row.status === 2 ? "active" : "scheduled",
    title: row.name,
    description: row.description,
    location: row.location,
    startsAt,
    // Preserve no-end voice/stage events; Discord's live status is their boundary.
    endsAt: ends,
  };
}

/** Numeric `retry-after` seconds from a 429; anything else is not worth logging. */
function retryAfterSeconds(res: Response): number | undefined {
  // `Number(null)` and `Number("")` are 0: an absent header must not log as "retry now".
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** One warn line per failed read: a silent error state cannot be told from an outage. */
function warnReadFailed(failure: ReadFailure, startedAt: number): void {
  console.warn("Discord scheduled-events read failed; rendering the error state.", {
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
  return {
    lastReadFailed: () => failed,
    async upcoming(now = new Date()): Promise<DiscordTransient[]> {
      failed = false;
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
            retryAfter: retryAfterSeconds(res),
          });
        }
        if (!res.body) throw new DiscordReadError({ reason: "no_body" });
        // Own the reader so a stalled body can be cancelled even if it ignores abort.
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let json = "";
        for (;;) {
          const { done, value } = await reader.read();
          // Cancellation resolves a pending read as done; discard its buffered JSON.
          if (controller.signal.aborted) throw new DiscordReadError({ reason: "aborted" });
          if (done) break;
          json += decoder.decode(value, { stream: true });
        }
        return JSON.parse(json + decoder.decode()) as unknown;
      };
      try {
        const rows: unknown = await Promise.race([read(), deadline]);
        if (!Array.isArray(rows)) {
          failed = true;
          warnReadFailed({ reason: "invalid_payload" }, startedAt);
          return [];
        }
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
        warnReadFailed(
          err instanceof DiscordReadError
            ? err.failure
            : { reason: "exception", exception: err instanceof Error ? err.name : typeof err },
          startedAt,
        );
        return [];
      } finally {
        clearTimeout(timer);
        reader?.releaseLock();
      }
    },
  };
}

/**
 * Discord rate-limits the scheduled-events route hard: on staging every second
 * page view in a burst got a 429 with `retry-after` of 1-10 s, and a 429 on an
 * otherwise-empty page is the error state. The legacy reader cached for ten
 * minutes (DiscordEventsReader::CACHE_SECONDS), so a page view never called out.
 * Same idea here, kept per isolate: plain data in module scope, never a shared
 * promise or stream (a Worker cannot await another request's I/O).
 */
export const DISCORD_CACHE_FRESH_MS = 60_000;
/** A failed read serves the last good one this long, matching the legacy ten-minute cache. */
export const DISCORD_CACHE_STALE_MS = 10 * 60_000;
/** After a failed read, leave Discord alone at least as long as its longest observed `retry-after`. */
export const DISCORD_FAILURE_HOLD_MS = 10_000;

interface CachedGuild {
  rows: DiscordTransient[] | null;
  readAt: number;
  failedAt: number | null;
}

const cachedGuilds = new Map<string, CachedGuild>();

/** Test seam: the cache is module state, so suites that mock `fetch` reset it between cases. */
export function resetDiscordEventsCache(): void {
  cachedGuilds.clear();
}

/**
 * The live reader behind a per-isolate cache: a fresh read is served without
 * calling Discord, a failed read serves the last good rows while they are
 * still recent (no error state: the data is real, just a few minutes old), and
 * a failure holds Discord off for a few seconds so a burst cannot keep earning
 * 429s. With nothing recent to serve, the failure is the error state, as before.
 */
export function cachedDiscordEventsSource(
  env: Env,
  inner: DiscordEventsSource = liveDiscordEventsSource(env),
  clock: () => number = () => Date.now(),
): DiscordEventsSource {
  let failed = false;
  return {
    lastReadFailed: () => failed,
    async upcoming(now = new Date()): Promise<DiscordTransient[]> {
      failed = false;
      const key = env.DISCORD_GUILD_ID;
      const entry = cachedGuilds.get(key);
      const t = clock();
      const recent =
        entry?.rows && t - entry.readAt < DISCORD_CACHE_STALE_MS ? [...entry.rows] : null;
      if (entry?.rows && recent && t - entry.readAt < DISCORD_CACHE_FRESH_MS) return recent;
      const held = entry?.failedAt != null && t - entry.failedAt < DISCORD_FAILURE_HOLD_MS;
      if (!held) {
        const rows = await inner.upcoming(now);
        if (!inner.lastReadFailed()) {
          cachedGuilds.set(key, { rows, readAt: clock(), failedAt: null });
          return [...rows];
        }
        // Race: another view may have filled the cache while this read was in
        // flight. Re-read instead of writing back the pre-await snapshot — a
        // 429 landing after a 200 would wipe the good rows and hold down the
        // error state for ten seconds despite a good read a second earlier.
        const latest = cachedGuilds.get(key);
        const latestRecent =
          latest?.rows && clock() - latest.readAt < DISCORD_CACHE_STALE_MS
            ? [...latest.rows]
            : null;
        cachedGuilds.set(key, {
          rows: latest?.rows ?? null,
          readAt: latest?.readAt ?? 0,
          failedAt: clock(),
        });
        if (latestRecent) return latestRecent;
      }
      if (recent) return recent;
      failed = true;
      return [];
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
