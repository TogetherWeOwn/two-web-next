import { snapshotNow, timeSnapshotIsStale, type SnapshotClock } from "./time-freshness-clock";

export interface TimeSnapshot extends Pick<SnapshotClock, "asOf" | "snapshotAgeAtResponseStart"> {
  staleAt: number | null;
  // Response start in the page's performance.now() time coordinate.
  responseStart: number;
}

/**
 * A page owns presentation and announcements. It must discard out-of-order
 * responses and update its presentation before watching or replacing: either can
 * call onStale synchronously. A clock failure remains fail-closed for this watcher.
 */
export function watchTimeSnapshot(
  initial: TimeSnapshot,
  onStale: () => void,
  page: Window = window,
  visibility: Document = document,
): { replace: (snapshot: TimeSnapshot) => void; dispose: () => void } {
  let timer: number | undefined;
  let disposed = false;
  let snapshot: TimeSnapshot | undefined;
  let pageNow = -Infinity;
  let acceptedAsOf = -Infinity;
  let lastMonotonic = 0;

  function monotonicNow(): number {
    try {
      return page.performance.now();
    } catch {
      return Number.NaN;
    }
  }

  function check() {
    if (disposed) return;
    if (timer !== undefined) page.clearTimeout(timer);
    timer = undefined;
    const wall = Date.now();
    const monotonic = monotonicNow();
    // Only a previously accepted claim can establish a wall-clock rollback.
    const badWall = !Number.isFinite(wall) || wall < acceptedAsOf;
    pageNow =
      badWall || !Number.isFinite(monotonic) || monotonic < lastMonotonic
        ? Number.NaN
        : Math.max(wall, pageNow + (monotonic - lastMonotonic));
    lastMonotonic = monotonic;
    if (!snapshot) return;

    const now = snapshotNow(
      { ...snapshot, hydrationWall: pageNow, hydrationMonotonic: monotonic, previousNow: pageNow },
      wall,
      monotonic,
    );
    // Only a trustworthy snapshot can advance the page clock beyond its own reading.
    if (Number.isFinite(now)) pageNow = now;
    const { staleAt } = snapshot;
    if (staleAt === null || timeSnapshotIsStale(staleAt, now)) {
      snapshot = undefined;
      if (staleAt !== null) onStale();
      return;
    }
    acceptedAsOf = Math.max(acceptedAsOf, snapshot.asOf);
    timer = page.setTimeout(check, Math.min(staleAt - now, 2_147_483_647));
  }

  function replace(next: TimeSnapshot) {
    if (disposed) return;
    snapshot = next;
    check();
  }

  function onVisibilityChange() {
    if (visibility.visibilityState === "visible") check();
  }

  page.addEventListener("pageshow", check);
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  replace(initial);
  return {
    replace,
    dispose() {
      disposed = true;
      if (timer !== undefined) page.clearTimeout(timer);
      page.removeEventListener("pageshow", check);
      visibility.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
