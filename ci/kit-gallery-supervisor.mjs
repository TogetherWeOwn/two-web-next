// This helper supervises only the direct child, not any descendants. Install it
// before the child can emit close; callers must not reuse or remove an overlay
// when shutdown reports an uncertain result.
export function stopChild(child, { termWaitMs = 5000, killWaitMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let timer;
    let signalError;

    function onError(error) {
      signalError ??= error;
    }
    function onClose() {
      closed = true;
      child.removeListener("error", onError);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    function signal(name) {
      try {
        child.kill(name);
      } catch (error) {
        signalError ??= error;
      }
    }

    child.on("error", onError);
    child.once("close", onClose);
    signal("SIGTERM");
    if (closed) return;
    timer = setTimeout(() => {
      signal("SIGKILL");
      if (closed) return;
      timer = setTimeout(() => {
        settled = true;
        reject(
          Object.assign(new Error("direct child did not confirm exit", { cause: signalError }), {
            uncertain: true,
          }),
        );
      }, killWaitMs);
    }, termWaitMs);
  });
}
