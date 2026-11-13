import { spawn } from "node:child_process";

// Aggregate ceiling for all build subprocesses together, plus bounded waits for
// the direct child to exit after SIGTERM and after SIGKILL. Only the direct child
// is supervised; descendants it may have spawned are not tracked or signalled.
export const BUILD_TIMEOUT_MS = 4 * 60 * 1000;
export const TERM_WAIT_MS = 5000;
export const KILL_WAIT_MS = 2000;

// An error with `uncertain` set means the direct child may still be running; the
// caller must not remove or reuse the overlay root.
function uncertainError(message) {
  return Object.assign(new Error(message), { uncertain: true });
}

export function run(
  cwd,
  args,
  {
    env = process.env,
    timeoutMs = BUILD_TIMEOUT_MS,
    termWaitMs = TERM_WAIT_MS,
    killWaitMs = KILL_WAIT_MS,
    spawnChild = spawn,
    now = () => performance.now(),
    abortSignal,
    executable = process.execPath,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const label = `kit-gallery-overlay: ${args.join(" ")}`;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error(`${label} has no remaining build time`));
      return;
    }
    if (abortSignal?.aborted) {
      reject(new Error(`${label} cancelled before spawn`));
      return;
    }
    const deadline = now() + timeoutMs;
    let settled = false;
    let exited = false;
    let stopReason;
    let childError;
    const timers = new Set();
    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise();
    };
    let child;
    try {
      child = spawnChild(executable, args, { cwd, env, stdio: "inherit" });
    } catch (error) {
      settle(new Error(`${label} failed to start: ${error.message}`));
      return;
    }
    const signal = (name) => {
      try {
        child.kill(name);
      } catch {
        // Exit is confirmed only by the close event; a failed signal is uncertain.
      }
    };
    function onError(error) {
      // Keep listening until close, including after uncertain shutdown.
      if (!exited && child.pid !== undefined) {
        childError ??= error;
        return;
      }
      if (!exited) settle(new Error(`${label} failed: ${error.message}`));
    }
    child.on("error", onError);
    child.once("close", (code, sig) => {
      exited = true;
      child.removeListener("error", onError);
      // A busy event loop may deliver close before an overdue timeout callback.
      if (stopReason) settle(new Error(`${label} ${stopReason}`));
      else if (now() >= deadline) settle(new Error(`${label} timed out after ${timeoutMs}ms`));
      else if (childError) settle(new Error(`${label} failed: ${childError.message}`));
      else if (code === 0) settle();
      else settle(new Error(`${label} failed${sig ? ` (${sig})` : ` (exit ${code})`}`));
    });
    function stop(reason) {
      if (exited || settled || stopReason) return;
      stopReason = reason;
      signal("SIGTERM");
      if (exited || settled) return;
      later(() => {
        if (exited) return;
        signal("SIGKILL");
        if (exited || settled) return;
        later(() => {
          if (!exited)
            settle(uncertainError(`${label} ${reason} and the direct child did not confirm exit`));
        }, killWaitMs);
      }, termWaitMs);
    }
    function onAbort() {
      stop("cancelled");
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    if (!settled && !stopReason)
      later(() => stop(`timed out after ${timeoutMs}ms`), Math.max(0, timeoutMs));
  });
}
