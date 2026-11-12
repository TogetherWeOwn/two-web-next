// Bound shutdown of the directly spawned Wrangler process. This does not prove
// that its descendants have exited; gallery capture must remain fail-closed.
export function workerShutdown(
  child,
  { graceMs = 5000, schedule = setTimeout, cancel = clearTimeout } = {},
) {
  let timer;
  let stopping = false;
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  child.once("exit", clear);
  child.once("close", clear);
  return () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    timer = schedule(() => {
      timer = undefined;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, graceMs);
    timer.unref?.();
    child.kill("SIGTERM");
  };
}
