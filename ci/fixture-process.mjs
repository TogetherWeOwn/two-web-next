import { spawn } from "node:child_process";

// A caller must retain its scratch directory when retainFixture is true. A
// process group cannot contain a descendant that deliberately creates a new
// session; inherited pipes are the evidence of that escape, not a sandbox.
export function runFixtureCommand(
  command,
  args,
  { cwd, env, timeoutMs = 10 * 60 * 1000, cleanupMs = 5000, signalGroup = process.kill },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let signalError;
    let cleanupTimer;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (error) reject(error);
      else resolve();
    };
    const uncertain = (message, cause) => {
      const error = new Error(`${message}; retained ${cwd}`, { cause });
      error.retainFixture = true;
      return error;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) signalGroup(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") signalError = error;
      }
      cleanupTimer = setTimeout(() => {
        finish(uncertain("Fixture process cleanup exceeded bound", signalError));
        child.stdout?.unpipe(process.stdout);
        child.stderr?.unpipe(process.stderr);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }, cleanupMs);
    }, timeoutMs);
    child.on("error", (error) =>
      finish(timedOut ? uncertain("Fixture process cleanup failed", error) : error),
    );
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
    child.on("close", (code, signal) => {
      if (signalError) finish(uncertain("Fixture process signal failed", signalError));
      else if (timedOut) finish(uncertain("Fixture process timed out", undefined));
      else {
        try {
          if (child.pid) process.kill(-child.pid, 0);
          if (child.pid) {
            try {
              signalGroup(-child.pid, "SIGKILL");
            } catch (error) {
              return finish(uncertain("Fixture process signal failed", error));
            }
            return finish(uncertain("Fixture process group still exists", undefined));
          }
        } catch (error) {
          if (error.code !== "ESRCH")
            return finish(uncertain("Fixture process group check failed", error));
        }
        if (code !== 0 || signal) finish(new Error("Fixture process failed"));
        else finish();
      }
    });
  });
}
