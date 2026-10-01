import { afterEach, expect, it, vi } from "vitest";
import { startDbPhase } from "./helpers/diagnostic-timing";

function record() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return { log, value: () => JSON.parse(String(log.mock.calls[0]![0]).replace("TWO_TEST_TIMING ", "")) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each(["", "true", "0"])("emits nothing without explicit diagnostic opt-in %j", (flag) => {
  vi.stubEnv("TEST_TIMINGS", flag);
  const { log } = record();
  startDbPhase("member-data", "reset")();
  expect(log).not.toHaveBeenCalled();
});

it("uses a worker monotonic span even when test clocks are fake", async () => {
  vi.stubEnv("TEST_TIMINGS", "1");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
  const { value } = record();
  const finish = startDbPhase("member-data", "migrate");
  vi.setSystemTime(new Date(-100000));
  finish(false);
  const entry = value();
  expect(entry).toEqual({ kind: "db", fixture: "member-data", phase: "migrate", elapsedMs: expect.any(Number), ok: false });
  expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(entry.elapsedMs)).toBe(true);
});

it("cannot replace original failures or prevent cleanup when the diagnostic sink throws", () => {
  vi.stubEnv("TEST_TIMINGS", "1");
  vi.spyOn(console, "log").mockImplementation(() => { throw new Error("sink failed"); });
  const failure = new Error("original fixture failure");
  let cleaned = false;
  expect(() => {
    const finish = startDbPhase("users-profiles", "reset");
    try { throw failure; } finally { finish(false); cleaned = true; }
  }).toThrow(failure);
  expect(cleaned).toBe(true);
});
