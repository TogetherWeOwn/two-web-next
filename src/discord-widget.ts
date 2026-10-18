import { discordFetch } from "./discord-http";

export function discordWidgetUrl(guildId: string | undefined): string | null {
  return typeof guildId === "string" && /^\d{10,25}$/.test(guildId)
    ? `https://discord.com/widget?id=${guildId}&theme=dark`
    : null;
}

export type DiscordWidgetChannel = { id: string; name: string; position: number };
export type DiscordWidgetMember = { username: string; status: "online" | "idle" | "dnd" };
export type DiscordWidgetSnapshot = {
  guildId: string;
  name: string;
  inviteUrl: string | null;
  presenceCount: number;
  channels: DiscordWidgetChannel[];
  members: DiscordWidgetMember[];
  fetchedAt: number;
};

// How long one widget verdict stands before a request schedules a re-probe.
export const DISCORD_WIDGET_VERDICT_TTL_MS = 60_000;

// widget.json caps the member list at 100; enforce the same bound after
// dropping invalid rows so one hostile payload cannot grow the HTML.
export const DISCORD_WIDGET_MAX_MEMBERS = 100;
// Voice/stage lists are small; cap the rendered channels for the same reason.
export const DISCORD_WIDGET_MAX_CHANNELS = 100;

function widgetInviteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^https:\/\/[^/?#@\s]+(?:[/?#]|$)/i.test(value) || /[\u0000-\u001f\u007f\\]/.test(value))
    return null;
  let parts: URL;
  try {
    parts = new URL(value);
  } catch {
    return null;
  }
  if (parts.protocol !== "https:" || parts.username || parts.password || parts.port) return null;
  if (
    !(
      (parts.hostname === "discord.gg" && /^\/[\w-]+$/.test(parts.pathname)) ||
      (parts.hostname === "discord.com" && /^\/invite\/[\w-]+$/.test(parts.pathname))
    )
  )
    return null;
  return parts.href;
}

/**
 * Parse the public widget.json shape into the anonymized presence snapshot
 * the join page renders. Pure: no fetch, no clock except the fetchedAt stamp.
 * Returns null on any top-level problem so the caller falls back to the
 * static invite link (widget-disabled included: the probe never calls this
 * on a non-2xx status).
 */
export function parseDiscordWidgetJson(
  guildId: string,
  data: unknown,
  now: () => number = Date.now,
): DiscordWidgetSnapshot | null {
  if (typeof guildId !== "string" || !/^\d{10,25}$/.test(guildId)) return null;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name.length === 0 || name.length > 100) return null;
  if (typeof row.presence_count !== "number" || !Number.isFinite(row.presence_count)) return null;
  if (row.presence_count < 0) return null;
  if (!Array.isArray(row.channels) || !Array.isArray(row.members)) return null;

  const channels: DiscordWidgetChannel[] = [];
  for (const entry of row.channels) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const channel = entry as Record<string, unknown>;
    const id = typeof channel.id === "string" ? channel.id : "";
    const cname = typeof channel.name === "string" ? channel.name.trim() : "";
    const position = channel.position;
    if (id.length === 0 || id.length > 32) continue;
    if (cname.length === 0 || cname.length > 100) continue;
    if (typeof position !== "number" || !Number.isFinite(position)) continue;
    channels.push({ id, name: cname, position });
    if (channels.length >= DISCORD_WIDGET_MAX_CHANNELS) break;
  }
  channels.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const members: DiscordWidgetMember[] = [];
  for (const entry of row.members) {
    if (members.length >= DISCORD_WIDGET_MAX_MEMBERS) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const member = entry as Record<string, unknown>;
    const username = typeof member.username === "string" ? member.username.trim() : "";
    const status = member.status;
    if (username.length === 0 || username.length > 80) continue;
    if (status !== "online" && status !== "idle" && status !== "dnd") continue;
    members.push({ username, status });
  }

  return {
    guildId,
    name,
    inviteUrl: widgetInviteUrl(row.instant_invite),
    presenceCount: Math.min(Math.floor(row.presence_count), 1_000_000),
    channels,
    members,
    fetchedAt: now(),
  };
}

