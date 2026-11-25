import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tail } from "./kit-worker-loopback.mjs";

export async function stopWorker(worker) {
  worker.reportPhase?.("stop", "start");
  if (!worker.stopped) {
    worker.child.kill("SIGTERM");
    await Promise.race([worker.closed, delay(5_000, undefined, { ref: false })]);
    if (!worker.stopped) {
      worker.child.kill("SIGKILL");
      await Promise.race([worker.closed, delay(5_000, undefined, { ref: false })]);
    }
  }
  if (worker.stopped) worker.reportPhase?.("stop", "complete");
}

export async function cleanUpWorkers(workers, scratch, failed) {
  await Promise.all(workers.map(stopWorker));
  // Failed bind attempts can be tracked before a phase reporter is attached.
  if (failed) {
    for (const { name, log, reportPhase, suppressFailureLog } of workers) {
      if (!suppressFailureLog && !reportPhase)
        process.stderr.write(`${name} Worker output:\n${tail(log)}\n`);
    }
  }
  assert.ok(
    workers.every(({ stopped }) => stopped),
    "loopback Workers did not stop",
  );
  await rm(scratch, { recursive: true, force: true });
}
