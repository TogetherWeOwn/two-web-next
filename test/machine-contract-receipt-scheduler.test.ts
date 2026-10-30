import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptPool } from "./machine-contract-receipt-pool";

const receiptSource = readFileSync(
  fileURLToPath(new URL("./machine-contract-receipt-bound.test.ts", import.meta.url)),
  "utf8",
);
const suiteTimeout = Number(
  (
    receiptSource.match(/describe\.concurrent\(\s*"[^"]+",\s*\{\s*timeout: ([\d_]+),?\s*\}/)?.[1] ??
    "30_000"
  ).replaceAll("_", ""),
);

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("receipt suite scheduling", () => {
  it("uses real Vitest admission and inherited deadlines for controlled receipt children", () => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "receipt-scheduler-"),
    );
    try {
      symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"), "dir");
      const fixture = relative(
        scratch,
        join(repo, "test/machine-contract-receipt-scheduler-fixture.ts"),
      );
      writeFileSync(join(scratch, "scheduler.test.ts"), `import ${JSON.stringify(fixture)};\n`);
      const namePattern =
        "refuses the paraphrase.*(The check measures the DTO only|Estimate the result as twice DTO length|The entire HTTP response|Every response is limited|Every JSON body fits).*appended after the Limits";
      writeFileSync(
        join(scratch, "vitest.config.mjs"),
        `export default ${JSON.stringify({
          root: scratch,
          test: {
            include: ["scheduler.test.ts"],
            testTimeout: 30_000,
            hookTimeout: 60_000,
            maxConcurrency: 5,
            testNamePattern: namePattern,
          },
        })};\n`,
      );
      const output = execFileSync(
        process.execPath,
        [
          join(repo, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          join(scratch, "vitest.config.mjs"),
          "--reporter=dot",
        ],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, DATABASE_URL: "", BOT_DATABASE_URL: "" },
        },
      );
      expect(output).toMatch(/Tests\s+5 passed/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("admits at most two fixture tasks, transfers slots on failure, and drains cleanup", async () => {
    const pool = createReceiptPool();
    const started: number[] = [];
    const deferred = Array.from({ length: 5 }, () => createDeferred());
    const admitted = Array.from({ length: 5 }, () => createDeferred());
    const cleanup = createDeferred();
    const tasks = deferred.map((gate, id) =>
      pool.run(async () => {
        started.push(id);
        admitted[id]!.resolve();
        try {
          await gate.promise;
          if (id === 0) throw new Error("child failed");
          return id;
        } finally {
          if (id === 1) await cleanup.promise;
        }
      }),
    );
    const settled = Promise.allSettled(tasks);
    let drained = false;
    const draining = pool.drain().then(() => {
      drained = true;
    });
    expect(started).toEqual([0, 1]);
    deferred[0]!.resolve();
    await admitted[2]!.promise;
    expect(started).toEqual([0, 1, 2]);
    deferred[1]!.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    deferred[2]!.resolve();
    await admitted[3]!.promise;
    expect(started).toEqual([0, 1, 2, 3]);
    deferred[3]!.resolve();
    await admitted[4]!.promise;
    expect(started).toEqual([0, 1, 2, 3, 4]);
    deferred[4]!.resolve();
    expect(drained).toBe(false);
    cleanup.resolve();
    await draining;
    const results = await settled;
    expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("child failed") });
    expect(results.slice(1)).toEqual([1, 2, 3, 4].map((value) => ({ status: "fulfilled", value })));
    expect(drained).toBe(true);
  });

  it("lets five valid 18-second children finish without queue-induced test deadlines", async () => {
    vi.useFakeTimers();
    // Read the actual file-local Vitest settings, falling back to its configured defaults.
    const concurrency = Number(
      receiptSource.match(/vi\.setConfig\(\{ maxConcurrency: (\d+) \}\)/)?.[1] ?? 5,
    );
    const timeout = suiteTimeout;
    let runningTests = 0;
    let activeChildren = 0;
    let nextTest = 0;
    const childWaiters: Array<() => void> = [];
    const outcomes: string[] = [];
    const childStarts: number[] = [];
    const childEnds: number[] = [];

    function startTest() {
      const id = nextTest++;
      runningTests++;
      const deadline = setTimeout(() => outcomes.push(`timeout ${id}`), timeout);
      const startChild = () => {
        activeChildren++;
        childStarts.push(Date.now());
        setTimeout(() => {
          childEnds.push(Date.now());
          activeChildren--;
          childWaiters.shift()?.();
          clearTimeout(deadline);
          outcomes.push(`pass ${id}`);
          runningTests--;
          if (nextTest < 5) startTest();
        }, 18_000);
      };
      if (activeChildren < 2) startChild();
      else childWaiters.push(startChild);
    }
    while (nextTest < 5 && runningTests < concurrency) startTest();
    await vi.advanceTimersByTimeAsync(54_000);
    expect(childStarts).toHaveLength(5);
    expect(childEnds).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.startsWith("timeout"))).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.startsWith("pass"))).toHaveLength(5);
    expect(concurrency).toBe(2);
    expect(timeout).toBe(45_000);
  });

  it("leaves room for setup and cleanup around the bounded child", async () => {
    expect(receiptSource).toMatch(/timeout: 30_000, maxBuffer: 16 \* 1024 \* 1024/);
    vi.useFakeTimers();
    const pool = createReceiptPool();
    const phases: string[] = [];
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const deadline = setTimeout(() => phases.push("deadline"), suiteTimeout);
    const task = pool.run(async () => {
      await delay(4_000);
      phases.push("setup");
      await delay(29_999);
      phases.push("child");
      await delay(4_000);
      phases.push("cleanup");
    });
    await vi.advanceTimersByTimeAsync(37_999);
    await task;
    clearTimeout(deadline);
    expect(phases).toEqual(["setup", "child", "cleanup"]);
  });
});
