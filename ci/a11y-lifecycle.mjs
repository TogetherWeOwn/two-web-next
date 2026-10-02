import { once } from "node:events";

// Only the runner may exit on signals, after fixture cleanup and evidence.
export const AUDIT_BROWSER_OPTIONS = Object.freeze({ handleSIGINT: false, handleSIGTERM: false });

export async function stopChildProcess(child) {
  // A signal-exited child has exitCode=null, but will never emit another exit.
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

// All acquisitions and scratch-writing startup operations pass through this
// owner. Cancellation seals it, drains in-flight work, then disposes in reverse
// order. Signal handlers and finally share the same completion promise.
export function createAuditLifecycle() {
  const pending = new Set();
  const disposers = [];
  let stopping = false;
  let stopped;
  const assertRunning = () => {
    if (stopping) throw new Error("Accessibility audit cancelled");
  };
  const track = (operation, dispose) => {
    assertRunning();
    const work = Promise.resolve()
      .then(() => {
        assertRunning();
        return operation();
      })
      .then((resource) => {
        if (dispose) disposers.push(() => dispose(resource));
        assertRunning();
        return resource;
      });
    pending.add(work);
    // Both branches handle rejection without creating an unhandled promise.
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const stop = () => {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      await Promise.allSettled([...pending]);
      const errors = [];
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          `Audit cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
        );
    })();
    return stopped;
  };
  return { acquire: track, run: (operation) => track(operation), assertRunning, stop };
}
