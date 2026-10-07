import type { Env } from "../env";
import type { DiscordTransient } from "../islands/contracts";

export const DISCORD_CACHE_FRESH_MS = 60_000;
/** Total maximum age from the last completed success, not fresh + stale. */
export const DISCORD_CACHE_STALE_MS = 600_000;
export const DISCORD_FAILURE_HOLD_MS = 10_000;
export const DISCORD_REFRESH_LEASE_MS = 5_000;
export const DISCORD_SNAPSHOT_MAX_ROWS = 100;
export const DISCORD_SNAPSHOT_MAX_BYTES = 262_144;
export const DISCORD_SNAPSHOT_MAX_KEYS = 128;
export const DISCORD_SNAPSHOT_CLEANUP_BATCH = 16;

export type SnapshotView = {
  payload: unknown;
  succeededAt: number | null;
  retryAt: number;
  leaseExpiresAt: number | null;
  now: number;
};
export type SnapshotClaim = SnapshotView & { token: string | null };
export type SnapshotCompletion = { payload: string } | { retryMs: number };

/** Completed values only. Every implementation owns its clock and fences completion. */
export interface DiscordSnapshotStore {
  claim(key: string): Promise<SnapshotClaim>;
  complete(key: string, token: string, result: SnapshotCompletion): Promise<SnapshotView>;
}

export class DiscordSnapshotError extends Error {
  constructor() {
    super("DiscordSnapshotUnavailable");
    this.name = "DiscordSnapshotError";
  }
}

/** Configured origin, never request Host, viewer, search, or credential. */
export function discordSnapshotKey(env: Pick<Env, "APP_URL" | "DISCORD_GUILD_ID">): string {
  const origin = new URL(env.APP_URL);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !env.DISCORD_GUILD_ID ||
    env.DISCORD_GUILD_ID.length > 64
  )
    throw new DiscordSnapshotError();
  const key = JSON.stringify(["discord-display-v1", origin.origin, env.DISCORD_GUILD_ID]);
  if (key.length > 512) throw new DiscordSnapshotError();
  return key;
}

const fields = ["discordId", "status", "title", "description", "location", "startsAt", "endsAt"];
const text = (v: unknown, max: number): v is string =>
  // Unicode-mode matching rejects lone surrogates, but not valid astral pairs.
  typeof v === "string" && v.length <= max && !/[\u0000\uD800-\uDFFF]/u.test(v);
const optionalText = (v: unknown, max: number): v is string | null => v === null || text(v, max);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string" || v.length !== 24) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v ? d : null;
};

/** Reject corruption as a whole, never invent a successful empty snapshot. */
export function decodeDiscordSnapshot(payload: unknown): DiscordTransient[] {
  if (
    !Array.isArray(payload) ||
    payload.length > DISCORD_SNAPSHOT_MAX_ROWS ||
    // jsonb::text adds a space after each colon/comma in these flat seven-field rows.
    new TextEncoder().encode(JSON.stringify(payload)).byteLength +
      Math.max(0, fields.length * 2 * payload.length - 1) >
      DISCORD_SNAPSHOT_MAX_BYTES
  )
    throw new DiscordSnapshotError();
  return payload.map((raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new DiscordSnapshotError();
    const row = raw as Record<string, unknown>;
    const startsAt = date(row.startsAt);
    const endsAt = row.endsAt === null ? null : date(row.endsAt);
    if (
      Object.keys(row).length !== fields.length ||
      Object.keys(row).some((k) => !fields.includes(k)) ||
      !text(row.discordId, 64) ||
      !row.discordId ||
      !text(row.title, 256) ||
      !row.title.trim() ||
      !optionalText(row.description, 4000) ||
      !optionalText(row.location, 1000) ||
      (row.status !== "active" && row.status !== "scheduled") ||
      !startsAt ||
      (row.endsAt !== null && !endsAt)
    )
      throw new DiscordSnapshotError();
    return {
      discordId: row.discordId,
      status: row.status as "active" | "scheduled",
      title: row.title,
      description: row.description,
      location: row.location,
      startsAt,
      endsAt,
    };
  });
}

/** Store only display fields; serialization breaks every caller-owned object/Date alias. */
export function encodeDiscordSnapshot(rows: DiscordTransient[]): string {
  if (rows.length > DISCORD_SNAPSHOT_MAX_ROWS) throw new DiscordSnapshotError();
  const payload = rows.map((r) => ({
    discordId: r.discordId,
    status: r.status,
    title: r.title,
    description: r.description,
    location: r.location,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt?.toISOString() ?? null,
  }));
  decodeDiscordSnapshot(payload);
  return JSON.stringify(payload);
}

/** Even a future/corrupt timestamp cannot authorize serving data. */
export function usableDiscordSnapshot(view: SnapshotView): DiscordTransient[] | null {
  if (view.payload === null && view.succeededAt === null) return null;
  if (view.payload === null || view.succeededAt === null || !Number.isFinite(view.succeededAt))
    throw new DiscordSnapshotError();
  const rows = decodeDiscordSnapshot(view.payload);
  const age = view.now - view.succeededAt;
  return age >= 0 && age < DISCORD_CACHE_STALE_MS ? rows : null;
}
