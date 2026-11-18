import { twoMotionPollStaleAfter } from "../../../vendor/design-kit/tokens";

/**
 * Return the deadline for a server snapshot's relative or live claims.
 * A consuming page must enforce the kit's cache contract separately: shared
 * responses use max-age=0 and cap s-maxage at the earliest claim's remaining
 * lifetime at response emission (staleAt minus server time, rounded down to
 * seconds). Do not share if that bound is unknown or less than one second;
 * withdraw claims that have already expired. Use private, no-cache
 * for non-shared responses. Shared responses also need a trustworthy age
 * bound at receipt: the HTTP Age header alone does not account for time
 * before response emission. Do not serve C4 pages with
 * stale-while-revalidate, stale-if-error or immutable.
 * This helper does not set headers or invalidate an existing cache entry.
 */
export function timeStaleAt(
  state: "upcoming" | "live" | "ended" | "cancelled",
  asOf: number,
  start: number,
  end?: number,
): number | null {
  if (state === "ended" || state === "cancelled") return null;
  if (!Number.isFinite(asOf) || !Number.isFinite(start)) return Number.NaN;
  if (state === "upcoming" && start <= asOf) return asOf;
  if (state === "live" && start > asOf) return asOf;
  if (state === "live" && end !== undefined && (!Number.isFinite(end) || end <= asOf)) return asOf;
  if (state === "upcoming" && start - asOf > 24 * 60 * 60 * 1000) return null;

  const boundaries = state === "upcoming" ? [start - 15 * 60 * 1000, start] : [end];
  return Math.min(
    asOf + twoMotionPollStaleAfter,
    ...boundaries.filter(
      (boundary): boundary is number =>
        typeof boundary === "number" && Number.isFinite(boundary) && boundary > asOf,
    ),
  );
}

export interface SnapshotClock {
  asOf: number;
  responseStart: number;
  /** Trusted upper bound in ms on the snapshot's age at responseStart, or null if unknown. */
  snapshotAgeAtResponseStart: number | null;
  hydrationWall: number;
  hydrationMonotonic: number;
  previousNow: number;
}

/** Compute the conservative snapshot clock, or NaN when either clock is unreliable. */
export function snapshotNow(clock: SnapshotClock, wall: number, monotonic: number): number {
  const {
    asOf,
    responseStart,
    snapshotAgeAtResponseStart,
    hydrationWall,
    hydrationMonotonic,
    previousNow,
  } = clock;
  if (
    snapshotAgeAtResponseStart === null ||
    !Number.isFinite(snapshotAgeAtResponseStart) ||
    snapshotAgeAtResponseStart < 0 ||
    ![asOf, responseStart, hydrationWall, hydrationMonotonic, previousNow, wall, monotonic].every(
      Number.isFinite,
    ) ||
    wall < asOf ||
    hydrationWall < asOf ||
    responseStart < 0 ||
    hydrationMonotonic < responseStart ||
    monotonic < hydrationMonotonic
  ) {
    return Number.NaN;
  }
  return Math.max(
    previousNow,
    wall,
    hydrationWall + monotonic - hydrationMonotonic,
    asOf + snapshotAgeAtResponseStart + (monotonic - responseStart),
  );
}

/** A bad client clock can only withdraw claims, never extend their lifetime. */
export function timeSnapshotIsStale(staleAt: number, now: number): boolean {
  return !Number.isFinite(staleAt) || !Number.isFinite(now) || now >= staleAt;
}
