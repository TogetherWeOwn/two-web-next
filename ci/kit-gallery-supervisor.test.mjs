import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { run } from "./kit-gallery-supervisor.mjs";

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    signals: [],
    kill(signal) {
      this.signals.push(signal);
    },
  });
}

test("supervisor handles successful, failed and signalled direct children", async () => {
  for (const [code, signal, expected] of [
    [0, null, null],
    [2, null, /exit 2/],
    [null, "SIGSEGV", /SIGSEGV/],
  ]) {
    const worker = child();
    const result = run("/unused", ["build"], { spawnChild: () => worker });
    worker.emit("close", code, signal);
    if (expected) await assert.rejects(result, expected);
    else await result;
    assert.deepEqual(worker.signals, []);
  }
  await assert.rejects(
    run("/unused", ["build"], {
      spawnChild: () => {
        throw new Error("spawn failed");
      },
    }),
    /failed to start: spawn failed/,
  );
});

test("supervisor refuses expired or cancelled work before spawn", async () => {
  let spawned = false;
  const spawnChild = () => {
    spawned = true;
    return child();
  };
  await assert.rejects(
    run("/unused", ["build"], { spawnChild, timeoutMs: 0 }),
    /no remaining build time/,
  );
  await assert.rejects(
    run("/unused", ["build"], { spawnChild, abortSignal: AbortSignal.abort() }),
    /cancelled before spawn/,
  );
  assert.equal(spawned, false);
});

test("supervisor handles asynchronous spawn failure and subsequent close", async () => {
  const worker = child();
  delete worker.pid;
  const result = run("/unused", ["build"], { spawnChild: () => worker });
  worker.emit("error", new Error("executable unavailable"));
  await assert.rejects(result, /executable unavailable/);
  worker.emit("error", new Error("late spawn failure"));
  worker.emit("close", -2, null);
  assert.equal(worker.listenerCount("error"), 0);
  assert.deepEqual(worker.signals, []);
});

test("supervisor reports uncertain cleanup when signalling throws", async () => {
  const worker = child();
  worker.kill = () => {
    throw new Error("signal failed");
  };
  await assert.rejects(
    run("/unused", ["build"], {
      spawnChild: () => worker,
      timeoutMs: 5,
      termWaitMs: 5,
      killWaitMs: 5,
    }),
    (error) => error.uncertain === true,
  );
  worker.emit("close", null, null);
  assert.equal(worker.listenerCount("error"), 0);
});

test("supervisor catches cancellation during spawn and waits for close", async () => {
  const worker = child();
  const controller = new AbortController();
  const result = run("/unused", ["build"], {
    abortSignal: controller.signal,
    spawnChild: () => {
      controller.abort();
      return worker;
    },
  });
  assert.deepEqual(worker.signals, ["SIGTERM"]);
  worker.emit("close", 0, null);
  await assert.rejects(result, /cancelled/);
});

test("supervisor rejects a close after its monotonic deadline", async () => {
  let now = 0;
  const worker = child();
  const result = run("/unused", ["build"], {
    spawnChild: () => worker,
    timeoutMs: 1000,
    now: () => now,
  });
  now = 1000;
  worker.emit("close", 0, null);
  await assert.rejects(result, /timed out after 1000ms/);
});

test("supervisor rejects repeated child errors and keeps listening through close", async () => {
  const worker = child();
  const result = run("/unused", ["build"], { spawnChild: () => worker });
  worker.emit("error", new Error("first failure"));
  worker.emit("error", new Error("second failure"));
  worker.emit("close", 0, null);
  await assert.rejects(result, /first failure/);
  assert.equal(worker.listenerCount("error"), 0);
});

test("supervisor waits for confirmed close after timeout escalation", async () => {
  for (const closingSignal of ["SIGTERM", "SIGKILL"]) {
    const worker = child();
    worker.kill = function kill(signal) {
      this.signals.push(signal);
      if (signal === closingSignal) queueMicrotask(() => this.emit("close", null, signal));
    };
    await assert.rejects(
      run("/unused", ["build"], {
        spawnChild: () => worker,
        timeoutMs: 5,
        termWaitMs: 10,
        killWaitMs: 20,
      }),
      (error) => /timed out/.test(error.message) && !error.uncertain,
    );
    assert.deepEqual(
      worker.signals,
      closingSignal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
    );
  }
});

test("supervisor observes a real failing child close before rejection", async () => {
  let closed = false;
  await assert.rejects(
    run(process.cwd(), ["-e", "process.exit(7)"], {
      spawnChild: (...args) => {
        const worker = spawn(...args);
        worker.once("close", () => {
          closed = true;
        });
        return worker;
      },
    }),
    /exit 7/,
  );
  assert.equal(closed, true);
});

test("supervisor retains error listener after uncertain shutdown until late close", async () => {
  const worker = child();
  const result = run("/unused", ["build"], {
    spawnChild: () => worker,
    timeoutMs: 5,
    termWaitMs: 5,
    killWaitMs: 5,
  });
  await assert.rejects(result, (error) => error.uncertain === true);
  assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
  worker.emit("error", new Error("late failure"));
  worker.emit("error", new Error("another late failure"));
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
});
