import { discordFetch } from "./discord-http";

export function discordWidgetUrl(guildId: string | undefined): string | null {
  return typeof guildId === "string" && /^\d{10,25}$/.test(guildId)
    ? `https://discord.com/widget?id=${guildId}&theme=dark`
    : null;
}

// How long one widget verdict stands before a request schedules a re-probe.
export const DISCORD_WIDGET_VERDICT_TTL_MS = 60_000;

export type DiscordWidgetHealth = {
  /**
   * The iframe URL to render, or null for the static fallback. Synchronous:
   * it answers from the last verdict and never waits on Discord. A stale
   * verdict hands one background probe to `background` (the request's
   * waitUntil); without one, nothing is probed and the last verdict stands.
   */
  url(guildId: string | undefined, background?: (probe: Promise<void>) => void): string | null;
};

export type DiscordWidgetHealthDeps = { fetch?: typeof fetch; now?: () => number; ttlMs?: number };

/**
 * Per-isolate view of whether Discord is serving the guild widget. Optimistic
 * until a probe says otherwise: the iframe is lazy with fixed dimensions, so
 * a dead one costs a blank box, while a pessimistic default would hide the
 * preview on every cold isolate. The probe reads the public widget JSON for
 * the same guild (no member data, no cookies) under the shared Discord HTTP
 * budget. 2xx is up; 429 is no new information; any other status, a network
 * error or a timeout is down, which renders the static fallback instead.
 */
export function createDiscordWidgetHealth(deps: DiscordWidgetHealthDeps = {}): DiscordWidgetHealth {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DISCORD_WIDGET_VERDICT_TTL_MS;
  let verdict: { guildId: string; available: boolean; checkedAt: number } | null = null;
  let inflight: Promise<void> | null = null;

  async function probe(guildId: string): Promise<void> {
    const previous = verdict?.guildId === guildId ? verdict.available : true;
    let available: boolean;
    try {
      const res = await discordFetch(`https://discord.com/api/guilds/${guildId}/widget.json`, {}, deps.fetch);
      available = res.status === 429 ? previous : res.ok;
      if (!available && previous) console.warn("discord widget unavailable; rendering the join fallback", { status: res.status });
    } catch (error) {
      available = false;
      if (previous) console.warn("discord widget unavailable; rendering the join fallback", { exception: (error as Error).name });
    }
    verdict = { guildId, available, checkedAt: now() };
  }

  return {
    url(guildId, background) {
      const src = discordWidgetUrl(guildId);
      if (!src) return null;
      const current = verdict?.guildId === guildId ? verdict : null;
      if (background && !inflight && (!current || now() - current.checkedAt >= ttlMs)) {
        inflight = probe(guildId!).finally(() => { inflight = null; });
        background(inflight);
      }
      return current?.available === false ? null : src;
    },
  };
}

export const discordWidgetHealth = createDiscordWidgetHealth();
