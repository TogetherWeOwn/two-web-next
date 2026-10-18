import {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_REFRESH_LEASE_MS,
  DISCORD_SNAPSHOT_MAX_KEYS,
  DISCORD_SNAPSHOT_MAX_BYTES,
  DISCORD_SNAPSHOT_CLEANUP_BATCH,
  DiscordSnapshotError,
  type DiscordSnapshotStore,
  type SnapshotView,
  decodeDiscordSnapshot,
  usableDiscordSnapshot,
} from "../../src/events/discord-snapshot";

import type { DiscordTransient } from "../../src/islands/contracts";

/** Seven-field rows exactly at the jsonb text boundary, checked against real SQL. */
export function discordSnapshotBoundaryRows(): DiscordTransient[] {
  const rows: DiscordTransient[] = Array.from({ length: 60 }, (_, i) => ({
    discordId: String(i),
    status: "scheduled",
    title: "Boundary",
    description: "x".repeat(4000),
    location: null,
    startsAt: new Date("2030-01-02T20:00:00Z"),
    endsAt: new Date("2030-01-02T21:00:00Z"),
  }));
  const separators = 14 * rows.length - 1;
  let padding =
    DISCORD_SNAPSHOT_MAX_BYTES -
    separators -
    new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  for (const r of rows) {
    if (padding <= 0) break;
    const increment = Math.min(998, padding);
    r.location = "x".repeat(increment + 2); // Replace four-byte null with a quoted string.
    padding -= increment;
  }
  if (padding !== 0) throw new Error("Invalid boundary fixture");
  return rows;
}

type Entry = Omit<SnapshotView, "now"> & { token: string | null };
export function memoryDiscordBacking(clock: () => number = () => Date.now()) {
  return { entries: new Map<string, Entry>(), clock };
}
export type MemoryDiscordBacking = ReturnType<typeof memoryDiscordBacking>;

/** Independent store instances share bytes only, never a promise, reader or SQL client. */
export function memoryDiscordStore(backing: MemoryDiscordBacking): DiscordSnapshotStore {
  const empty = (): Entry => ({
    payload: null,
    succeededAt: null,
    retryAt: 0,
    leaseExpiresAt: null,
    token: null,
  });
  const read = (key: string): SnapshotView => ({
    ...structuredClone(backing.entries.get(key) ?? empty()),
    now: backing.clock(),
  });
  return {
    async claim(key) {
      let entry = backing.entries.get(key);
      const nowQueryStartedAt = performance.now();
      const now = backing.clock();
      const initial = read(key);
      const rows = usableDiscordSnapshot(initial);
      if (
        (rows !== null && now - initial.succeededAt! < DISCORD_CACHE_FRESH_MS) ||
        initial.retryAt > now ||
        (initial.leaseExpiresAt ?? 0) > now
      )
        return { ...initial, token: null, nowQueryStartedAt };
      if (!entry) {
        let removed = 0;
        for (const [k, v] of backing.entries) {
          if (removed >= DISCORD_SNAPSHOT_CLEANUP_BATCH) break;
          if (
            (v.succeededAt ?? -Infinity) <= now - DISCORD_CACHE_STALE_MS &&
            v.retryAt <= now &&
            (v.leaseExpiresAt ?? 0) <= now
          ) {
            backing.entries.delete(k);
            removed++;
          }
        }
        if (backing.entries.size >= DISCORD_SNAPSHOT_MAX_KEYS) throw new DiscordSnapshotError();
        entry = empty();
        backing.entries.set(key, entry);
      }
      entry.token = crypto.randomUUID();
      entry.leaseExpiresAt = now + DISCORD_REFRESH_LEASE_MS;
      return { ...read(key), token: entry.token, nowQueryStartedAt };
    },
    async complete(key, token, result) {
      const entry = backing.entries.get(key);
      const now = backing.clock();
      if (entry?.token === token && entry.leaseExpiresAt! > now) {
        if ("payload" in result) {
          const payload: unknown = JSON.parse(result.payload);
          decodeDiscordSnapshot(payload);
          entry.payload = payload;
          entry.succeededAt = now;
          entry.retryAt = 0;
        } else entry.retryAt = now + result.retryMs;
        entry.token = null;
        entry.leaseExpiresAt = null;
      }
      return read(key);
    },
  };
}
