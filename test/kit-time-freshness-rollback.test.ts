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
type Snapshot = { asOf: number; staleAt: number | null; responseStart: number };
let createWatcher: (
  snapshot: Snapshot,
  onStale: () => void,
  page: TestPage,
  visibility: EventTarget,
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

describe("snapshot watcher wall-clock rollback", () => {
  function environment() {
    const page = new EventTarget() as TestPage;
    page.setTimeout = setTimeout;
    page.clearTimeout = clearTimeout;
    Object.defineProperty(page, "performance", {
      configurable: true,
      value: { now: () => Date.now() - 1_000 },
    });
    const visibility = new EventTarget();
    Object.defineProperty(visibility, "visibilityState", { value: "visible", configurable: true });
    return { page, visibility };
  }

  it("does not extend a claim when the wall clock moves backward", () => {
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
    vi.setSystemTime(1_800);
    page.dispatchEvent(new Event("pageshow"));
    vi.setSystemTime(1_100);
    monotonic = 100;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 200;
    vi.advanceTimersByTime(100);
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("withdraws and remains fail-closed when the monotonic clock moves backward", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    let monotonic = 100;
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
    monotonic = 99;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.replace({ asOf: 1_000, staleAt: 6_000, responseStart: 0 });
    expect(onStale).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("keeps a clock failure across a snapshot without a deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { page, visibility } = environment();
    let monotonic = 100;
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
    monotonic = 99;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 101;
    watcher.replace({ asOf: 1_000, staleAt: 5_000, responseStart: 0 });
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("carries a clock advance through replacement after wall-clock rollback", () => {
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
    vi.setSystemTime(1_800);
    page.dispatchEvent(new Event("pageshow"));
    vi.setSystemTime(1_100);
    watcher.replace({ asOf: 1_000, staleAt: 2_000, responseStart: 0 });
    monotonic = 200;
    vi.advanceTimersByTime(200);
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });
});
