// Discord transients: the shared-snapshot reader (structural split of
// ./discord-transients; zero behavior change). Completed snapshots and atomic
// admission live in the store; the HTTP reader stays request-owned.

import type { Env } from "../env";
import type { DiscordTransient } from "../islands/contracts";
import {
  DISCORD_CACHE_FRESH_MS,
  type SnapshotCompletion,
  DISCORD_FAILURE_HOLD_MS,
  type DiscordSnapshotStore,
  discordSnapshotKey,
  encodeDiscordSnapshot,
  usableDiscordSnapshot,
} from "./discord-snapshot";
import { postgresDiscordSnapshotStore } from "./discord-snapshot-postgres";
import { DiscordGuildIdConfigError, liveDiscordEventsSource } from "./discord-transients-live";
import {
  type DiscordEventsSource,
  type DiscordSnapshotOutcome,
  SAFE_SNAPSHOT_SQLSTATES,
} from "./discord-transients-types";

function safeSnapshotSqlState(error: unknown): string | undefined {
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof rawCode === "string" && SAFE_SNAPSHOT_SQLSTATES.includes(rawCode)
    ? rawCode
    : undefined;
}

/** A refused guild id degrades to an empty failed read, never a thrown page. */
function refusedGuildIdSource(): DiscordEventsSource {
  return {
    lastReadFailed: () => true,
    async upcoming(): Promise<DiscordTransient[]> {
      return [];
    },
  };
}

/** Shared completed snapshots and atomic admission; the HTTP reader remains request-owned. */
export function cachedDiscordEventsSource(
  env: Env,
  inner?: DiscordEventsSource,
  store: DiscordSnapshotStore = postgresDiscordSnapshotStore(env),
): DiscordEventsSource {
  let resolvedInner: DiscordEventsSource;
  if (inner) {
    resolvedInner = inner;
  } else {
    try {
      resolvedInner = liveDiscordEventsSource(env);
    } catch (err) {
      if (err instanceof DiscordGuildIdConfigError) {
        // Fixed key only: the refused value must never reach a log line.
        // Degrade like any failed Discord read so /events stays 200 and the
        // home teaser still lists canonical events; zero fetches happened.
        console.warn("Discord guild id configuration invalid.");
        return refusedGuildIdSource();
      }
      throw err;
    }
  }
  const liveInner = resolvedInner;
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
            const rows = await liveInner.upcoming(now);
            if (!liveInner.lastReadFailed()) {
              result = { payload: encodeDiscordSnapshot(rows) };
              liveRows = rows;
            } else {
              const failure = liveInner.lastReadFailure?.();
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
        const outcome: DiscordSnapshotOutcome = failed
          ? "cold"
          : snapshot.retryAt > snapshot.now
            ? "held"
            : snapshot.now - snapshot.succeededAt! < DISCORD_CACHE_FRESH_MS
              ? "fresh"
              : "stale";
        console.info("Discord snapshot outcome", {
          outcome,
          completionFailed,
          ...(completionCode ? { code: completionCode } : {}),
        });
        return recent ?? [];
      } catch (err) {
        // No unadmitted live read on storage/corruption failure. Only known SQLSTATE
        // codes may leave the store; never log the driver's message or other fields.
        failed = true;
        const code = safeSnapshotSqlState(err);
        const outcome: DiscordSnapshotOutcome = "error";
        console.warn("Discord snapshot outcome", { outcome, code });
        return [];
      }
    },
  };
}
