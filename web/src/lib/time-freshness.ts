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
  let withdrawn = false;
  let disposed = false;
  let snapshot = initial;
  let clock: SnapshotClock | undefined;
  let lastMonotonic: number | undefined;

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
    const monotonic = monotonicNow();
    const now =
      !clock || lastMonotonic === undefined || monotonic < lastMonotonic
        ? Number.NaN
        : snapshotNow(clock, Date.now(), monotonic);
    lastMonotonic = monotonic;
    if (clock) {
      clock.previousNow = now;
      clock.hydrationWall = now;
      clock.hydrationMonotonic = monotonic;
    }
    if (withdrawn || snapshot.staleAt === null) return;
    if (timeSnapshotIsStale(snapshot.staleAt, now)) {
      withdrawn = true;
      onStale();
      return;
    }
    timer = page.setTimeout(check, Math.min(snapshot.staleAt - now, 2_147_483_647));
  }

  function replace(next: TimeSnapshot) {
    if (disposed) return;
    if (timer !== undefined) page.clearTimeout(timer);
    timer = undefined;
    const hydrationWall = Date.now();
    const monotonic = monotonicNow();
    const previousNow = clock
      ? lastMonotonic === undefined || monotonic < lastMonotonic
        ? Number.NaN
        : snapshotNow(clock, hydrationWall, monotonic)
      : hydrationWall;
    snapshot = next;
    withdrawn = false;
    lastMonotonic = monotonic;
    clock = {
      asOf: next.asOf,
      responseStart: next.responseStart,
      snapshotAgeAtResponseStart: next.snapshotAgeAtResponseStart,
      hydrationWall: Math.max(hydrationWall, previousNow),
      hydrationMonotonic: monotonic,
      previousNow,
    };
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