export type DiscordWidgetHealth = {
  /**
   * The widget URL to offer, or null for the static fallback. Synchronous:
   * it answers from the last verdict and never waits on Discord. A stale
   * verdict hands one background probe to `background` (the request's
   * waitUntil); without one, nothing is probed and the last verdict stands.
   */
  url(guildId: string | undefined, background?: (probe: Promise<void>) => void): string | null;
  /**
   * The last parsed widget.json presence snapshot, or null when no probe has
   * succeeded yet, the guild mismatches, or the widget is down/disabled.
   * Synchronous like `url`: the single probe scheduled through `url` refreshes
   * both, so this never fetches on its own.
   */
  snapshot(guildId: string | undefined): DiscordWidgetSnapshot | null;
};

export type DiscordWidgetHealthDeps = { fetch?: typeof fetch; now?: () => number; ttlMs?: number };

/**
 * Per-isolate view of whether Discord is serving the guild widget. Optimistic
 * until a probe says otherwise: the preview loads only on request, so a dead
 * one costs a failed click, while a pessimistic default would hide the
 * preview on every cold isolate. The probe reads the public widget JSON for
 * the same guild (no member data, no cookies) under the shared Discord HTTP
 * budget. 2xx is up; 429 is no new information; any other status, a network
 * error or a timeout is down, which renders the static fallback instead.
 */
export function createDiscordWidgetHealth(deps: DiscordWidgetHealthDeps = {}): DiscordWidgetHealth {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DISCORD_WIDGET_VERDICT_TTL_MS;
  let verdict: {
    guildId: string;
    available: boolean;
    checkedAt: number;
    snapshot: DiscordWidgetSnapshot | null;
  } | null = null;
  let inflight: Promise<void> | null = null;

  async function probe(guildId: string): Promise<void> {
    const previous = verdict?.guildId === guildId ? verdict : null;
    const wasAvailable = previous?.available ?? true;
    let available: boolean;
    let snapshot: DiscordWidgetSnapshot | null = null;
    try {
      const res = await discordFetch(
        `https://discord.com/api/v10/guilds/${guildId}/widget.json`,
        {},
        deps.fetch,
      );
      if (res.status === 429) {
        // Rate-limited: no new information, keep the last verdict + snapshot.
        available = wasAvailable;
        snapshot = previous?.snapshot ?? null;
      } else if (res.ok) {
        // A 2xx means the widget is enabled: the facade iframe stays up even
        // when this payload has no renderable presence shape (older tests pin
        // minimal `{}` bodies). The presence snapshot is best-effort on top.
        available = true;
        try {
          snapshot = parseDiscordWidgetJson(guildId, await res.json(), now);
        } catch {
          snapshot = null;
        }
      } else {
        available = false;
        if (wasAvailable)
          console.warn("discord widget unavailable; rendering the join fallback", {
            guild_id: guildId,
            status: res.status,
          });
      }
    } catch (error) {
      available = false;
      if (wasAvailable)
        console.warn("discord widget unavailable; rendering the join fallback", {
          guild_id: guildId,
          exception: (error as Error).name,
        });
    }
    verdict = { guildId, available, checkedAt: now(), snapshot };
  }

  function currentFor(guildId: string | undefined) {
    return typeof guildId === "string" && verdict?.guildId === guildId ? verdict : null;
  }

  return {
    url(guildId, background) {
      const src = discordWidgetUrl(guildId);
      if (!src) return null;
      const current = currentFor(guildId);
      if (background && !inflight && (!current || now() - current.checkedAt >= ttlMs)) {
        inflight = probe(guildId!).finally(() => {
          inflight = null;
        });
        background(inflight);
      }
      return current?.available === false ? null : src;
    },
    snapshot(guildId) {
      const current = currentFor(guildId);
      if (!current || current.available === false) return null;
      return current.snapshot;
    },
  };
}

export const discordWidgetHealth = createDiscordWidgetHealth();
