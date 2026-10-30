// Imported by a scratch Vitest project. This is the real receipt suite with its
// subprocess boundary controlled; it is not a second model of Vitest admission.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, vi } from "vitest";

const state = vi.hoisted(() => ({
  now: 0,
  starts: [] as number[],
  children: 0,
  peak: 0,
  calls: 0,
  queued: [] as Array<() => void>,
  scheduled: false,
}));

vi.mock("node:child_process", () => ({
  execFile: (
    executable: string,
    args: string[],
    options: { cwd: string; timeout: number; maxBuffer: number },
    callback: (error: Error & { code: number }, stdout: string, stderr: string) => void,
  ) => {
    expect(executable).toBe(process.execPath);
    expect(args).toEqual(["--import", "tsx", "ci/check-machine-contract.mjs", "--format", "json"]);
    expect(options.timeout).toBe(30_000);
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
    const text = readFileSync(join(options.cwd, "docs/machine-interface.md"), "utf8");
    const claim = text.trimEnd().split("\n").at(-1);
    const receipt = JSON.stringify({
      verdict: "fail",
      failures: [
        `guide states a size or measurement claim outside the canonical Limits: "${claim}"`,
      ],
    });
    state.calls++;
    state.children++;
    state.peak = Math.max(state.peak, state.children);
    state.queued.push(() => {
      state.children--;
      callback(Object.assign(new Error("refusal"), { code: 1 }), receipt, "");
    });
    if (!state.scheduled) {
      state.scheduled = true;
      setImmediate(() => {
        state.scheduled = false;
        const completed = state.queued.splice(0);
        state.now += 18_000;
        for (const complete of completed) complete();
      });
    }
  },
}));

beforeEach(({ task }) => {
  expect(task.timeout).toBe(45_000);
  state.starts.push(state.now);
});

afterAll(() => {
  expect(state.calls).toBe(5);
  expect(state.peak).toBe(2);
  expect(state.children).toBe(0);
  expect(state.now).toBe(54_000);
  expect(state.starts).toEqual([0, 0, 18_000, 18_000, 36_000]);
});

import "./machine-contract-receipt-bound.test";
