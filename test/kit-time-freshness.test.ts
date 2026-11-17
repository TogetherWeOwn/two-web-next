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
type Snapshot = { asOf: number; staleAt: number | null; responseStart: number };
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
      entryPoints: [
        fileURLToPath(new URL("../web/src/lib/time-freshness.ts", import.meta.url).href),
      ],
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
  function environment() {
    const page = new EventTarget() as TestPage;
    page.setTimeout = setTimeout;
    page.clearTimeout = clearTimeout;
    Object.defineProperty(page, "performance", {
      configurable: true,
      value: { now: () => Date.now() - 1_000 },
    });
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
    return createWatcher({ asOf: 1_000, staleAt, responseStart: 0 }, onStale, page, visibility)
      .dispose;
  }

  it("rechecks replacement snapshots and withdraws on a monotonic rollback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    let monotonic = 0;
    Object.defineProperty(page, "performance", {
      configurable: true,
      value: { now: () => monotonic },
    });
    const onStale = vi.fn();
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 2_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    monotonic = 1_000;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.replace({ asOf: 1_000, staleAt: 3_000, responseStart: 1_000 });
    expect(vi.getTimerCount()).toBe(1);
    monotonic = 999;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledTimes(2);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("carries clock progress across replacement and fails closed on rollback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    let monotonic = 0;
    Object.defineProperty(page, "performance", {
      configurable: true,
      value: { now: () => monotonic },
    });
    const onStale = vi.fn();
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 5_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    monotonic = 1_000;
    watcher.replace({ asOf: 1_000, staleAt: 1_500, responseStart: 1_000 });
    expect(onStale).toHaveBeenCalledOnce();
    monotonic = 999;
    watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart: 999 });
    expect(onStale).toHaveBeenCalledTimes(2);
    monotonic = 1_001;
    watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart: 1_001 });
    expect(onStale).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("retains clock failures observed while a snapshot has no claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    let monotonic = 0;
    Object.defineProperty(page, "performance", {
      configurable: true,
      value: { now: () => monotonic },
    });
    const onStale = vi.fn();
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: null, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    monotonic = 1_000;
    page.dispatchEvent(new Event("pageshow"));
    monotonic = 999;
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 1_001;
    watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart: 1_001 });
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("supports replacement and disposal inside a stale callback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn(() => watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart: 0 }));
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 2_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    vi.advanceTimersByTime(1_000);
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);

    const disposeOnStale = vi.fn(() => second.dispose());
    const second = createWatcher(
      { asOf: 1_000, staleAt: 3_000, responseStart: 0 },
      disposeOnStale,
      page,
      visibility,
    );
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
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 1_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("withdraws an already stale replacement and cancels the prior timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 5_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    watcher.replace({ asOf: 1_000, staleAt: 1_000, responseStart: 0 });
    expect(onStale).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("withdraws replacements with missing, future or unreadable response timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const watcher = createWatcher(
      { asOf: 1_000, staleAt: 5_000, responseStart: 0 },
      onStale,
      page,
      visibility,
    );
    for (const responseStart of [NaN, -1, 1]) {
      watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart });
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(onStale).toHaveBeenCalledTimes(3);
    watcher.dispose();
    watcher.replace({ asOf: 1_000, staleAt: 1_000, responseStart: 0 });
    expect(onStale).toHaveBeenCalledTimes(3);
  });

  it("withdraws once at the deadline and tears down its listeners and timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    const onStale = vi.fn();
    const stop = watchTimeSnapshot(2_000, onStale, page, visibility);
    expect(vi.getTimerCount()).toBe(1);
    page.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(onStale).toHaveBeenCalledOnce();
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(onStale).toHaveBeenCalledOnce();
    stop();
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
