import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
type TestPage = EventTarget & {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};
type TestVisibility = EventTarget;
function snapshot(staleAt: number | null, responseStart = 0, age: number | null = 0) {
  return { asOf: 1_000, staleAt, responseStart, snapshotAgeAtResponseStart: age };
}
type Snapshot = ReturnType<typeof snapshot>;
let createWatcher: (
  snapshot: Snapshot,
  onStale: () => void,
  page: TestPage,
  visibility: TestVisibility,
) => { replace: (snapshot: Snapshot) => void; dispose: () => void };

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-time-freshness-"));
  try {
    const outfile = join(scratch, "watcher.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../lib/time-freshness.ts", import.meta.url).href)],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      tsconfigRaw: {},
    });
    ({ watchTimeSnapshot: createWatcher } = await import(pathToFileURL(outfile).href));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("page-owned snapshot watcher", () => {
  function environment(now = () => Date.now() - 1_000) {
    const page = new EventTarget() as TestPage;
    page.setTimeout = setTimeout;
    page.clearTimeout = clearTimeout;
    Object.defineProperty(page, "performance", { value: { now } });
    const visibility: TestVisibility = new EventTarget();
    Object.defineProperty(visibility, "visibilityState", { value: "visible", configurable: true });
    return { page, visibility };
  }

  function watchTimeSnapshot(
    staleAt: number | null,
    onStale: () => void,
    page: TestPage,
    visibility: TestVisibility,
  ) {
    return createWatcher(snapshot(staleAt), onStale, page, visibility).dispose;
  }

  it("counts the age at receipt for initial and replacement deadlines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(2_000, 0, 800), onStale, page, visibility);
    vi.advanceTimersByTime(199);
    expect(onStale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledOnce();
    // The replacement's age bound advances beyond the prior clock reading.
    watcher.replace(snapshot(2_200, 200, 1_100));
    vi.advanceTimersByTime(99);
    expect(onStale).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it.each([null, -1, Infinity, NaN])("withdraws a claim with untrusted age %s", (age) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(2_000, 0, 800), onStale, page, visibility);
    expect(vi.getTimerCount()).toBe(1);
    watcher.replace(snapshot(2_000, 0, age));
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(50);
    watcher.replace(snapshot(2_000, 50));
    vi.advanceTimersByTime(149);
    expect(onStale).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("arms a valid replacement after an unaged terminal snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(null, 0, null), onStale, page, visibility);
    watcher.replace(snapshot(2_000));
    vi.advanceTimersByTime(999);
    expect(onStale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it.each(["wall", "monotonic"])("withdraws and stays closed on %s clock rollback", (clock) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 0;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(2_000), onStale, page, visibility);
    monotonic = 1_000;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.replace(snapshot(3_000, 1_000));
    expect(vi.getTimerCount()).toBe(1);
    if (clock === "wall") vi.setSystemTime(999);
    else monotonic = 999;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_101);
    monotonic = 1_001;
    watcher.replace({ ...snapshot(5_000, monotonic), asOf: 1_100 });
    expect(onStale).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("carries clock progress across replacement and fails closed on rollback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 0;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(5_000), onStale, page, visibility);
    monotonic = 1_000;
    watcher.replace(snapshot(1_500, 1_000));
    expect(onStale).toHaveBeenCalledOnce();
    monotonic = 999;
    watcher.replace(snapshot(5_000, 999));
    expect(onStale).toHaveBeenCalledTimes(2);
    monotonic = 1_001;
    watcher.replace(snapshot(5_000, 1_001));
    expect(onStale).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it.each([999, NaN])("retains a bad clock sample (%s) when there is no claim", (badSample) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 0;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(null, 0, null), onStale, page, visibility);
    monotonic = 1_000;
    page.dispatchEvent(new Event("pageshow"));
    monotonic = badSample;
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 1_001;
    watcher.replace(snapshot(5_000, 1_001));
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("supports replacement and disposal inside a stale callback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn(() => watcher.replace(snapshot(5_000)));
    const watcher = createWatcher(snapshot(2_000), onStale, page, visibility);
    vi.advanceTimersByTime(1_000);
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);

    const disposeOnStale = vi.fn(() => second.dispose());
    const second = createWatcher(snapshot(3_000), disposeOnStale, page, visibility);
    vi.advanceTimersByTime(1_000);
    expect(disposeOnStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(new Event("pageshow"));
    expect(disposeOnStale).toHaveBeenCalledOnce();
  });

  it("withdraws an initially stale snapshot synchronously without scheduling a timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(1_000), onStale, page, visibility);
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("withdraws an already stale replacement and cancels the prior timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(5_000), onStale, page, visibility);
    watcher.replace(snapshot(1_000));
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("withdraws replacements with invalid response timing or a future server timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(5_000), onStale, page, visibility);
    for (const responseStart of [NaN, -1, 1]) {
      watcher.replace(snapshot(5_000, responseStart));
      expect(vi.getTimerCount()).toBe(0);
    }
    watcher.replace({ ...snapshot(5_000), asOf: 1_001 });
    expect(vi.getTimerCount()).toBe(0);
    expect(onStale).toHaveBeenCalledTimes(4);
    watcher.replace(snapshot(5_000));
    expect(vi.getTimerCount()).toBe(1);
    watcher.dispose();
    watcher.replace(snapshot(1_000));
    expect(onStale).toHaveBeenCalledTimes(4);
  });

  it("withdraws once at the deadline and tears down its listeners and timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const addPage = vi.spyOn(page, "addEventListener");
    const addVisibility = vi.spyOn(visibility, "addEventListener");
    const removePage = vi.spyOn(page, "removeEventListener");
    const removeVisibility = vi.spyOn(visibility, "removeEventListener");
    const stop = watchTimeSnapshot(2_000, onStale, page, visibility);
    expect(vi.getTimerCount()).toBe(1);
    page.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(onStale).toHaveBeenCalledOnce();
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(onStale).toHaveBeenCalledOnce();
    stop();
    expect(removePage).toHaveBeenCalledOnce();
    expect(removePage.mock.calls).toEqual(addPage.mock.calls);
    expect(removeVisibility).toHaveBeenCalledOnce();
    expect(removeVisibility.mock.calls).toEqual(addVisibility.mock.calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks restored or visible pages and treats an unreadable clock as stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const stop = watchTimeSnapshot(2_000, onStale, page, visibility);
    vi.setSystemTime(2_000);
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    stop();
    vi.setSystemTime(1_000);
    const onVisible = vi.fn();
    const stopVisible = watchTimeSnapshot(2_000, onVisible, page, visibility);
    vi.setSystemTime(2_000);
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(onVisible).toHaveBeenCalledOnce();
    stopVisible();
    const onBadClock = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(NaN);
    watchTimeSnapshot(2_000, onBadClock, page, visibility)();
    expect(onBadClock).toHaveBeenCalledOnce();
  });

  it("stops pending work and does not watch terminal snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    watchTimeSnapshot(2_000, onStale, page, visibility)();
    vi.advanceTimersByTime(2_000);
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).not.toHaveBeenCalled();
    watchTimeSnapshot(null, onStale, page, visibility)();
    expect(vi.getTimerCount()).toBe(0);
  });
});
