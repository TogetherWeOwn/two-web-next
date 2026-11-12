import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { workerShutdown } from "./kit-worker-shutdown.mjs";

test("shutdown sends SIGTERM once and escalates only while the child is running", () => {
  for (const exits of [true, false]) {
    const signals = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: (signal) => signals.push(signal),
    });
    let escalate;
    let cancelled = false;
    const stop = workerShutdown(child, {
      schedule: (fn, ms) => {
        assert.equal(ms, 5000);
        escalate = fn;
        return {};
      },
      cancel: () => {
        cancelled = true;
      },
    });
    stop();
    stop();
    assert.deepEqual(signals, ["SIGTERM"]);
    if (exits) {
      child.exitCode = 0;
      child.emit("exit", 0);
      assert.equal(cancelled, true);
    }
    escalate();
    assert.deepEqual(signals, exits ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
  }
});

test("a child error does not cancel shutdown escalation before exit", () => {
  const signals = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: (signal) => signals.push(signal),
  });
  let escalate;
  let cancelled = false;
  child.on("error", () => {});
  const stop = workerShutdown(child, {
    schedule: (fn) => {
      escalate = fn;
      return {};
    },
    cancel: () => {
      cancelled = true;
    },
  });
  stop();
  child.emit("error", new Error("signal failed"));
  assert.equal(cancelled, false);
  escalate();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("confirmed close cancels a pending escalation", () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  let cancelled = false;
  const stop = workerShutdown(child, {
    schedule: () => ({}),
    cancel: () => {
      cancelled = true;
    },
  });
  stop();
  child.emit("close", null, "SIGTERM");
  assert.equal(cancelled, true);
});
