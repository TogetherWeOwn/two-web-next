import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tail } from "../kit-worker-loopback.mjs";

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
  // Redact output for all rollback attempts, including collisions retried without markers.
  if (failed) {
    for (const { name, log, suppressFailureLog } of workers) {
      if (!suppressFailureLog) process.stderr.write(`${name} Worker output:\n${tail(log)}\n`);
    }
  }
  assert.ok(
    workers.every(({ stopped }) => stopped),
    "loopback Workers did not stop",
  );
  await rm(scratch, { recursive: true, force: true });
}

export async function withFixtureCleanup(run, cleanUp, reportCleanupFailure) {
  let failure;
  try {
    await run();
  } catch (error) {
    failure = { error };
  }
  try {
    await cleanUp(failure !== undefined);
  } catch (error) {
    if (!failure) throw error;
    reportCleanupFailure(error);
  }
  if (failure) throw failure.error;
}

export function withWorkerCleanup(run, cleanUp) {
  return withFixtureCleanup(run, cleanUp, (error) => console.error("Worker cleanup failed", error));
}

export async function withPublicVoiceBrowserWorkers({
  startOff,
  startEnabled,
  waitForWorker,
  verify,
  stopWorker,
}) {
  const workers = [];
  await withWorkerCleanup(
    async () => {
      for (const start of [startOff, startEnabled]) {
        const worker = await start();
        // Track allocation before readiness can fail.
        workers.push(worker);
        await waitForWorker(worker);
      }
      const [off, enabled] = workers;
      await verify(off.origin, enabled.origin);
    },
    async () => {
      const stops = await Promise.allSettled(workers.map(async (worker) => stopWorker(worker)));
      const unconfirmed = workers.filter(
        (worker, index) => stops[index].status === "rejected" || !worker.stopped,
      );
      if (unconfirmed.length) {
        const names = unconfirmed.map(({ name }) => name).join(", ");
        throw new Error(`Could not confirm closure of public voice browser Workers (${names})`);
      }
    },
  );
}
