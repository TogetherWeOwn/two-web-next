import { spawn } from "node:child_process";

const maxOutput = 64 * 1024;

// A truncated or undrained stream is never complete evidence, even if the child exits zero.
export function runCli(binary, args, { timeoutMs, drainMs = 500 } = {}) {
  return new Promise((resolve) => {
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let code = null;
    let exited = false;
    let drainTimer;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const finish = (drained) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        code,
        timedOut,
        drained: drained && !truncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (!exited) setTimeout(() => finish(false), 1000).unref();
    }, timeoutMs);
    const collect = (stream, chunk) => {
      const remaining = maxOutput - sizes[stream];
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        output[stream].push(kept);
        sizes[stream] += kept.length;
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      collect("stderr", Buffer.from(error.message));
      finish(false);
    });
    child.on("exit", (exitCode) => {
      code = exitCode;
      exited = true;
      drainTimer = setTimeout(() => finish(false), drainMs);
    });
    child.on("close", () => finish(true));
  });
}
