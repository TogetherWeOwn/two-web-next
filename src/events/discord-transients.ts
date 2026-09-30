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

const API = "https://discord.com/api/v10";

/** Discord guild scheduled-event statuses we show: 1 scheduled, 2 active. */
const LIVE_STATUSES = new Set([1, 2]);

/** Legacy: the source drops anything scheduled more than 90 days out. */
const HORIZON_MS = 90 * 86_400_000;

export interface DiscordEventsSource {
  /** Scheduled/active guild events (display-only transients). */
  upcoming(now?: Date): Promise<DiscordTransient[]>;
  /** True when the read behind `upcoming` failed — drives the error state. */
  lastReadFailed(): boolean;
}

type GuildScheduledEvent = {
  id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  status?: number;
  entity_metadata?: { location?: string | null } | null;
};

function toTransient(row: GuildScheduledEvent): DiscordTransient | null {
  const startsAt = new Date(row.scheduled_start_time);
  if (Number.isNaN(startsAt.getTime())) return null;
  const ends = row.scheduled_end_time == null ? null : new Date(row.scheduled_end_time);
  if (ends && Number.isNaN(ends.getTime())) return null;
  return {
    discordId: row.id,
    status: row.status === 2 ? "active" : "scheduled",
    title: row.name,
    description: row.description ?? null,
    location: row.entity_metadata?.location ?? null,
    startsAt,
    // Preserve no-end voice/stage events; Discord's live status is their boundary.
    endsAt: ends,
  };
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
      try {
        const res = await fetch(`${API}/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`, {
          headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
        if (!res.ok) {
          failed = true;
          return [];
        }
        const rows = (await res.json()) as GuildScheduledEvent[];
        if (!Array.isArray(rows)) {
          failed = true;
          return [];
        }
        const horizon = now.getTime() + HORIZON_MS;
        return rows
          .filter((r) => LIVE_STATUSES.has(r.status ?? 1) && r.id && r.name)
          .map(toTransient)
          .filter((t): t is DiscordTransient => t !== null && t.startsAt.getTime() <= horizon);
      } catch {
        failed = true;
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
  return (env as EnvWithDiscord).DISCORD_EVENTS ?? liveDiscordEventsSource(env);
}
