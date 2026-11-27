export async function withWorkerCleanup(run, cleanUp) {
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
    console.error("Worker cleanup failed", error);
  }
  if (failure) throw failure.error;
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
