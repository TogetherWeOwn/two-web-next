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
type Snapshot = {
  asOf: number;
  staleAt: number | null;
  responseStart: number;
  snapshotAgeAtResponseStart: number | null;
};

function snapshot(staleAt: number | null): Snapshot {
  return {
    asOf: 1_000,
    staleAt,
    responseStart: 0,
    snapshotAgeAtResponseStart: staleAt === null ? null : 0,
  };
}
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

describe("snapshot watcher wall-clock rollback", () => {
  function environment(monotonicNow: () => number) {
    const page = new EventTarget() as TestPage;
    page.setTimeout = setTimeout;
    page.clearTimeout = clearTimeout;
    Object.defineProperty(page, "performance", { value: { now: monotonicNow } });
    const visibility = new EventTarget();
    Object.defineProperty(visibility, "visibilityState", { value: "visible", configurable: true });
    return { page, visibility };
  }

  it("does not extend a claim when the wall clock moves backward", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 0;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(2_000), onStale, page, visibility);
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
    let monotonic = 100;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(5_000), onStale, page, visibility);
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 99;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.replace(snapshot(6_000));
    expect(onStale).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("keeps a clock failure across a snapshot without a deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 100;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(null), onStale, page, visibility);
    monotonic = 99;
    page.dispatchEvent(new Event("pageshow"));
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 101;
    watcher.replace(snapshot(5_000));
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("carries a clock advance through replacement after wall-clock rollback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let monotonic = 0;
    const { page, visibility } = environment(() => monotonic);
    const onStale = vi.fn();
    const watcher = createWatcher(snapshot(5_000), onStale, page, visibility);
    vi.setSystemTime(1_800);
    page.dispatchEvent(new Event("pageshow"));
    vi.setSystemTime(1_100);
    watcher.replace(snapshot(2_000));
    monotonic = 199;
    vi.advanceTimersByTime(199);
    expect(onStale).not.toHaveBeenCalled();
    monotonic = 200;
    vi.advanceTimersByTime(1);
    expect(onStale).toHaveBeenCalledOnce();
    watcher.dispose();
  });
});
