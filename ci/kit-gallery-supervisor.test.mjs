import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { stopChild } from "./kit-gallery-supervisor.mjs";

function child(closeOn) {
  return Object.assign(new EventEmitter(), {
    signals: [],
    kill(signal) {
      this.signals.push(signal);
      if (signal === closeOn) this.emit("close", null, signal);
    },
  });
}

test("shutdown waits for close and escalates only when needed", async () => {
  for (const closeOn of ["SIGTERM", "SIGKILL"]) {
    const worker = child(closeOn);
    await stopChild(worker, { termWaitMs: 5, killWaitMs: 5 });
    assert.deepEqual(worker.signals, closeOn === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
    assert.equal(worker.listenerCount("error"), 0);
  }
});

test("unconfirmed shutdown is uncertain and keeps an error listener until close", async () => {
  const worker = child();
  const result = stopChild(worker, { termWaitMs: 5, killWaitMs: 5 });
  worker.emit("error", new Error("signal failed"));
  await assert.rejects(
    result,
    (error) => error.uncertain && error.cause.message === "signal failed",
  );
  assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
  worker.emit("error", new Error("late failure"));
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
});

test("thrown signals cannot be mistaken for confirmed exit", async () => {
  const worker = child();
  worker.kill = () => {
    throw new Error("signal threw");
  };
  await assert.rejects(
    stopChild(worker, { termWaitMs: 5, killWaitMs: 5 }),
    (error) => error.uncertain && error.cause.message === "signal threw",
  );
  worker.emit("close", null, null);
});

test("shutdown observes a real direct child's close", async () => {
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await once(worker, "spawn");
  let closed = false;
  worker.once("close", () => {
    closed = true;
  });
  await stopChild(worker);
  assert.equal(closed, true);
});
